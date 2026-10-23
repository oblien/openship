"use client";

import { reportCaughtError as observeCaughtError } from "@repo/core/diagnostics";
import { useI18n } from "@/components/i18n-provider";
import { Icon as UiIcon } from "@repo/ui/icons";

import { useCallback, useEffect, useState } from "react";
import type { WebhookDelivery, WebhookDeliveryPage } from "@/lib/api/incoming-webhooks";

/**
 * Paginated webhook delivery feed — GitHub pushes + custom incoming hooks +
 * backup/forwarded events, newest first, keyset "Load more". Reused for the
 * per-project (Webhooks tab) and org-wide (settings) views by swapping `fetchPage`.
 */
export function WebhookDeliveries({
  fetchPage,
  title = "Recent deliveries",
  subtitle,
  emptyText = "No webhook deliveries yet.",
}: {
  fetchPage: (cursor?: string) => Promise<WebhookDeliveryPage>;
  title?: string;
  subtitle?: string;
  emptyText?: string;
}) {
  const [rows, setRows] = useState<WebhookDelivery[]>([]);
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);

  const load = useCallback(
    async (nextCursor?: string) => {
      const setter = nextCursor ? setLoadingMore : setLoading;
      setter(true);
      try {
        const page = await fetchPage(nextCursor);
        setRows((prev) => (nextCursor ? [...prev, ...page.deliveries] : page.deliveries));
        setCursor(page.nextCursor);
      } catch (diagnosticFailure) {
        observeCaughtError(diagnosticFailure, "dashboard/app/(dashboard)/projects/[id]/components/WebhookDeliveries");
        if (!nextCursor) setRows([]);
      } finally {
        setter(false);
      }
    },
    [fetchPage],
  );

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="rounded-2xl border border-border/50 bg-card p-5">
      <div className="flex items-start gap-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-muted/60 text-muted-foreground">
          <UiIcon name="webhook" className="size-[18px]" />
        </div>
        <div>
          <h2 className="text-[15px] font-semibold text-foreground">{title}</h2>
          {subtitle && <p className="text-xs text-muted-foreground">{subtitle}</p>}
        </div>
      </div>

      <div className="mt-4">
        {loading ? (
          <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
            <UiIcon name="spinner" className="size-4 animate-spin" /> Loading…
          </div>
        ) : rows.length === 0 ? (
          <p className="rounded-xl border border-dashed border-border/50 px-4 py-6 text-center text-sm text-muted-foreground">
            {emptyText}
          </p>
        ) : (
          <>
            <ul className="divide-y divide-border/40">
              {rows.map((d) => (
                <DeliveryRow key={d.id} d={d} />
              ))}
            </ul>
            {cursor && (
              <button
                type="button"
                onClick={() => void load(cursor)}
                disabled={loadingMore}
                className="mt-3 inline-flex w-full items-center justify-center gap-2 rounded-xl border border-border/50 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-muted/40 disabled:opacity-50"
              >
                {loadingMore ? <UiIcon name="spinner" className="size-4 animate-spin" /> : null} Load more
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}

const OUTCOME_TONE: Record<string, string> = {
  dispatched: "text-success border-success/40",
  forwarded: "text-info border-info/40",
  skipped: "text-muted-foreground border-border/60",
  queued: "text-warning border-warning/40",
  ignored: "text-muted-foreground border-border/60",
  received: "text-muted-foreground border-border/60",
  failed: "text-danger border-danger/40",
};

function sourceIcon(source: string) {
  if (source === "forwarded") return <UiIcon name="forward" className="size-3.5" />;
  return <UiIcon name="git-commit" className="size-3.5" />;
}

function DeliveryRow({ d }: { d: WebhookDelivery }) {
  const { t } = useI18n();
  const reasons = t.projects.incomingWebhooks.changeReasons;
  const reasonKeys: Record<string, keyof typeof reasons> = {
    "unrelated-workspaces": "unrelated", "project-files": "application", "project-config": "application",
    "workspace-dependency": "shared", "shared-package": "shared", "root-config": "shared",
    "turbo-global-input": "shared", "shared-or-unknown-file": "shared",
    "explicitly-included": "included", "explicitly-excluded": "excluded", "outside-explicit-includes": "excluded",
    "custom-build-context": "unknown", "analysis-unavailable": "unknown", "unknown-deployed-diff": "unknown", "unknown-changes": "unknown", "unknown-revision": "unknown",
    "first-deployment": "initial", "force-push": "forced", "commit-token": "forced", "force-deploy-next": "forced",
  };
  const reasonKey = d.summary?.reason ? reasonKeys[d.summary.reason] : undefined;
  const reason = reasonKey ? reasons[reasonKey] : null;
  const tone = OUTCOME_TONE[d.outcome] ?? "text-muted-foreground border-border/60";
  const when = new Date(d.receivedAt);
  const label =
    d.source === "github"
      ? d.summary?.repo
        ? `${d.summary.repo}${d.summary.branch ? `#${d.summary.branch}` : ""}`
        : d.event
      : d.summary?.name || d.event;
  const commit = d.summary?.commit ? d.summary.commit.slice(0, 7) : null;

  return (
    <li className="flex items-center gap-3 py-2.5">
      <span
        className={`inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide ${tone}`}
      >
        {d.outcome === "forwarded" ? <UiIcon name="forward" className="size-3" /> : d.outcome === "ignored" ? <UiIcon name="ban" className="size-3" /> : null}
        {d.outcome}
      </span>
      <div className="min-w-0 flex-1">
        <span className="flex min-w-0 items-center gap-1.5 text-sm text-foreground">
          <span className="text-muted-foreground/60">{sourceIcon(d.source)}</span>
          <span className="truncate">{label}</span>
          {commit && <code className="shrink-0 font-mono text-[11px] text-muted-foreground/70">{commit}</code>}
        </span>
        {reason && <p className="mt-1 text-xs text-muted-foreground">{reason}</p>}
      </div>
      <span className="shrink-0 text-[11px] text-muted-foreground/60" title={when.toLocaleString()}>
        {when.toLocaleDateString(undefined, { month: "short", day: "numeric" })}{" "}
        {when.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}
      </span>
    </li>
  );
}
