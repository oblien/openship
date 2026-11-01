"use client";

import { Icon } from "@repo/ui/icons";
import type { ReactNode } from "react";
import { useI18n } from "@/components/i18n-provider";
import { Button } from "@/components/ui/button";

/** An unavailable observation, with a read-only retry rather than a repair action. */
export function ConnectionNotice({
  title,
  message,
  detail,
  onRetry,
  retrying = false,
  tone = "warning",
  actions,
  role = "status",
  retryLabel,
  compact = false,
}: {
  title: string;
  message: string;
  detail?: string;
  onRetry?: () => void;
  retrying?: boolean;
  tone?: "warning" | "neutral";
  actions?: ReactNode;
  role?: "status" | "alert";
  retryLabel?: string;
  compact?: boolean;
}) {
  const { t } = useI18n();
  return (
    <div role={role} className={`flex items-start gap-3 bg-card ${compact ? "rounded-xl p-3" : "rounded-2xl p-4"}`}>
      <span className={`flex shrink-0 items-center justify-center ${compact ? "mt-0.5 size-5 text-muted-foreground" : `size-9 rounded-xl ${retrying || tone === "neutral" ? "bg-muted text-muted-foreground" : "bg-warning-bg text-warning"}`}`}>
        <Icon name={retrying ? "spinner" : "plug"} className={`size-4 ${retrying ? "motion-safe:animate-spin" : ""}`} />
      </span>
      <div className="flex min-w-0 flex-1 flex-wrap items-start gap-x-4 gap-y-3">
        <div className="min-w-0 flex-1 basis-56">
          <p className="text-sm font-medium text-foreground">{title}</p>
          <p className={`${compact ? "mt-0.5 text-xs" : "mt-1 text-sm"} text-muted-foreground`}>{message}</p>
          {detail && (
            <details className="mt-2 text-xs text-muted-foreground">
              <summary className="cursor-pointer">{t.issues.connectivity.details}</summary>
              <p className="mt-1 break-words whitespace-pre-wrap">{detail}</p>
            </details>
          )}
        </div>
        {(onRetry || actions) && (
          <div className="flex flex-wrap items-center gap-2">
            {actions}
            {onRetry && (
              <Button type="button" variant="outline" size="sm" disabled={retrying} onClick={onRetry}>
                <Icon
                  name={retrying ? "spinner" : "refresh"}
                  className={retrying ? "motion-safe:animate-spin" : undefined}
                />
                {retryLabel ?? t.issues.connectivity.retryStatus}
              </Button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
