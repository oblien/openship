"use client";

import { createContext, useCallback, useContext, useState } from "react";

/* ── Types ────────────────────────────────────────────────────── */

type ToastType = "error" | "success" | "info";

interface Toast {
  id: string;
  type: ToastType;
  message: string;
}

interface ToastContextValue {
  toast: (type: ToastType, message: string) => void;
}

const ToastContext = createContext<ToastContextValue>({
  toast: () => {},
});

export function useToast() {
  return useContext(ToastContext);
}

/* ── Provider ─────────────────────────────────────────────────── */

const DURATION = 4500;

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const toast = useCallback((type: ToastType, message: string) => {
    const id = crypto.randomUUID();
    setToasts((prev) => [...prev, { id, type, message }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, DURATION);
  }, []);

  const dismiss = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  return (
    <ToastContext.Provider value={{ toast }}>
      {children}

      {/* Toast container — bottom-right */}
      {toasts.length > 0 && (
        <div className="fixed bottom-5 right-5 z-[9999] flex flex-col gap-2">
          {toasts.map((t) => (
            <div
              key={t.id}
              role="alert"
              onClick={() => dismiss(t.id)}
              className={`
                flex min-w-[280px] max-w-[380px] cursor-pointer items-start gap-3
                rounded-lg border px-4 py-3 text-sm shadow-lg backdrop-blur-sm
                animate-in slide-in-from-bottom-2 fade-in duration-200
                ${typeStyles[t.type]}
              `}
            >
              <span className="mt-px shrink-0">{typeIcons[t.type]}</span>
              <span className="flex-1 leading-relaxed">{t.message}</span>
            </div>
          ))}
        </div>
      )}
    </ToastContext.Provider>
  );
}

/* ── Styles per type ──────────────────────────────────────────── */

const typeStyles: Record<ToastType, string> = {
  error:
    "bg-rose-500/10 border-rose-500/20 text-rose-400",
  success:
    "bg-emerald-500/10 border-emerald-500/20 text-emerald-400",
  info:
    "th-card text-[var(--th-text-body)]",
};

const typeIcons: Record<ToastType, React.ReactNode> = {
  error: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" />
      <line x1="15" y1="9" x2="9" y2="15" />
      <line x1="9" y1="9" x2="15" y2="15" />
    </svg>
  ),
  success: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" />
      <path d="m9 12 2 2 4-4" />
    </svg>
  ),
  info: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" />
      <path d="M12 16v-4M12 8h.01" />
    </svg>
  ),
};
