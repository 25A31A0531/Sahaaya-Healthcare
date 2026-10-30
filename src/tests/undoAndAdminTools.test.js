import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import translations from '../data/translations.json';
import { 
  computeDailyStats, 
  computeCategoryCounts
} from '../lib/visitPlanner';
import { 
  openDB, 
  closeDB, 
  getHouseholds, 
  completeVisitRecord,
  undoVisitRecord,
  getSyncQueue, 
  clearSyncQueue,
  getEventLog,
  resetDemoData,
  exportLocalBackup
} from '../lib/db';

/**
 * Lightweight in-memory IndexedDB polyfill for Node.js Vitest environment
 */
function createInMemoryIDB() {
  const databases = new Map();

  return {
    open(dbName, version) {
      const req = {
        onsuccess: null,
        onerror: null,
        onupgradeneeded: null,
        result: null
      };

      setTimeout(() => {
        let dbData = databases.get(dbName);
        let isUpgradeNeeded = false;
        if (!dbData) {
          dbData = {
            version,
            stores: new Map()
          };
          databases.set(dbName, dbData);
          isUpgradeNeeded = true;
        }

        const db = {
          name: dbName,
          version,
          objectStoreNames: {
            contains(storeName) {
              return dbData.stores.has(storeName);
            }
          },
          createObjectStore(storeName, options = {}) {
            if (!dbData.stores.has(storeName)) {
              dbData.stores.set(storeName, {
                options,
                records: new Map(),
                autoId: 1
              });
            }
            return {};
          },
          transaction(_storeNames, mode) {
            let pendingRequests = 0;
            let isCommitted = false;

            const checkComplete = () => {
              if (pendingRequests === 0 && !isCommitted) {
                isCommitted = true;
                setTimeout(() => {
                  if (tx.oncomplete) tx.oncomplete();
                }, 0);
              }
            };

            const tx = {
              mode,
              oncomplete: null,
              onerror: null,
              onabort: null,
              error: null,
              objectStore(name) {
                const store = dbData.stores.get(name);
                if (!store) throw new Error(`Object store ${name} not found`);

                return {
                  put(item) {
                    pendingRequests++;
                    const keyPath = store.options.keyPath;
                    let key = item[keyPath];
                    if (key === undefined && store.options.autoIncrement) {
                      key = store.autoId++;
                      item[keyPath] = key;
                    }
                    store.records.set(key, JSON.parse(JSON.stringify(item)));
                    const r = { onsuccess: null, onerror: null, result: key };
                    setTimeout(() => {
                      if (r.onsuccess) r.onsuccess({ target: r });
                      pendingRequests--;
                      checkComplete();
                    }, 0);
                    return r;
                  },
                  add(item) {
                    return this.put(item);
                  },
                  get(key) {
                    pendingRequests++;
                    const r = { onsuccess: null, onerror: null, result: null };
                    setTimeout(() => {
                      const item = store.records.get(key);
                      r.result = item ? JSON.parse(JSON.stringify(item)) : undefined;
                      if (r.onsuccess) r.onsuccess({ target: r });
                      pendingRequests--;
                      checkComplete();
                    }, 0);
                    return r;
                  },
                  getAll() {
                    pendingRequests++;
                    const r = { onsuccess: null, onerror: null, result: [] };
                    setTimeout(() => {
                      r.result = Array.from(store.records.values()).map(v => JSON.parse(JSON.stringify(v)));
                      if (r.onsuccess) r.onsuccess({ target: r });
                      pendingRequests--;
                      checkComplete();
                    }, 0);
                    return r;
                  },
                  delete(key) {
                    pendingRequests++;
                    store.records.delete(key);
                    const r = { onsuccess: null, onerror: null };
                    setTimeout(() => {
                      if (r.onsuccess) r.onsuccess({ target: r });
                      pendingRequests--;
                      checkComplete();
                    }, 0);
                    return r;
                  },
                  clear() {
                    pendingRequests++;
                    store.records.clear();
                    const r = { onsuccess: null, onerror: null };
                    setTimeout(() => {
                      if (r.onsuccess) r.onsuccess({ target: r });
                      pendingRequests--;
                      checkComplete();
                    }, 0);
                    return r;
                  }
                };
              }
            };

            // If no requests were made immediately, trigger checkComplete on next tick
            setTimeout(checkComplete, 5);

            return tx;
          },
          close() {}
        };

        req.result = db;

        if (isUpgradeNeeded && req.onupgradeneeded) {
          req.onupgradeneeded({ target: req });
        }
        if (req.onsuccess) {
          req.onsuccess({ target: req });
        }
      }, 0);

      return req;
    }
  };
}

describe('Sahaaya Health — Undo Visit, Sync Cancellation & Admin Tools', () => {
  let originalIDB;

  beforeEach(() => {
    originalIDB = globalThis.indexedDB;
    globalThis.indexedDB = createInMemoryIDB();
    closeDB();
  });

  afterEach(() => {
    closeDB();
    globalThis.indexedDB = originalIDB;
  });

  it('1. Complete visit and Undo visit maintains strict count invariant', async () => {
    await openDB();
    const initial = await getHouseholds();
    expect(initial.length).toBe(30);

    const counts0 = computeCategoryCounts(initial);
    expect(counts0.all.pending).toBe(30);
    expect(counts0.all.completed).toBe(0);
    expect(counts0.all.pending + counts0.all.completed).toBe(counts0.all.total);

    // Complete the first visit
    const target = initial[0];
    const completed = await completeVisitRecord(target);
    expect(completed.patient.isCompleted).toBe(true);
    expect(completed.patient.status).toBe('Completed Today');

    const afterComplete = await getHouseholds();
    const counts1 = computeCategoryCounts(afterComplete);
    expect(counts1.all.pending).toBe(29);
    expect(counts1.all.completed).toBe(1);
    expect(counts1.all.pending + counts1.all.completed).toBe(counts1.all.total);

    // Undo the completed visit
    const undone = await undoVisitRecord(completed);
    expect(undone.patient.isCompleted).toBe(false);
    expect(undone.patient.status).not.toBe('Completed Today');

    const afterUndo = await getHouseholds();
    const counts2 = computeCategoryCounts(afterUndo);
    expect(counts2.all.pending).toBe(30);
    expect(counts2.all.completed).toBe(0);
    expect(counts2.all.pending + counts2.all.completed).toBe(counts2.all.total);
    expect(afterUndo.length).toBe(30);
  });

  it('2. Idempotency: Double-complete does not duplicate queue entries or event logs', async () => {
    await openDB();
    const initial = await getHouseholds();
    const target = initial[0];

    // Complete twice with the same idempotency key
    await completeVisitRecord(target, 'idemp_key_1');
    await completeVisitRecord(target, 'idemp_key_1');

    const queue = await getSyncQueue();
    const queueForTarget = queue.filter(q => q.householdId === target.id);
    expect(queueForTarget.length).toBe(1);

    const logs = await getEventLog();
    const logsForTarget = logs.filter(l => l.householdId === target.id && l.type === 'COMPLETED');
    expect(logsForTarget.length).toBe(1);
  });

  it('3. Queue Cancellation on Undo: Cancels pending queue item if not yet synced', async () => {
    await openDB();
    const initial = await getHouseholds();
    const target = initial[1];

    // Complete
    const completed = await completeVisitRecord(target);
    const queueBefore = await getSyncQueue();
    expect(queueBefore.some(q => q.householdId === target.id)).toBe(true);

    // Undo while still queued locally
    await undoVisitRecord(completed);
    const queueAfter = await getSyncQueue();
    // Complete item was removed and no redundant reversal needed
    const pendingComplete = queueAfter.find(q => q.householdId === target.id && q.queueType === 'COMPLETE');
    expect(pendingComplete).toBeUndefined();
  });

  it('4. Queue Reversal on Undo: Enqueues REVERSE_HOUSEHOLD if already synced', async () => {
    await openDB();
    const initial = await getHouseholds();
    const target = initial[2];

    // Complete
    const completed = await completeVisitRecord(target);
    // Simulate sync success by clearing queue
    await clearSyncQueue();
    const queueEmpty = await getSyncQueue();
    expect(queueEmpty.length).toBe(0);

    // Now undo after it was already "synced"
    await undoVisitRecord(completed);
    const queueAfterUndo = await getSyncQueue();
    expect(queueAfterUndo.length).toBe(1);
    expect(queueAfterUndo[0].action).toBe('REVERSE_HOUSEHOLD');
    expect(queueAfterUndo[0].householdId).toBe(target.id);
  });

  it('5. Event Log: records COMPLETED and UNDONE events with timestamps', async () => {
    await openDB();
    const initial = await getHouseholds();
    const target = initial[3];

    const completed = await completeVisitRecord(target);
    await undoVisitRecord(completed);

    const logs = await getEventLog();
    expect(logs.length).toBeGreaterThanOrEqual(2);

    const compEvent = logs.find(l => l.householdId === target.id && l.type === 'COMPLETED');
    const undoEvent = logs.find(l => l.householdId === target.id && l.type === 'UNDONE');

    expect(compEvent).toBeDefined();
    expect(compEvent.patientName).toBe(target.patient.name);
    expect(compEvent.timestamp).toBeDefined();

    expect(undoEvent).toBeDefined();
    expect(undoEvent.patientName).toBe(target.patient.name);
    expect(undoEvent.timestamp).toBeDefined();
  });

  it('6. Reset Demo Data: resets all visits to pending, clears queue & event log without changing households', async () => {
    await openDB();
    const initial = await getHouseholds();

    // Mark 3 visits as completed
    await completeVisitRecord(initial[0]);
    await completeVisitRecord(initial[1]);
    await completeVisitRecord(initial[2]);

    const beforeReset = await getHouseholds();
    const statsBefore = computeDailyStats(beforeReset);
    expect(statsBefore.completedVisits).toBe(3);
    expect(statsBefore.scheduledVisits).toBe(27);

    // Call resetDemoData
    const resetResult = await resetDemoData();
    expect(resetResult.success).toBe(true);

    const afterReset = await getHouseholds();
    expect(afterReset.length).toBe(30);

    const statsAfter = computeDailyStats(afterReset);
    expect(statsAfter.completedVisits).toBe(0);
    expect(statsAfter.scheduledVisits).toBe(30);

    const queue = await getSyncQueue();
    expect(queue.length).toBe(0);

    const eventLog = await getEventLog();
    expect(eventLog.length).toBe(0);
  });

  it('7. Export Backup: exports complete data snapshot as JSON structure', async () => {
    await openDB();
    const initial = await getHouseholds();
    await completeVisitRecord(initial[0]);

    const backup = await exportLocalBackup();
    expect(backup.app).toBe('Sahaaya Health');
    expect(backup.households.length).toBe(30);
    expect(backup.syncQueue.length).toBeGreaterThanOrEqual(1);
    expect(backup.eventLog.length).toBeGreaterThanOrEqual(1);
    expect(backup.exportedAt).toBeDefined();
  });

  it('8. Bilingual Translations: Every newly added key exists in both EN and TE', () => {
    const requiredKeys = [
      'undo_action',
      'undo_confirm_title',
      'undo_confirm_desc',
      'confirm',
      'cancel',
      'visit_completed_toast',
      'visit_undone_toast',
      'completed_today_stat',
      'stat_sub_completed',
      'reset_demo_title',
      'reset_demo_desc',
      'reset_demo_confirm',
      'reset_success',
      'referral_slip_title',
      'copy_referral',
      'share_referral',
      'slip_copied',
      'backup_export_title',
      'backup_export_desc',
      'export_backup_button',
      'backup_exported',
      'p50_latency_label',
      'p95_latency_label',
      'event_log_title',
      'event_log_desc'
    ];

    expect(translations.en).toBeDefined();
    expect(translations.te).toBeDefined();

    for (const key of requiredKeys) {
      expect(translations.en[key], `Missing English key: ${key}`).toBeDefined();
      expect(translations.en[key].length, `Empty English value: ${key}`).toBeGreaterThan(0);
      expect(translations.te[key], `Missing Telugu key: ${key}`).toBeDefined();
      expect(translations.te[key].length, `Empty Telugu value: ${key}`).toBeGreaterThan(0);
    }
  });
});
