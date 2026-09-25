"use client";

import { Icon as UiIcon } from "@repo/ui/icons";

import { useI18n } from "@/components/i18n-provider";

/** Shared by Overview and Monitoring; unrelated resource/geo data stays visible. */
export function AnalyticsError({ error, onRetry }: { error: string; onRetry?: () => void }) {
  const { t } = useI18n();
  return (
    <div role="alert" className="bg-card rounded-2xl border border-border/50 p-8 text-center">
      <UiIcon name="alert-circle" className="size-8 text-danger mx-auto mb-3" />
      <p className="text-sm font-medium text-foreground mb-1">{t.projects.analytics.loadFailed}</p>
      <p className="text-xs text-muted-foreground mb-4">{error}</p>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-[13px] font-medium bg-foreground/[0.06] text-foreground hover:bg-foreground/[0.1] transition-colors"
        >
          <UiIcon name="refresh" className="size-3.5" />
          {t.projects.services.retry}
        </button>
      )}
    </div>
  );
}
