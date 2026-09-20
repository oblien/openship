"use client";

/**
 * Form scaffold for create/edit modals.
 *
 * IMPORTANT: useModal's `customContent` is rendered WITHOUT the default
 * `p-6` wrapper, so this component owns its own outer padding to match
 * what the rest of the dashboard's modals look like.
 *
 * Children = the form fields. Submit/cancel + inline error live in the
 * footer. Submission is async + the submit button shows a spinner while
 * the call is in flight.
 */

import { useState, type FormEvent, type ReactNode } from "react";
import { Loader2 } from "lucide-react";
import { useI18n } from "@/components/i18n-provider";

interface FormModalContentProps {
  title: string;
  description?: string;
  submitLabel: string;
  submittingLabel?: string;
  /** Style of the submit button. `danger` → red, default `primary` → theme. */
  submitVariant?: "primary" | "danger";
  onSubmit: () => Promise<void> | void;
  onCancel: () => void;
  children: ReactNode;
  /** Initial error to surface (e.g. from a parent precheck). */
  initialError?: string;
  /** Disable submit (e.g. while a required field is empty). */
  disabled?: boolean;
  /** Override the cancel button's label (e.g. "Skip"). */
  cancelLabel?: string;
}

export function FormModalContent({
  title,
  description,
  submitLabel,
  submittingLabel,
  submitVariant = "primary",
  onSubmit,
  onCancel,
  children,
  initialError,
  disabled,
  cancelLabel,
}: FormModalContentProps) {
  const { t } = useI18n();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(initialError ?? null);

  const handle = async (e: FormEvent) => {
    e.preventDefault();
    if (submitting || disabled) return;
    setError(null);
    setSubmitting(true);
    try {
      await onSubmit();
    } catch (err) {
      setError(err instanceof Error ? err.message : t.emailsAdmin.shared.actionFailed);
    } finally {
      setSubmitting(false);
    }
  };

  const submitClass =
    submitVariant === "danger"
      ? "bg-danger-solid text-white hover:bg-danger-solid/90"
      : "bg-primary text-primary-foreground hover:bg-primary/90";

  return (
    <form onSubmit={handle} className="p-6 space-y-5">
      <div>
        <h3 className="text-xl font-bold text-foreground mb-1">{title}</h3>
        {description && (
          <p className="text-sm text-muted-foreground leading-relaxed">
            {description}
          </p>
        )}
      </div>

      <div className="space-y-4">{children}</div>

      {error && (
        <div className="rounded-xl border border-danger-border bg-danger-bg px-3.5 py-2.5 text-sm text-danger">
          {error}
        </div>
      )}

      <div className="flex items-center justify-end gap-3 pt-1">
        <button
          type="button"
          onClick={onCancel}
          disabled={submitting}
          className="px-4 py-2.5 text-sm font-semibold rounded-xl bg-muted text-foreground hover:bg-muted/80 border border-border transition-colors disabled:opacity-50"
        >
          {cancelLabel ?? t.emailsAdmin.shared.cancel}
        </button>
        <button
          type="submit"
          disabled={submitting || disabled}
          className={`inline-flex items-center gap-1.5 px-4 py-2.5 text-sm font-semibold rounded-xl transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${submitClass}`}
        >
          {submitting && <Loader2 className="size-3.5 animate-spin" />}
          {submitting ? (submittingLabel ?? submitLabel) : submitLabel}
        </button>
      </div>
    </form>
  );
}

/**
 * Labelled field wrapper. Used for every input row in admin forms so the
 * label / hint text contrast stays consistent with the rest of the
 * dashboard.
 */
export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <label className="block">
      <span className="block text-sm font-medium text-foreground mb-1.5">
        {label}
      </span>
      {children}
      {hint && (
        <span className="block text-xs text-muted-foreground mt-1.5 leading-relaxed">
          {hint}
        </span>
      )}
    </label>
  );
}

/** Canonical input styling - matches the dashboard's other text inputs. */
export const inputClassName =
  "w-full px-3 py-2 text-sm rounded-xl border border-border bg-background text-foreground placeholder:text-muted-foreground/60 focus:outline-none focus:ring-2 focus:ring-primary/40 focus:border-primary/60 transition-colors";
