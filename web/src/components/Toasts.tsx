import { useEffect } from "react";
import { useStore } from "../store.js";

const TOAST_DURATION_MS = 5000;

export function Toasts() {
  const toasts = useStore((s) => s.toasts);
  const removeToast = useStore((s) => s.removeToast);

  useEffect(() => {
    if (toasts.length === 0) return;
    const latest = toasts[toasts.length - 1];
    const timer = setTimeout(() => removeToast(latest.id), TOAST_DURATION_MS);
    return () => clearTimeout(timer);
  }, [toasts, removeToast]);

  if (toasts.length === 0) return null;

  return (
    <div className="fixed bottom-4 right-4 z-[100] flex flex-col gap-2 pointer-events-none">
      {toasts.map((toast) => (
        <div
          key={toast.id}
          className={`
            flex items-start gap-3 px-4 py-3 rounded-lg shadow-lg text-sm max-w-sm pointer-events-auto
            ${toast.variant === "success"
              ? "bg-green-600 text-white"
              : toast.variant === "error"
              ? "bg-red-600 text-white"
              : "bg-gray-800 dark:bg-gray-700 text-white"}
          `}
        >
          <span className="flex-1">{toast.message}</span>
          <button
            onClick={() => removeToast(toast.id)}
            className="shrink-0 opacity-70 hover:opacity-100 transition-opacity"
            aria-label="Dismiss"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      ))}
    </div>
  );
}
