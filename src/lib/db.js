import householdsInitial from '../data/households.json';
import protocolsInitial from '../data/protocols.json';

const DB_NAME = 'sahaaya_health_db';
const DB_VERSION = 2;

let dbInstance = null;

export function closeDB() {
  if (dbInstance) {
    try {
      if (typeof dbInstance.close === 'function') {
        dbInstance.close();
      }
    } catch (_e) {
      // ignore
    }
    dbInstance = null;
  }
}

export function openDB() {
  if (dbInstance) return Promise.resolve(dbInstance);

  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      return reject(new Error('IndexedDB not supported'));
    }

    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (event) => {
      const db = event.target.result;

      if (!db.objectStoreNames.contains('households')) {
        db.createObjectStore('households', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('protocols')) {
        db.createObjectStore('protocols', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('syncQueue')) {
        db.createObjectStore('syncQueue', { keyPath: 'queueId', autoIncrement: true });
      }
      if (!db.objectStoreNames.contains('metadata')) {
        db.createObjectStore('metadata', { keyPath: 'key' });
      }
      if (!db.objectStoreNames.contains('eventLog')) {
        db.createObjectStore('eventLog', { keyPath: 'eventId', autoIncrement: true });
      }
    };

    request.onsuccess = async (event) => {
      dbInstance = event.target.result;
      try {
        await seedIfFirstLaunch(dbInstance);
        resolve(dbInstance);
      } catch (err) {
        console.error('Error during database seed check:', err);
        resolve(dbInstance);
      }
    };

    request.onerror = (event) => {
      console.error('IndexedDB open error:', event.target.error);
      reject(event.target.error);
    };
  });
}

async function seedIfFirstLaunch(db) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(['metadata', 'households', 'protocols'], 'readwrite');
    const metaStore = tx.objectStore('metadata');
    const getReq = metaStore.get('db_seeded');

    getReq.onsuccess = () => {
      if (getReq.result && getReq.result.value === true) {
        // Already seeded on previous launch! Do NOT overwrite user modifications.
        return resolve();
      }

      // First launch: seed bundled data
      const householdStore = tx.objectStore('households');
      householdsInitial.forEach(item => householdStore.put(item));

      const protocolStore = tx.objectStore('protocols');
      protocolsInitial.forEach(item => protocolStore.put(item));

      metaStore.put({ key: 'db_seeded', value: true, seededAt: new Date().toISOString(), version: DB_VERSION });
      metaStore.put({ key: 'last_sync_time', value: new Date().toISOString() });
    };

    tx.oncomplete = () => resolve();
    tx.onerror = (e) => reject(e.target.error);
  });
}

export async function getHouseholds() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('households', 'readonly');
    const store = tx.objectStore('households');
    const req = store.getAll();
    req.onsuccess = () => resolve(req.result || householdsInitial);
    req.onerror = () => reject(req.error);
  });
}

export async function completeVisitRecord(household, idempotencyKey) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(['households', 'syncQueue', 'eventLog'], 'readwrite');
    const hStore = tx.objectStore('households');
    const qStore = tx.objectStore('syncQueue');
    const eStore = tx.objectStore('eventLog');
    let resolvedResult = null;

    const getReq = hStore.get(household.id);
    getReq.onsuccess = () => {
      const existing = getReq.result;
      // Idempotency check: if record is already completed in DB, avoid duplicating syncQueue/eventLog
      if (existing && existing.patient?.isCompleted === true && existing.patient?.status === 'Completed Today') {
        resolvedResult = existing;
        return;
      }

      const completedAt = household.patient?.completedAt || new Date().toISOString();
      const originalStatus = existing?.patient?.originalStatus || household.patient?.originalStatus || existing?.patient?.status || household.patient?.status || 'Scheduled';

      const updatedPatient = {
        ...household.patient,
        originalStatus: originalStatus === 'Completed Today' ? 'Scheduled' : originalStatus,
        status: 'Completed Today',
        isCompleted: true,
        completedAt
      };

      const updatedHousehold = {
        ...(existing || household),
        ...household,
        patient: updatedPatient
      };

      hStore.put(updatedHousehold);
      resolvedResult = updatedHousehold;

      const key = idempotencyKey || `complete_${household.id}_${completedAt}`;

      // Add to syncQueue
      qStore.add({
        action: 'UPDATE_HOUSEHOLD',
        queueType: 'COMPLETE',
        idempotencyKey: key,
        timestamp: completedAt,
        householdId: household.id,
        patientName: household.patient?.name,
        status: 'Completed Today',
        category: household.patient?.category
      });

      // Append to eventLog
      eStore.add({
        type: 'COMPLETED',
        idempotencyKey: key,
        householdId: household.id,
        patientName: household.patient?.name,
        timestamp: completedAt
      });
    };
    getReq.onerror = () => reject(getReq.error);

    tx.oncomplete = () => resolve(resolvedResult || household);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('Transaction aborted'));
  });
}

export async function undoVisitRecord(household, idempotencyKey) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(['households', 'syncQueue', 'eventLog'], 'readwrite');
    const hStore = tx.objectStore('households');
    const qStore = tx.objectStore('syncQueue');
    const eStore = tx.objectStore('eventLog');
    let resolvedResult = null;

    const getReq = hStore.get(household.id);
    getReq.onsuccess = () => {
      const existing = getReq.result;
      // Idempotency check: if already pending/not completed in DB, avoid duplicating undo event
      if (existing && existing.patient?.isCompleted === false && existing.patient?.status !== 'Completed Today') {
        resolvedResult = existing;
        return;
      }

      const undoneAt = new Date().toISOString();
      const restoredStatus = existing?.patient?.originalStatus || household.patient?.originalStatus || 'Scheduled';
      const restoredPatient = {
        ...(existing?.patient || household.patient),
        status: restoredStatus === 'Completed Today' ? 'Scheduled' : restoredStatus,
        isCompleted: false,
        completedAt: null
      };

      const updatedHousehold = {
        ...(existing || household),
        ...household,
        patient: restoredPatient
      };

      hStore.put(updatedHousehold);
      resolvedResult = updatedHousehold;

      const key = idempotencyKey || `undo_${household.id}_${undoneAt}`;

      // Sync queue cancellation / reversal
      const getAllReq = qStore.getAll();
      getAllReq.onsuccess = () => {
        const items = getAllReq.result || [];
        const pendingIndex = items.findIndex(
          it => it.householdId === household.id && (it.queueType === 'COMPLETE' || it.status === 'Completed Today')
        );

        if (pendingIndex >= 0) {
          // Still pending in local queue: cancel/delete it
          qStore.delete(items[pendingIndex].queueId);
        } else {
          // Was already synced or absent: enqueue reversal
          qStore.add({
            action: 'REVERSE_HOUSEHOLD',
            queueType: 'REVERSAL',
            idempotencyKey: key,
            timestamp: undoneAt,
            householdId: household.id,
            patientName: household.patient?.name,
            status: restoredPatient.status,
            category: household.patient?.category
          });
        }
      };

      // Append to eventLog
      eStore.add({
        type: 'UNDONE',
        idempotencyKey: key,
        householdId: household.id,
        patientName: household.patient?.name,
        timestamp: undoneAt
      });
    };
    getReq.onerror = () => reject(getReq.error);

    tx.oncomplete = () => resolve(resolvedResult || household);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('Transaction aborted'));
  });
}

export async function updateHousehold(household) {
  // If this update is completing a visit, delegate to completeVisitRecord
  if (household.patient?.isCompleted || household.patient?.status === 'Completed Today') {
    return completeVisitRecord(household);
  } else {
    // Check if it's an undo of a previously completed visit
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('households', 'readonly');
      const store = tx.objectStore('households');
      const getReq = store.get(household.id);
      getReq.onsuccess = async () => {
        const prev = getReq.result;
        if (prev?.patient?.isCompleted) {
          try {
            const res = await undoVisitRecord(household);
            resolve(res);
          } catch (e) {
            reject(e);
          }
        } else {
          // Standard household record put
          const writeTx = db.transaction('households', 'readwrite');
          writeTx.objectStore('households').put(household);
          writeTx.oncomplete = () => resolve(household);
          writeTx.onerror = () => reject(writeTx.error);
        }
      };
      getReq.onerror = () => reject(getReq.error);
    });
  }
}

export async function getEventLog() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('eventLog', 'readonly');
    const store = tx.objectStore('eventLog');
    const req = store.getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

export async function resetDemoData() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(['households', 'syncQueue', 'eventLog', 'metadata'], 'readwrite');
    const hStore = tx.objectStore('households');
    const qStore = tx.objectStore('syncQueue');
    const eStore = tx.objectStore('eventLog');
    const mStore = tx.objectStore('metadata');

    const req = hStore.getAll();
    req.onsuccess = () => {
      const list = req.result || [];
      list.forEach(h => {
        if (h.patient) {
          hStore.put({
            ...h,
            patient: {
              ...h.patient,
              status: h.patient.originalStatus || 'Scheduled',
              isCompleted: false,
              completedAt: null
            }
          });
        }
      });
    };

    qStore.clear();
    eStore.clear();
    mStore.put({ key: 'last_sync_time', value: new Date().toISOString() });

    tx.oncomplete = () => resolve({ success: true });
    tx.onerror = () => reject(tx.error);
  });
}

export async function exportLocalBackup() {
  const households = await getHouseholds();
  const protocols = await getProtocols();
  const syncQueue = await getSyncQueue();
  const eventLog = await getEventLog();
  const lastSync = await getLastSyncTime();

  return {
    app: "Sahaaya Health",
    appName: "Sahaaya Health",
    version: "1.0.0",
    exportedAt: new Date().toISOString(),
    exportTimestamp: new Date().toISOString(),
    worker: {
      name: "Sunitha Devi",
      role: "ASHA Worker",
      facility: "Kothavalasa PHC, Visakhapatnam Rural",
      cluster: ["Chinnaipalem", "Gollalapalem", "Ramabhadrapuram"]
    },
    metadata: {
      totalHouseholds: households.length,
      pendingSyncCount: syncQueue.length,
      totalEventsLogged: eventLog.length,
      lastSyncTime: lastSync
    },
    households,
    syncQueue,
    eventLog,
    protocolsSummary: {
      count: protocols.length,
      type: "SAMPLE Protocols (MCH, IMNCI, NCD, Immunization)"
    }
  };
}

export async function removeSyncQueueItems(queueIds = []) {
  if (!queueIds || queueIds.length === 0) return true;
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(['syncQueue', 'metadata'], 'readwrite');
    const qStore = tx.objectStore('syncQueue');
    const mStore = tx.objectStore('metadata');

    queueIds.forEach(id => {
      qStore.delete(id);
    });

    mStore.put({ key: 'last_sync_time', value: new Date().toISOString() });

    tx.oncomplete = () => resolve(true);
    tx.onerror = () => reject(tx.error);
  });
}

export async function getProtocols() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('protocols', 'readonly');
    const store = tx.objectStore('protocols');
    const req = store.getAll();
    req.onsuccess = () => resolve(req.result || protocolsInitial);
    req.onerror = () => reject(req.error);
  });
}

export async function getSyncQueue() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('syncQueue', 'readonly');
    const store = tx.objectStore('syncQueue');
    const req = store.getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

export async function addToSyncQueue(action, payload) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('syncQueue', 'readwrite');
    const store = tx.objectStore('syncQueue');
    store.add({
      action,
      payload,
      timestamp: new Date().toISOString()
    });
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => reject(tx.error);
  });
}

export async function clearSyncQueue() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(['syncQueue', 'metadata'], 'readwrite');
    const qStore = tx.objectStore('syncQueue');
    const mStore = tx.objectStore('metadata');

    qStore.clear();
    mStore.put({ key: 'last_sync_time', value: new Date().toISOString() });

    tx.oncomplete = () => resolve(true);
    tx.onerror = () => reject(tx.error);
  });
}

export async function getLastSyncTime() {
  try {
    const db = await openDB();
    return new Promise((resolve) => {
      const tx = db.transaction('metadata', 'readonly');
      const store = tx.objectStore('metadata');
      const req = store.get('last_sync_time');
      req.onsuccess = () => resolve(req.result?.value || null);
      req.onerror = () => resolve(null);
    });
  } catch (_e) {
    return null;
  }
}

export async function setLastSyncTime(isoString = new Date().toISOString()) {
  try {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('metadata', 'readwrite');
      const store = tx.objectStore('metadata');
      store.put({ key: 'last_sync_time', value: isoString });
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => reject(tx.error);
    });
  } catch (_e) {
    return false;
  }
}

export async function getDatabaseStats() {
  try {
    const households = await getHouseholds();
    const protocols = await getProtocols();
    const syncQueue = await getSyncQueue();

    return {
      householdCount: households.length,
      protocolCount: protocols.length,
      pendingSyncCount: syncQueue.length,
      modelStatus: "CPU Rule Engine / In-browser BM25 (SLM: Inactive)",
      storageType: "IndexedDB (sahaaya_health_db)"
    };
  } catch (_err) {
    return {
      householdCount: householdsInitial.length,
      protocolCount: protocolsInitial.length,
      pendingSyncCount: 0,
      modelStatus: "CPU Rule Engine / In-browser BM25 (Memory fallback)",
      storageType: "Bundled JSON Fallback"
    };
  }
}
