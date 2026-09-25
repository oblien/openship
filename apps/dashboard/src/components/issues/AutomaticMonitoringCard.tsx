"use client";

import { Icon as UiIcon } from "@repo/ui/icons";

import Link from "next/link";
import { Button } from "@/components/ui/button";
import type { MonitoringHealthSnapshot } from "@/lib/api/issues";

export function AutomaticMonitoringCard({
  watcher,
  watching,
  busy,
  disabled,
  error,
  onToggle,
}: {
  watcher: MonitoringHealthSnapshot["watcher"];
  watching: boolean;
  busy: boolean;
  disabled: boolean;
  error: string | null;
  onToggle: () => void;
}) {
  return (
    <section
      aria-labelledby="automatic-monitoring-title"
      className="overflow-hidden rounded-2xl border border-border/50 bg-card"
    >
      <div className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:px-5">
        <div className="flex min-w-0 flex-1 items-start gap-3">
          <div
            className={`flex size-9 shrink-0 items-center justify-center rounded-xl ${watching ? "bg-success-bg text-success" : "bg-primary/10 text-primary"}`}
          >
            <UiIcon name="power" className="size-4" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h3
                id="automatic-monitoring-title"
                className="text-[15px] font-semibold text-foreground"
              >
                Automatic monitoring
              </h3>
              <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                {!watcher.available ? "Unavailable" : watching ? "Enabled" : "Off"}
              </span>
            </div>
            <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground">
              {!watcher.available
                ? "Background jobs are disabled for this installation."
                : watching
                  ? "Failures and recovery are tracked in Issues."
                  : watcher.canManage
                    ? "Track container failures in Issues and your alert channels."
                    : "An instance administrator can enable automatic checks."}
            </p>
            {watcher.available && (
              <p className="mt-1 text-xs text-muted-foreground">
                {!watcher.schedule || watcher.schedule === "* * * * *"
                  ? "Every minute"
                  : "Custom schedule"}
                {" · "}
                {watcher.runsWhileAppOpen ? "Keep Openship running" : "Runs in the background"}
              </p>
            )}
          </div>
        </div>
        {watcher.canManage && watcher.available && (
          <Button
            variant={watching ? "outline" : "default"}
            className="shrink-0"
            onClick={onToggle}
            disabled={busy || disabled}
          >
            {busy ? <UiIcon name="spinner" className="animate-spin" /> : <UiIcon name="power" />}
            {busy ? "Saving…" : watching ? "Disable monitoring" : "Enable monitoring"}
          </Button>
        )}
      </div>
      <details className="group border-t border-border/50">
        <summary className="flex cursor-pointer list-none items-center gap-2 px-4 py-2.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/40 sm:px-5 [&::-webkit-details-marker]:hidden">
          Settings & details
          <UiIcon name="chevron-down" className="size-3.5 transition-transform group-open:rotate-180" />
        </summary>
        <div className="space-y-2 px-4 pb-4 text-xs leading-relaxed text-muted-foreground sm:px-5">
          <p>
            Checks cover local and connected-server workloads across this installation and use CPU
            and network traffic. Cloud workloads are excluded.
          </p>
          <p>Check now refreshes status only; it does not create incidents or send alerts.</p>
          <div className="flex flex-wrap gap-x-4 gap-y-2 pt-1">
            {watcher.canManage && watcher.schedule && (
              <Link
                className="font-medium text-foreground underline underline-offset-4"
                href={`/jobs/${encodeURIComponent(watcher.key)}`}
              >
                Monitoring schedule
              </Link>
            )}
            {watcher.available && (
              <Link
                className="font-medium text-foreground underline underline-offset-4"
                href="/settings?tab=notifications"
              >
                Configure alerts
              </Link>
            )}
          </div>
        </div>
      </details>
      {error && (
        <div
          role="alert"
          className="flex items-start gap-2 border-t border-danger-border bg-danger-bg px-5 py-3 text-xs text-danger"
        >
          <UiIcon name="warning" className="mt-0.5 size-3.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}
    </section>
  );
}
