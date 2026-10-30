import React, { useState, useEffect } from 'react';
import { CheckCircle, RefreshCw, X } from 'lucide-react';
import { subscribePwaToast } from '../lib/pwa';
import { useLanguage } from '../context/LanguageContext';

export default function Toast() {
  const { t } = useLanguage();
  const [toast, setToast] = useState(null);

  useEffect(() => {
    let timer = null;
    const unsub = subscribePwaToast((data) => {
      setToast(data);
      if (timer) clearTimeout(timer);
      if (data.type !== 'update') {
        timer = setTimeout(() => setToast(null), data.duration || 5000);
      }
    });

    return () => {
      unsub();
      if (timer) clearTimeout(timer);
    };
  }, []);

  if (!toast) return null;

  const displayMessage = toast.message || (toast.type === 'ready' ? t('ready_offline') : t('update_available'));

  return (
    <div className="fixed top-14 left-0 right-0 z-50 px-4 pointer-events-none">
      <div className="max-w-mobile md:max-w-md mx-auto pointer-events-auto">
        <div className="p-3 bg-gray-900 text-white rounded-xl shadow-2xl border border-gray-700 flex items-center justify-between gap-3 animate-fade-in">
          <div className="flex items-center gap-2.5">
            {toast.type === 'update' ? (
              <RefreshCw className="w-5 h-5 text-amber-400 shrink-0 animate-spin" />
            ) : (
              <CheckCircle className="w-5 h-5 text-emerald-400 shrink-0" />
            )}
            <div>
              <p className="text-xs font-medium text-gray-200">
                {displayMessage}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-1.5 shrink-0">
            {toast.action && (
              <button
                onClick={() => {
                  try {
                    toast.action();
                  } finally {
                    setToast(null);
                  }
                }}
                className="px-3 py-1.5 bg-amber-400 hover:bg-amber-300 active:scale-95 text-gray-950 text-xs font-black rounded-lg shadow-sm transition-all"
              >
                {toast.actionLabel || t('tap_to_refresh')}
              </button>
            )}
            <button
              onClick={() => setToast(null)}
              className="p-1 text-gray-400 hover:text-white rounded-md"
              aria-label="Dismiss toast"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
