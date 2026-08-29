"use client";

/**
 * On-demand DNS auto-configure — the button that writes a domain's records
 * through a connected provider (Settings→DNS) instead of asking the operator to
 * paste them. Shared by the deployment domain flow and the mail admin DNS tab.
 *
 * Nothing is written until the operator presses. `plan` is a read-only dry-run
 * that says, per record, exactly what apply would do (add / update / repoint /
 * already-in-place / conflict) so the press is informed and atomic — in-sync
 * records are skipped and records we don't own are never clobbered.
 *
 * `AutoDnsView` is pure/presentational (server-renderable, tested directly with
 * fixtures); `AutoDnsPanel` wraps it with the `useAutoDns` fetching hook.
 */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  Globe,
  Loader2,
  RefreshCcw,
  ShieldCheck,
} from "lucide-react";

import { useI18n, interpolate } from "@/components/i18n-provider";
import { getApiErrorMessage } from "@/lib/api";
import type {
  DnsPlanResult,
  DnsProvisionResult,
  RecordPlanAction,
} from "@/lib/api/dns";

/* ── Hook ──────────────────────────────────────────────────────────── */

export interface UseAutoDns {
  loading: boolean;
  plan: DnsPlanResult | null;
  loadError: string | null;
  applying: boolean;
  result: DnsProvisionResult | null;
  applyError: string | null;
  apply: () => void;
  reload: () => void;
}

/**
 * Drive one panel: fetch the plan on mount (and whenever `reloadKey` changes —
 * a domain switch), apply on press, then re-plan so the rows reflect reality.
 */
export function useAutoDns(
  planFn: () => Promise<DnsPlanResult>,
  applyFn: () => Promise<DnsProvisionResult>,
  reloadKey?: string,
): UseAutoDns {
  const { t } = useI18n();
  const [loading, setLoading] = useState(true);
  const [plan, setPlan] = useState<DnsPlanResult | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);
  const [result, setResult] = useState<DnsProvisionResult | null>(null);
  const [applyError, setApplyError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    planFn()
      .then((p) => {
        if (!cancelled) setPlan(p);
      })
      .catch((err) => {
        if (!cancelled) setLoadError(getApiErrorMessage(err, t.autoDns.unavailableDesc));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // planFn is a fresh closure each render; the panel keys re-fetch on reloadKey/nonce.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reloadKey, nonce]);

  const reload = useCallback(() => {
    setResult(null);
    setApplyError(null);
    setNonce((n) => n + 1);
  }, []);

  const apply = useCallback(() => {
    setApplying(true);
    setApplyError(null);
    applyFn()
      .then((r) => {
        setResult(r);
        // Re-plan so the rows show the post-apply truth (in-sync, or the
        // conflict that survived) without a manual refresh.
        setNonce((n) => n + 1);
      })
      .catch((err) => {
        setApplyError(getApiErrorMessage(err, t.autoDns.applyFailed));
      })
      .finally(() => setApplying(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [applyFn]);

  return { loading, plan, loadError, applying, result, applyError, apply, reload };
}

/* ── Presentational view ───────────────────────────────────────────── */

const WRITABLE: RecordPlanAction[] = ["create", "update", "adopt"];

function actionBadgeClass(action: RecordPlanAction): string {
  switch (action) {
    case "in-sync":
      return "bg-success-bg text-success";
    case "adopt":
      return "bg-warning-bg text-warning";
    case "conflict":
      return "bg-danger-bg text-danger";
    default:
      return "bg-muted text-muted-foreground";
  }
}

function outcomeBadgeClass(outcome: "applied" | "skipped" | "failed"): string {
  switch (outcome) {
    case "applied":
      return "bg-success-bg text-success";
    case "failed":
      return "bg-danger-bg text-danger";
    default:
      return "bg-muted text-muted-foreground";
  }
}

function displayProvider(provider?: string): string {
  if (!provider) return "";
  return provider.charAt(0).toUpperCase() + provider.slice(1);
}

export interface AutoDnsViewProps {
  loading: boolean;
  plan: DnsPlanResult | null;
  loadError: string | null;
  applying: boolean;
  result: DnsProvisionResult | null;
  applyError: string | null;
  onApply: () => void;
  onReload: () => void;
}

export function AutoDnsView({
  loading,
  plan,
  loadError,
  applying,
  result,
  applyError,
  onApply,
  onReload,
}: AutoDnsViewProps) {
  const { t } = useI18n();
  const c = t.autoDns;

  const shell = "rounded-xl border border-border bg-card p-4";

  if (loading && !plan) {
    return (
      <div className={`${shell} flex items-center gap-2`}>
        <Loader2 className="size-4 animate-spin text-muted-foreground" />
        <span className="text-sm text-muted-foreground">{c.checking}</span>
      </div>
    );
  }

  // Couldn't even read the plan (network/API). Same shape as `unavailable`.
  if (loadError && !plan) {
    return (
      <div className={shell}>
        <Notice title={c.unavailableTitle} desc={loadError} />
        <div className="mt-3">
          <RetryButton onClick={onReload} label={c.retry} />
        </div>
      </div>
    );
  }

  if (!plan) return null;

  if (plan.status === "none") {
    return (
      <div className={shell}>
        <div className="flex items-start gap-3">
          <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted">
            <Globe className="size-4 text-muted-foreground" strokeWidth={2} />
          </span>
          <div className="min-w-0">
            <p className="text-sm font-medium text-foreground">{c.noProviderTitle}</p>
            <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
              {c.noProviderDesc}
            </p>
            <Link
              href="/settings?tab=dns"
              className="mt-2 inline-flex items-center gap-1.5 text-xs font-medium text-primary hover:underline"
            >
              {c.connect}
              <ArrowRight className="size-3" />
            </Link>
          </div>
        </div>
      </div>
    );
  }

  if (plan.status === "unauthorized") {
    return (
      <div className={shell}>
        <Notice
          title={c.unauthorizedTitle}
          desc={plan.reason || c.unauthorizedDesc}
        />
        <Link
          href="/settings?tab=dns"
          className="mt-3 inline-flex items-center gap-1.5 text-xs font-medium text-primary hover:underline"
        >
          {c.reconnect}
          <ArrowRight className="size-3" />
        </Link>
      </div>
    );
  }

  if (plan.status === "unavailable") {
    return (
      <div className={shell}>
        <Notice
          title={c.unavailableTitle}
          desc={plan.reason || c.unavailableDesc}
        />
        <div className="mt-3">
          <RetryButton onClick={onReload} label={c.retry} />
        </div>
      </div>
    );
  }

  // status === "matched"
  const records = plan.records;
  const allInSync = records.length > 0 && records.every((r) => r.action === "in-sync");
  const writable = records.filter((r) => WRITABLE.includes(r.action));
  const canApply = writable.length > 0 && !applying;

  return (
    <div className={shell}>
      <div className="flex items-center gap-2">
        <ShieldCheck className="size-4 text-success" strokeWidth={2} />
        <p className="text-sm font-medium text-foreground">
          {interpolate(c.managedBy, {
            provider: displayProvider(plan.provider),
            zone: plan.zoneName || "",
          })}
        </p>
      </div>

      {/* Before apply: the plan. After apply: the outcome log. */}
      {result ? (
        <ul className="mt-3 space-y-1.5">
          {result.records.map((r, i) => (
            <li
              key={`${r.type}-${r.name}-${i}`}
              className="flex items-center justify-between gap-3 rounded-lg bg-muted/40 px-3 py-2"
            >
              <div className="min-w-0">
                <p className="truncate font-mono text-xs text-foreground">{r.name}</p>
                {r.error && (
                  <p className="mt-0.5 text-[11px] leading-snug text-danger">{r.error}</p>
                )}
              </div>
              <span className="flex items-center gap-2 shrink-0">
                <span className="font-mono text-[10px] uppercase text-muted-foreground/70">
                  {r.type}
                </span>
                <span
                  className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold ${outcomeBadgeClass(r.outcome)}`}
                >
                  {r.outcome === "applied"
                    ? c.outcomeApplied
                    : r.outcome === "failed"
                      ? c.outcomeFailed
                      : c.outcomeSkipped}
                </span>
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <ul className="mt-3 space-y-1.5">
          {records.map((r, i) => (
            <li
              key={`${r.type}-${r.name}-${i}`}
              className="rounded-lg bg-muted/40 px-3 py-2"
            >
              <div className="flex items-center justify-between gap-3">
                <p className="truncate font-mono text-xs text-foreground">{r.name}</p>
                <span className="flex items-center gap-2 shrink-0">
                  <span className="font-mono text-[10px] uppercase text-muted-foreground/70">
                    {r.type}
                  </span>
                  <span
                    className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold ${actionBadgeClass(r.action)}`}
                  >
                    {actionLabel(r.action, c)}
                  </span>
                </span>
              </div>
              {r.action === "conflict" && (
                <p className="mt-1 text-[11px] leading-snug text-muted-foreground">
                  {c.conflictNote}
                </p>
              )}
            </li>
          ))}
        </ul>
      )}

      {applyError && (
        <p className="mt-2 text-xs text-danger">{applyError}</p>
      )}

      <div className="mt-3 flex items-center gap-3">
        {allInSync ? (
          <span className="inline-flex items-center gap-1.5 text-xs font-medium text-success">
            <CheckCircle2 className="size-3.5" />
            {c.allInPlace}
          </span>
        ) : writable.length > 0 ? (
          <button
            type="button"
            onClick={onApply}
            disabled={!canApply}
            className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
          >
            {applying ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <ShieldCheck className="size-3.5" />
            )}
            {applying ? c.applying : result ? c.reapply : c.apply}
          </button>
        ) : null}

        {result && !applying && (
          <span className="text-xs text-muted-foreground">
            {result.provisioned ? c.resultDone : c.resultPartial}
          </span>
        )}
      </div>
    </div>
  );
}

function actionLabel(
  action: RecordPlanAction,
  c: ReturnType<typeof useI18n>["t"]["autoDns"],
): string {
  switch (action) {
    case "create":
      return c.actionCreate;
    case "update":
      return c.actionUpdate;
    case "adopt":
      return c.actionAdopt;
    case "conflict":
      return c.actionConflict;
    default:
      return c.actionInSync;
  }
}

function Notice({ title, desc }: { title: string; desc?: string }) {
  return (
    <div className="flex items-start gap-3">
      <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-warning-bg">
        <AlertTriangle className="size-4 text-warning" strokeWidth={2} />
      </span>
      <div className="min-w-0">
        <p className="text-sm font-medium text-foreground">{title}</p>
        {desc && (
          <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{desc}</p>
        )}
      </div>
    </div>
  );
}

function RetryButton({ onClick, label }: { onClick: () => void; label: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-muted px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-muted/80"
    >
      <RefreshCcw className="size-3" />
      {label}
    </button>
  );
}

/* ── Container ─────────────────────────────────────────────────────── */

export interface AutoDnsPanelProps {
  plan: () => Promise<DnsPlanResult>;
  apply: () => Promise<DnsProvisionResult>;
  /** Re-plan when this changes (e.g. the selected mail domain). */
  reloadKey?: string;
}

export function AutoDnsPanel({ plan, apply, reloadKey }: AutoDnsPanelProps) {
  const s = useAutoDns(plan, apply, reloadKey);
  return (
    <AutoDnsView
      loading={s.loading}
      plan={s.plan}
      loadError={s.loadError}
      applying={s.applying}
      result={s.result}
      applyError={s.applyError}
      onApply={s.apply}
      onReload={s.reload}
    />
  );
}

export default AutoDnsPanel;
