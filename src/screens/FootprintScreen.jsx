import React, { useState, useEffect } from 'react';
import { 
  Cpu, 
  HardDrive, 
  Zap, 
  ShieldCheck, 
  Layers,
  RotateCcw,
  Download,
  AlertCircle
} from 'lucide-react';
import { getTelemetry } from '../lib/clinicalEngine';
import { resetDemoData, exportLocalBackup } from '../lib/db';
import { showAppToast } from '../lib/pwa';
import { useLanguage } from '../context/LanguageContext';
import DisclaimerBanner from '../components/DisclaimerBanner';

export default function FootprintScreen() {
  const { t } = useLanguage();
  const [telemetry, setTelemetry] = useState(getTelemetry());
  const [heapMemory, setHeapMemory] = useState(null);
  const [showResetConfirm, setShowResetConfirm] = useState(false);
  const [isResetting, setIsResetting] = useState(false);

  useEffect(() => {
    setTelemetry(getTelemetry());

    if (typeof performance !== 'undefined' && performance.memory) {
      const usedMB = (performance.memory.usedJSHeapSize / (1024 * 1024)).toFixed(1);
      const totalMB = (performance.memory.totalJSHeapSize / (1024 * 1024)).toFixed(1);
      setHeapMemory(`${usedMB} MB / ${totalMB} MB`);
    } else {
      setHeapMemory("Browser sandbox (heap unexposed)");
    }
  }, []);

  const handleReset = async () => {
    setIsResetting(true);
    try {
      await resetDemoData();
      setShowResetConfirm(false);
      showAppToast({
        type: 'success',
        message: t('reset_success'),
        duration: 4000
      });
      setTimeout(() => {
        if (typeof window !== 'undefined') window.location.reload();
      }, 700);
    } catch (e) {
      console.error('Reset error:', e);
    } finally {
      setIsResetting(false);
    }
  };

  const handleExportBackup = async () => {
    try {
      const data = await exportLocalBackup();
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `sahaaya_backup_${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      showAppToast({
        type: 'success',
        message: t('backup_exported'),
        duration: 4000
      });
    } catch (e) {
      console.error('Export error:', e);
    }
  };

  return (
    <div className="space-y-4 pb-20 md:pb-6">
      {/* Title */}
      <div className="bg-white p-4 rounded-2xl border border-gray-200 shadow-sm">
        <h2 className="text-lg font-bold text-gray-900 leading-tight">
          {t('footprint_title')}
        </h2>
        <p className="text-xs text-gray-600 mt-0.5">
          {t('footprint_desc')}
        </p>

        <div className="mt-3 inline-flex items-center gap-1.5 px-3 py-1 bg-emerald-50 text-emerald-900 rounded-full text-xs font-bold border border-emerald-200">
          <ShieldCheck className="w-4 h-4 text-emerald-600" />
          <span>{t('cpu_only_badge')}</span>
        </div>
      </div>

      {/* Metrics Cards Grid (Responsive: 1 col on mobile, 2 cols on tablet/desktop) */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3.5">
        {/* Card 1: App Size */}
        <div className="p-4 bg-white rounded-2xl border border-gray-200 shadow-sm flex flex-col justify-between">
          <div>
            <div className="flex items-center justify-between">
              <span className="text-xs font-bold text-gray-600">{t('app_size_label')}</span>
              <div className="p-1.5 bg-blue-50 text-blue-600 rounded-lg">
                <Layers className="w-4 h-4" />
              </div>
            </div>
            <p className="text-2xl font-black text-gray-900 mt-2">
              ~394 KB <span className="text-xs font-medium text-gray-500">(Precached Assets)</span>
            </p>
          </div>
          <p className="text-xs text-gray-500 mt-2">
            {t('app_size_sub')}
          </p>
        </div>

        {/* Card 2: Model Size */}
        <div className="p-4 bg-white rounded-2xl border border-gray-200 shadow-sm flex flex-col justify-between">
          <div>
            <div className="flex items-center justify-between">
              <span className="text-xs font-bold text-gray-600">{t('model_size_label')}</span>
              <div className="p-1.5 bg-purple-50 text-purple-600 rounded-lg">
                <Cpu className="w-4 h-4" />
              </div>
            </div>
            <p className="text-2xl font-black text-primary mt-2">
              {t('model_size_value')} <span className="text-xs font-medium text-gray-500">(BM25 Index)</span>
            </p>
          </div>
          <p className="text-xs text-gray-600 mt-2 bg-gray-50 p-2 rounded-lg border border-gray-100">
            {t('model_size_sub')}
          </p>
        </div>

        {/* Card 3: Memory Used */}
        <div className="p-4 bg-white rounded-2xl border border-gray-200 shadow-sm flex flex-col justify-between">
          <div>
            <div className="flex items-center justify-between">
              <span className="text-xs font-bold text-gray-600">{t('memory_used_label')}</span>
              <div className="p-1.5 bg-amber-50 text-amber-600 rounded-lg">
                <HardDrive className="w-4 h-4" />
              </div>
            </div>
            <p className="text-lg font-bold text-gray-900 mt-2 font-mono">
              {heapMemory}
            </p>
          </div>
          <p className="text-xs text-gray-500 mt-2">
            {t('memory_used_sub')}
          </p>
        </div>

        {/* Card 4: Response Latencies (p50 / p95 / avg / last) */}
        <div className="p-4 bg-white rounded-2xl border border-gray-200 shadow-sm flex flex-col justify-between">
          <div>
            <div className="flex items-center justify-between">
              <span className="text-xs font-bold text-gray-600">{t('latency_label')}</span>
              <div className="p-1.5 bg-emerald-50 text-emerald-600 rounded-lg">
                <Zap className="w-4 h-4" />
              </div>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mt-2.5">
              <div className="p-2 bg-gray-50 rounded-xl">
                <span className="text-[10px] text-gray-500 block truncate">{t('last_query_label')}</span>
                <span className="text-base font-black text-gray-900 font-mono">
                  {telemetry.lastDurationMs} ms
                </span>
              </div>
              <div className="p-2 bg-gray-50 rounded-xl">
                <span className="text-[10px] text-gray-500 block truncate">{t('avg_query_label')}</span>
                <span className="text-base font-black text-primary font-mono">
                  {telemetry.avgDurationMs} ms
                </span>
              </div>
              <div className="p-2 bg-gray-50 rounded-xl">
                <span className="text-[10px] text-gray-500 block truncate">{t('p50_latency_label')}</span>
                <span className="text-base font-black text-primary font-mono">
                  {telemetry.p50DurationMs || telemetry.lastDurationMs || 0} ms
                </span>
              </div>
              <div className="p-2 bg-gray-50 rounded-xl">
                <span className="text-[10px] text-gray-500 block truncate">{t('p95_latency_label')}</span>
                <span className="text-base font-black text-emerald-800 font-mono">
                  {telemetry.p95DurationMs || telemetry.lastDurationMs || 0} ms
                </span>
              </div>
            </div>
          </div>
          <p className="text-[11px] text-gray-400 mt-2 font-mono text-right">
            {t('latency_sub')} ({telemetry.totalQueries} queries)
          </p>
        </div>
      </div>

      {/* Evaluator Data Controls: Reset Demo Data & Export Backup */}
      <div className="bg-white p-4 rounded-2xl border border-gray-200 shadow-sm space-y-3">
        <h3 className="text-sm font-bold text-gray-900">
          {t('evaluator_tools_title')} — {t('backup_export_title')} & {t('reset_demo_title')}
        </h3>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-1">
          {/* Action 1: Reset Demo Data */}
          <div className="p-3.5 bg-red-50/50 rounded-xl border border-red-100 flex flex-col justify-between space-y-2">
            <div>
              <h4 className="text-xs font-bold text-gray-900">{t('reset_demo_title')}</h4>
              <p className="text-[11px] text-gray-600 mt-0.5 leading-relaxed">
                {t('reset_demo_desc')}
              </p>
            </div>
            <button
              onClick={() => setShowResetConfirm(true)}
              className="min-h-touch px-3 py-2 rounded-xl text-xs font-bold bg-white hover:bg-red-50 text-red-700 border border-red-200 shadow-sm flex items-center justify-center gap-1.5 transition-all active:scale-95"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              <span>{t('reset_demo_title')}</span>
            </button>
          </div>

          {/* Action 2: Export Local Backup */}
          <div className="p-3.5 bg-blue-50/50 rounded-xl border border-blue-100 flex flex-col justify-between space-y-2">
            <div>
              <h4 className="text-xs font-bold text-gray-900">{t('backup_export_title')}</h4>
              <p className="text-[11px] text-gray-600 mt-0.5 leading-relaxed">
                {t('backup_export_desc')}
              </p>
            </div>
            <button
              onClick={handleExportBackup}
              className="min-h-touch px-3 py-2 rounded-xl text-xs font-bold bg-white hover:bg-blue-50 text-primary border border-blue-200 shadow-sm flex items-center justify-center gap-1.5 transition-all active:scale-95"
            >
              <Download className="w-3.5 h-3.5" />
              <span>{t('export_backup_button')}</span>
            </button>
          </div>
        </div>
      </div>

      {/* Reset Confirmation Modal */}
      {showResetConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-fade-in">
          <div className="bg-white rounded-2xl max-w-sm w-full p-5 shadow-2xl border border-gray-200 space-y-4">
            <div className="flex items-center gap-3">
              <div className="p-2.5 bg-red-100 text-red-700 rounded-xl">
                <AlertCircle className="w-5 h-5" />
              </div>
              <h3 className="text-base font-bold text-gray-900 leading-tight">
                {t('reset_demo_title')}
              </h3>
            </div>

            <p className="text-xs text-gray-600 leading-relaxed">
              {t('reset_demo_confirm')}
            </p>

            <div className="flex items-center justify-end gap-2 pt-2">
              <button
                onClick={() => setShowResetConfirm(false)}
                disabled={isResetting}
                className="min-h-touch px-4 py-2 rounded-xl text-xs font-bold text-gray-700 hover:bg-gray-100 transition-colors"
              >
                {t('cancel')}
              </button>
              <button
                onClick={handleReset}
                disabled={isResetting}
                className="min-h-touch px-4 py-2 rounded-xl text-xs font-bold bg-red-600 hover:bg-red-700 active:scale-95 text-white shadow-sm transition-all disabled:opacity-50"
              >
                {isResetting ? "..." : t('confirm')}
              </button>
            </div>
          </div>
        </div>
      )}

      <DisclaimerBanner />
    </div>
  );
}
