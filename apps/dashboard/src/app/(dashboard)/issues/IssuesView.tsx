"use client";

import { Icon as UiIcon } from "@repo/ui/icons";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  getApiErrorMessage,
  issuesApi,
  type IssueCounts,
  type IssueSeverity,
  type SystemIssue,
  type MonitoringScanSession,
} from "@/lib/api";
import { PageContainer } from "@/components/ui/PageContainer";
import { useI18n, interpolate } from "@/components/i18n-provider";
import { usePlatform } from "@/context/PlatformContext";
import { useToast } from "@/components/toast";
import { EmptyIssues } from "@/components/issues/EmptyIssues";
import { IssueList } from "@/components/issues/IssueList";
import { IssueSummary } from "@/components/issues/IssueSummary";
import { useIssueActions } from "@/components/issues/useIssueActions";
import { useReattachActiveFix } from "@/hooks/useReattachActiveFix";
import { useInfraFleet } from "@/hooks/useInfraFleet";
import {
  PrepareStreamContent,
  useContainerApplyModal,
  type SystemPrepareOptions,
} from "@/hooks/useSystemPrepareModal";
import { InfraFleetCard } from "@/components/infra/InfraFleetCard";
import type { ContainerApplyActive, ContainerApplyIntent } from "@/lib/api/system";
import { MonitoringHealth } from "@/components/issues/MonitoringHealth";
import { MonitoringNavigation, type MonitoringTab } from "@/components/issues/MonitoringNavigation";

type SeverityFilter = "all" | IssueSeverity;

const SEVERITY_FILTERS: SeverityFilter[] = ["all", "outage", "action_required", "advisory"];

/**
 * The global issue tracker.
 *
 * All the judgement lives server-side in `/api/issues` — severity, grouping, and the
 * fix each row carries. What's left here is genuinely presentational state (which
 * tab, which severity, the search box) plus dispatching a row's fix to the mechanism
 * that already performs it: an HTTP call for project/domain items, the shared
 * `useInfraFix` stream flow for managed containers.
 *
 * The one thing worth stating in code: this page NEVER decides that something is
 * fine. An empty list means every source reported nothing, not that a filter here
 * chose to hide it.
 */
export function IssuesView() {
  const { t } = useI18n();
  const c = t.issues;
  const { selfHosted } = usePlatform();
  const { toast } = useToast();
  const [tab, setTab] = useState<MonitoringTab>("open");
  const showFleet = selfHosted && tab === "open";
  const infra = useInfraFleet(selfHosted);
  const [operation, setOperation] = useState<{
    id: string;
    opts: SystemPrepareOptions;
  } | null>(null);
  const operationSequence = useRef(0);
  const presentOperation = useCallback((opts: SystemPrepareOptions) => {
    const id = `issue-operation-${++operationSequence.current}`;
    setOperation({
      id,
      opts: { ...opts, retryMode: opts.initialAttachSessionId ? "reattach" : "restart" },
    });
    return id;
  }, []);
  const presentRecoveredOperation = useCallback(
    (opts: SystemPrepareOptions) =>
      operationSequence.current === 0 ? presentOperation(opts) : "",
    [presentOperation],
  );
  const openContainerApply = useContainerApplyModal(presentOperation);

  // Refresh recovery: if an edge install/repair is running (the fix a row here
  // dispatches), re-open its inline log rather than leaving the operator on a
  // static "issue" row with no sign the work is already underway.
  useReattachActiveFix({ install: selfHosted }, presentRecoveredOperation);

  const [issues, setIssues] = useState<SystemIssue[]>([]);
  const [counts, setCounts] = useState<IssueCounts | null>(null);
  const [loading, setLoading] = useState(true);
  const [rescanning, setRescanning] = useState(false);
  const [scan, setScan] = useState<MonitoringScanSession | null>(null);
  const [severity, setSeverity] = useState<SeverityFilter>("all");
  const [query, setQuery] = useState("");
  const [queryDraft, setQueryDraft] = useState("");
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Container health is a self-hosted capability: the watcher reads Docker
  // daemons owned by this installation. Cloud workloads are observed by the
  // cloud platform, not by this local health endpoint, so do not expose a tab
  // that can only answer with the route's intentional local-only 404.
  useEffect(() => {
    if (!selfHosted && tab === "health") setTab("open");
  }, [selfHosted, tab]);

  const load = useCallback(
    async (opts: { silent?: boolean } = {}) => {
      // The Health tab has its own cached snapshot reader. Open-feed counts
      // continue refreshing in the sidebar; this hidden list needs no polling.
      if (tab === "health") return;
      if (!opts.silent) setLoading(true);
      try {
        const res = await issuesApi.list(tab === "resolved" ? "resolved" : "open");
        setIssues(res?.data ?? []);
        setCounts(res?.counts ?? null);
      } catch (err) {
        toast("error", getApiErrorMessage(err, c.loadFailed), c.toast.title);
      } finally {
        setLoading(false);
      }
    },
    [tab, c.loadFailed, c.toast.title, toast],
  );

  const { busyId, resolve, infraFix } = useIssueActions(load, presentOperation);

  // Updates in the monitoring feed are fleet work, not modal work. The bulk API
  // accepts every eligible target immediately and the fleet hook follows the
  // durable in-progress rows after navigation or refresh. The inline panel reads
  // one target's replayable log without interrupting those background operations.
  const openApplyLog = useCallback(
    (target: ContainerApplyActive) => {
      if (!target.sessionId) return;
      openContainerApply(target.serverId, target.component, {
        label:
          target.component === "mail"
            ? t.servers.containers.componentMail
            : t.servers.containers.componentEdge,
        intent: target.intent ?? "update",
        attachSessionId: target.sessionId,
        onDone: () => void infra.reload(),
      });
    },
    [openContainerApply, t.servers.containers, infra.reload],
  );

  const runBulk = useCallback(
    async (intent: ContainerApplyIntent) => {
      try {
        const result = await infra.applyAll(intent);
        if (!result) return;
        if (result.started.length === 0 && result.skipped.length === 0) {
          toast("info", t.servers.list.infra.nothingToDo);
        } else if (result.skipped.length > 0) {
          const copy = t.servers.list.infra;
          toast(
            "info",
            interpolate(result.skipped.length === 1 ? copy.skippedOne : copy.skippedMany, {
              n: String(result.skipped.length),
            }),
          );
        }
      } catch {
        toast("error", t.servers.list.infra.applyFailed);
      }
    },
    [infra, toast, t.servers.list.infra],
  );

  useEffect(() => {
    void load();
  }, [load]);

  // Reattach to the instance-wide checker batch after refresh. This polls only a
  // tiny in-memory status document; it never starts or repeats scanner work.
  useEffect(() => {
    if (!selfHosted) return;
    let cancelled = false;
    const read = async () => {
      const result = await issuesApi.rescanStatus().catch(() => null);
      if (cancelled || !result) return;
      setScan(result.data);
      setRescanning(result.data?.status === "running");
      if (result.data?.status === "running") window.setTimeout(() => void read(), 1200);
    };
    void read();
    return () => { cancelled = true; };
  }, [selfHosted]);

  useEffect(() => {
    return () => {
      if (debounce.current) clearTimeout(debounce.current);
    };
  }, []);

  const onQueryChange = (value: string) => {
    setQueryDraft(value);
    if (debounce.current) clearTimeout(debounce.current);
    debounce.current = setTimeout(() => setQuery(value), 300);
  };

  // Cancels the pending debounce too, or a 300ms-old keystroke lands after the reset
  // and re-narrows the page.
  const clearFilters = () => {
    if (debounce.current) clearTimeout(debounce.current);
    setQueryDraft("");
    setQuery("");
    setSeverity("all");
  };

  const handleRescan = async () => {
    if (rescanning) return;
    setRescanning(true);
    try {
      const res = await issuesApi.rescan();
      setScan(res.data);
      // The POST only accepts the batch. This status loop owns completion;
      // closing/navigating away cannot cancel the server-side jobs.
      const watch = async () => {
        const status = await issuesApi.rescanStatus().catch(() => null);
        if (!status?.data) return;
        setScan(status.data);
        if (status.data.status === "running") {
          window.setTimeout(() => void watch(), 1200);
          return;
        }
        const failed = status.data.stages.filter((stage) => stage.status === "failed").length;
        toast(
          failed ? "error" : "success",
          failed ? interpolate(c.toast.rescanPartial, { n: String(failed) }) : c.toast.rescanned,
          c.toast.title,
        );
        await load({ silent: true });
        setRescanning(false);
      };
      void watch();
    } catch (err) {
      toast("error", getApiErrorMessage(err, c.toast.rescanFailed), c.toast.title);
      setRescanning(false);
    }
  };

  const q = query.trim().toLowerCase();
  const filtered = useMemo(
    () =>
      issues.filter((i) => {
        if (severity !== "all" && i.severity !== severity) return false;
        if (!q) return true;
        return `${i.title} ${i.message} ${i.target.name}`.toLowerCase().includes(q);
      }),
    [issues, severity, q],
  );

  // Facet counts come from the UNFILTERED list, so the strip stays stable while a
  // filter narrows the page — the same rule the jobs page follows.
  const facetCount = (f: SeverityFilter): number =>
    f === "all" ? issues.length : issues.filter((i) => i.severity === f).length;

  return (
    <PageContainer>
      <div className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h1
            className="text-2xl font-medium text-foreground/80"
            style={{ letterSpacing: "-0.2px" }}
          >
            {c.title}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground/70">{c.subtitle}</p>
        </div>
        {/* Re-scan updates the current issue feed; Health owns its check control. */}
        {showFleet && (
          <button
            type="button"
            onClick={handleRescan}
            disabled={rescanning}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-xl border border-border/60 bg-card px-4 py-2.5 text-[13px] font-medium text-foreground transition-colors hover:bg-muted/50 disabled:opacity-60"
          >
            {rescanning ? (
              <UiIcon name="spinner" className="size-4 animate-spin" />
            ) : (
              <UiIcon name="refresh" className="size-4" />
            )}
            {rescanning ? c.rescanning : c.rescan}
          </button>
        )}
      </div>

      <MonitoringNavigation value={tab} onChange={setTab} selfHosted={selfHosted} />

      {operation && (
        <section
          className="mb-6 rounded-2xl border border-border/50 bg-card"
          aria-label="Operation log"
        >
          <PrepareStreamContent
            key={operation.id}
            opts={operation.opts}
            inline
            onClose={() => setOperation(null)}
          />
        </section>
      )}

      <section
        role="tabpanel"
        id={`monitoring-panel-${tab}`}
        aria-labelledby={`monitoring-tab-${tab}`}
        tabIndex={0}
        className="focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
      >
      {scan && tab === "open" && <ScanProgress session={scan} />}

      {/* The Resolved tab is honest about its coverage: only incidents have a lifecycle,
          so its silence is not a claim that nothing else ever broke. Sits above the
          content rather than inside the feed column, because it qualifies the whole tab —
          including the empty card, which is exactly when the caveat matters most. */}
      {!loading && tab === "resolved" && (
        <p className="mb-4 rounded-xl border border-border/50 bg-muted/25 px-4 py-3 text-[12px] leading-relaxed text-muted-foreground">
          {c.resolvedNote}
        </p>
      )}

      {tab === "health" ? (
        <MonitoringHealth />
      ) : loading ? (
        // Two-column skeleton: the feed on the left, the summary rail on the right,
        // so the fold doesn't reflow when the real data lands.
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1fr_340px]">
          <div className="min-w-0 space-y-4">
            {[0, 1].map((i) => (
              <div key={i} className="overflow-hidden rounded-2xl border border-border/60 bg-card">
                <div className="flex items-start gap-3 border-b border-border/60 px-5 py-4">
                  <div className="size-9 shrink-0 rounded-xl bg-muted" />
                  <div className="flex-1 space-y-2">
                    <div className="h-3.5 w-32 rounded bg-muted" />
                    <div className="h-3 w-56 rounded bg-muted" />
                  </div>
                </div>
                <div className="space-y-3 px-5 py-4">
                  <div className="h-3 w-3/5 rounded bg-muted" />
                  <div className="h-3 w-2/5 rounded bg-muted" />
                </div>
              </div>
            ))}
          </div>
          <div className="hidden rounded-2xl border border-border/50 bg-card lg:block">
            <div className="flex items-center gap-3 border-b border-border/50 px-5 py-4">
              <div className="size-9 shrink-0 rounded-xl bg-muted" />
              <div className="space-y-2">
                <div className="h-3.5 w-24 rounded bg-muted" />
                <div className="h-3 w-32 rounded bg-muted" />
              </div>
            </div>
            <div className="space-y-4 p-5">
              <div className="h-6 w-16 rounded bg-muted" />
              <div className="h-1.5 w-full rounded-full bg-muted" />
              <div className="space-y-2 pt-1">
                {[0, 1, 2].map((i) => (
                  <div key={i} className="h-4 w-full rounded bg-muted" />
                ))}
              </div>
            </div>
          </div>
        </div>
      ) : issues.length === 0 && (!showFleet || infra.empty) ? (
        // Nothing at all for this tab: the empty state stands alone, full width and
        // centred, with no filters or summary rail to frame an absence.
        <EmptyIssues filtered={false} resolved={tab === "resolved"} />
      ) : (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1fr_340px]">
          {/* ── LEFT COLUMN — the feed ── */}
          <div className="min-w-0">
            {issues.length === 0 ? (
              <EmptyIssues filtered={false} resolved={tab === "resolved"} />
            ) : (
              <>
            <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center">
              <div className="relative w-full sm:flex-1 sm:min-w-[220px]">
                <UiIcon name="search" className="pointer-events-none absolute start-3.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                <input
                  type="text"
                  placeholder={c.filters.searchPlaceholder}
                  value={queryDraft}
                  onChange={(e) => onQueryChange(e.target.value)}
                  className="h-10 w-full rounded-xl border border-border/50 bg-card ps-10 pe-4 text-sm text-foreground transition-all placeholder:text-muted-foreground focus:border-primary/20 focus:outline-none focus:ring-2 focus:ring-primary/20"
                />
              </div>
              <div className="inline-flex max-w-full shrink-0 flex-wrap items-center gap-1 rounded-xl bg-muted/35 p-1">
                {SEVERITY_FILTERS.map((f) => {
                  const n = facetCount(f);
                  return (
                    <button
                      key={f}
                      type="button"
                      onClick={() => setSeverity(f)}
                      className={`inline-flex h-8 items-center gap-1.5 rounded-lg px-3.5 text-[12px] font-medium transition-colors ${
                        severity === f
                          ? "border border-border/60 bg-card text-foreground"
                          : "text-muted-foreground hover:bg-background/60 hover:text-foreground"
                      }`}
                    >
                      {c.filters[f]}
                      {/* Hidden at 0: an empty facet is information, a "0" chip is noise. */}
                      {n > 0 && <span className="tabular-nums text-muted-foreground/60">{n}</span>}
                    </button>
                  );
                })}
              </div>
            </div>

            {filtered.length === 0 ? (
              <EmptyIssues filtered resolved={tab === "resolved"} />
            ) : (
              <IssueList
                issues={filtered}
                busyId={busyId}
                onResolve={resolve}
                onInfraFix={infraFix}
              />
            )}

            {/* Shown out of total, only while a filter is narrowing the page — otherwise
                the facet strip and the rail already say it. The reset rides along: when
                the filter hides everything the page has no other way out, and the search
                box and severity strip are two separate controls to undo by hand. */}
            {counts && filtered.length !== counts.total && (
              <div className="mt-4 flex items-center gap-3">
                <p className="text-[12px] tabular-nums text-muted-foreground/70">
                  {filtered.length} / {counts.total}
                </p>
                <button
                  type="button"
                  onClick={clearFilters}
                  className="text-[12px] font-medium text-muted-foreground underline-offset-4 transition-colors hover:text-foreground hover:underline"
                >
                  {c.filters.clear}
                </button>
              </div>
            )}
              </>
            )}
          </div>

          {/* ── RIGHT COLUMN — sticky summary ── */}
          <div className="space-y-4 lg:sticky lg:top-6 lg:self-start">
            <IssueSummary issues={issues} tab={tab} />
            {showFleet && !infra.empty && (
              <InfraFleetCard
                counts={infra.counts}
                scanning={infra.scanning}
                applying={infra.applying}
                active={infra.active}
                outcome={infra.outcome}
                onScan={infra.scan}
                onApply={runBulk}
                onViewLogs={openApplyLog}
              />
            )}
          </div>
        </div>
      )}
      </section>
    </PageContainer>
  );
}

const SCAN_LABELS: Record<MonitoringScanSession["stages"][number]["key"], string> = {
  "services:health-watch": "Services & containers",
  "infra:scan": "Server components",
  "domains:verify-pending": "Domains & certificates",
  "updates:scan": "Project updates",
};

function ScanProgress({ session }: { session: MonitoringScanSession }) {
  const actionable = session.stages.filter((stage) => stage.status !== "skipped");
  const finished = actionable.filter((stage) => stage.status === "completed" || stage.status === "failed").length;
  const percent = actionable.length ? Math.round((finished / actionable.length) * 100) : 100;
  const radius = 25;
  const circumference = 2 * Math.PI * radius;

  return (
    <div className="mb-5 rounded-2xl border border-border/50 bg-card p-4">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
        <div className="relative size-16 shrink-0">
          <svg viewBox="0 0 64 64" className="size-16 -rotate-90" aria-label={`${percent}% scanned`}>
            <circle cx="32" cy="32" r={radius} fill="none" stroke="var(--color-muted)" strokeWidth="6" />
            <circle cx="32" cy="32" r={radius} fill="none" stroke={session.status === "completed" ? "var(--color-success-solid)" : "var(--color-primary)"} strokeWidth="6" strokeLinecap="round" strokeDasharray={circumference} strokeDashoffset={circumference * (1 - percent / 100)} className="transition-[stroke-dashoffset] duration-500" />
          </svg>
          <span className="absolute inset-0 flex items-center justify-center text-xs font-semibold tabular-nums">{percent}%</span>
        </div>
        <div className="min-w-0 flex-1">
          <div className="mb-2 flex items-center justify-between gap-3"><div><p className="text-sm font-semibold text-foreground">{session.status === "running" ? "Scanning monitoring sources" : "Latest monitoring scan"}</p><p className="text-xs text-muted-foreground">{finished} of {actionable.length} checkers finished · runs concurrently</p></div></div>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            {session.stages.map((stage) => <div key={stage.key} className="rounded-lg bg-muted/25 px-3 py-2"><div className="flex items-center gap-2"><span className={`size-2 rounded-full ${stage.status === "running" ? "animate-pulse bg-primary" : stage.status === "completed" ? "bg-success-solid" : stage.status === "failed" ? "bg-danger-solid" : "bg-muted-foreground/40"}`} /><span className="truncate text-xs font-medium text-foreground">{SCAN_LABELS[stage.key]}</span></div><p className="mt-1 truncate text-[11px] text-muted-foreground">{scanStageDetail(stage)}</p></div>)}
          </div>
        </div>
      </div>
    </div>
  );
}

function scanStageDetail(stage: MonitoringScanSession["stages"][number]): string {
  if (stage.status === "pending") return "Waiting";
  if (stage.status === "running") return "Checking…";
  if (stage.status === "skipped") return "Not available here";
  if (stage.status === "failed") return stage.error ?? "Failed";
  const values = Object.entries(stage.summary ?? {}).filter(([, value]) => typeof value === "number");
  if (!values.length) return "Completed";
  return values.slice(0, 2).map(([key, value]) => `${value} ${key}`).join(" · ");
}
