"use client";

import { Icon, type IconName } from "@repo/ui/icons";
import { createContext, useCallback, useContext, useState } from "react";
import { randomUUID } from "@/lib/random-uuid";

/* ── Types ────────────────────────────────────────────────────── */

type ToastType = "error" | "success" | "info";

interface Toast {
  id: string;
  type: ToastType;
  message: string;
  title?: string;
}

interface ToastContextValue {
  toast: (type: ToastType, message: string, title?: string) => void;
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

  const toast = useCallback((type: ToastType, message: string, title?: string) => {
    const id = randomUUID();
    let added = false;
    setToasts((prev) => {
      // Skip an identical toast that's already on screen so the same
      // error firing repeatedly doesn't stack duplicates.
      if (prev.some((t) => t.type === type && t.message === message && t.title === title)) {
        return prev;
      }
      added = true;
      return [...prev, { id, type, message, title }];
    });
    if (added) {
      setTimeout(() => {
        setToasts((prev) => prev.filter((t) => t.id !== id));
      }, DURATION);
    }
  }, []);

  const dismiss = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  return (
    <ToastContext.Provider value={{ toast }}>
      {children}

      {/* Toast container - bottom-right. z-index MUST stay above the modal
          layer (ModalContext BASE_Z_INDEX = 10000, +100 per stacked modal).
          Toasts are the top-most transient layer, so pin to the CSS max so
          they're never hidden behind a modal. */}
      {toasts.length > 0 && (
        <div className="fixed bottom-5 end-5 z-[2147483647] flex flex-col gap-2">
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
              <Icon name={typeIcons[t.type]} size={16} className="mt-px shrink-0" />
              <div className="min-w-0 flex-1">
                {t.title && (
                  <p className="font-semibold leading-snug">{t.title}</p>
                )}
                <p className="break-words leading-relaxed">{t.message}</p>
              </div>
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
    "bg-danger-bg border-danger-border text-danger",
  success:
    "bg-success-bg border-success-border text-success",
  info:
    "th-card text-[var(--th-text-body)]",
};

const typeIcons: Record<ToastType, IconName> = {
  error: "x-circle",
  success: "check-circle",
  info: "info",
};
