"use client";

import { Icon } from "@repo/ui/icons";
import { useI18n } from "@/components/i18n-provider";
import type { ActionStatus as Status } from "@repo/core";

const pending = new Set(["queued", "waiting", "running", "cancelling", "provisioning"]);

export function actionTone(status: string) {
  return status === "success"
    ? "text-success"
    : ["failure", "timed_out"].includes(status)
      ? "text-destructive"
      : pending.has(status)
        ? "text-warning"
        : "text-muted-foreground";
}
export function ActionStatus({
  status,
  iconOnly = false,
}: {
  status: Status | "provisioning";
  iconOnly?: boolean;
}) {
  const { t } = useI18n();
  const active = pending.has(status);
  return (
    <span
      className={`inline-flex items-center gap-1.5 whitespace-nowrap text-xs font-medium ${actionTone(status)}`}
      aria-label={iconOnly ? t.actions.status[status] : undefined}
      title={iconOnly ? t.actions.status[status] : undefined}
    >
      <Icon
        name={
          active
            ? "spinner"
            : status === "success"
              ? "check-circle"
              : ["failure", "timed_out"].includes(status)
                ? "x-circle"
                : "circle"
        }
        className={`size-3.5 ${active ? "motion-safe:animate-spin" : ""}`}
      />
      {!iconOnly && t.actions.status[status]}
    </span>
  );
}

export function ActionError({
  message,
  onRetry,
}: {
  message: string | null | undefined;
  onRetry?: () => void;
}) {
  const { t } = useI18n();
  if (!message) return null;
  return (
    <div
      role="alert"
      className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-destructive/5 px-4 py-3 text-sm text-destructive"
    >
      <p className="min-w-0 break-words whitespace-pre-line">{message}</p>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="shrink-0 rounded-lg px-2 py-1 text-xs font-semibold underline underline-offset-4 focus-visible:outline-2"
        >
          {t.actions.retry}
        </button>
      )}
    </div>
  );
}
