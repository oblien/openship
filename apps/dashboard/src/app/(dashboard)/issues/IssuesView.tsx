"use client";

import { reportCaughtError as observeCaughtError } from "@repo/core/diagnostics";
import { Icon as UiIcon } from "@repo/ui/icons";

import { useSearchParams } from "next/navigation";
import { DeploymentsContent } from "../deployments/components";

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

import {
  getApiBaseUrl,
  getApiErrorMessage,
  issuesApi,
  type IssueCounts,
  type IssueSeverity,
  type SystemIssue,
  type MonitoringScanSession,
} from "@/lib/api";
import { PageContainer } from "@/components/ui/PageContainer";
import { Button } from "@/components/ui/button";
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
import { useBrowserOnline } from "@/hooks/useBrowserOnline";
import { monitoringScanIncomplete, useMonitoringScan } from "@/hooks/useMonitoringScan";
import { getActiveOrganizationId, subscribeActiveOrganization } from "@/lib/api/client";
import { NotificationSettings } from "@/components/notifications/NotificationSettings";
import { useUpdates } from "@/components/updates/useUpdates";
import { SecurityOverviewPanel } from "@/components/updates/SecurityOverviewPanel";

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
  const security = useUpdates();
  const securityCount = security.securityOverview.projects.filter(
    (project) => project.findings.length,
  ).length;
  const securityCopy = t.projectSettings.securityAdvisories;
  const { selfHosted, deployMode } = usePlatform();
  const online = useBrowserOnline();
  const { toast } = useToast();
  const organizationId = useSyncExternalStore(subscribeActiveOrganization, getActiveOrganizationId, () => null);
  const apiBaseUrl = getApiBaseUrl();
  const searchParams = useSearchParams();
  const requestedTab = searchParams?.get("tab");
  const tab: MonitoringTab = requestedTab === "health" || requestedTab === "security" || requestedTab === "resolved" || requestedTab === "deployments" || requestedTab === "notifications"
    ? requestedTab : "open";
  const setTab = (next: MonitoringTab) => {
    const url = new URL(window.location.href);
    if (next === "open") url.searchParams.delete("tab");
    else url.searchParams.set("tab", next);
    window.history.pushState(null, "", `${url.pathname}${url.search}${url.hash}`);
  };
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

  const [feedIssues, setIssues] = useState<SystemIssue[]>([]);
  const [counts, setCounts] = useState<IssueCounts | null>(null);
  const [loading, setLoading] = useState(true);
  const [feedError, setFeedError] = useState<string | null>(null);
  const [canClearHistory, setCanClearHistory] = useState(false);
  const [confirmingClear, setConfirmingClear] = useState(false);
  const [clearingHistory, setClearingHistory] = useState(false);
  const clearInFlight = useRef(false);
  const feedScope = useRef<string | null>(null);
  const feedBase = useRef<string | null>(null);
  const [clearError, setClearError] = useState<string | null>(null);
  const [severity, setSeverity] = useState<SeverityFilter>("all");
  const [query, setQuery] = useState("");
  const [queryDraft, setQueryDraft] = useState("");
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mounted = useRef(false);
  const activeTab = useRef(tab);
  activeTab.current = tab;
  const loadVersion = useRef(0);
  const pendingLoad = useRef<{ key: string; promise: Promise<void>; refresh?: Promise<void> } | null>(null);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const load = useCallback(
    (opts: { silent?: boolean; fresh?: boolean } = {}): Promise<void> => {
      // The Health tab has its own cached snapshot reader. Open-feed counts
      // continue refreshing in the sidebar; this hidden list needs no polling.
      const organizationId = getActiveOrganizationId();
      const baseUrl = getApiBaseUrl();
      const inScope = () => mounted.current && activeTab.current === tab &&
        organizationId === getActiveOrganizationId() && baseUrl === getApiBaseUrl();
      if (tab === "health" || tab === "security" || tab === "deployments" || tab === "notifications" || !inScope()) return Promise.resolve();
      const key = `${baseUrl}:${organizationId}:${tab}`;
      const pending = pendingLoad.current;
      if (pending?.key === key) {
        if (!opts.fresh) return pending.promise;
        const version = loadVersion.current;
        // Share one follow-up read and discard it if navigation or newer work
        // supersedes the request that queued it.
        pending.refresh ??= pending.promise.then(() => {
          if (inScope() && version === loadVersion.current) {
            return load({ ...opts, fresh: false });
          }
        });
        return pending.refresh;
      }
      const version = ++loadVersion.current;
      const current = () => inScope() && version === loadVersion.current;
      const promise = (async () => {
        if (!opts.silent) setLoading(true);
        try {
          const res = await issuesApi.list(tab === "resolved" ? "resolved" : "open");
          if (!current()) return;
          setIssues(res?.data ?? []);
          setCounts(res?.counts ?? null);
          setFeedError(null);
          setCanClearHistory(res?.canClearHistory === true);
          feedScope.current = organizationId;
          feedBase.current = baseUrl;
        } catch (err) {
          if (current()) setFeedError(getApiErrorMessage(err, c.loadFailed));
        } finally {
          if (current()) setLoading(false);
        }
      })();
      pendingLoad.current = { key, promise };
      void promise.finally(() => {
        if (pendingLoad.current?.promise === promise) pendingLoad.current = null;
      });
      return promise;
    },
    [tab, organizationId, apiBaseUrl, c.loadFailed, c.toast.title, toast],
  );

  const reloadAfterChange = useCallback(() => load({ silent: true, fresh: true }), [load]);

  useEffect(() => {
    setConfirmingClear(false);
    setClearError(null);
    setCanClearHistory(false);
    setIssues([]);
    setCounts(null);
    setFeedError(null);
  }, [organizationId, apiBaseUrl, tab]);

  async function clearHistory() {
    const scope = getActiveOrganizationId();
    const baseUrl = getApiBaseUrl();
    if (!scope || clearInFlight.current || !confirmingClear || !online || !canClearHistory ||
      activeTab.current !== "resolved" || feedScope.current !== scope || feedBase.current !== baseUrl) return;
    clearInFlight.current = true;
    setClearingHistory(true);
    setClearError(null);
    const current = () => mounted.current && scope === getActiveOrganizationId() &&
      baseUrl === getApiBaseUrl() && activeTab.current === "resolved";
    try {
      await issuesApi.clearHistory();
      if (!current()) return;
      setConfirmingClear(false);
      toast("success", c.history.cleared, c.toast.title);
      await reloadAfterChange();
    } catch (error) {
      if (current()) setClearError(getApiErrorMessage(error, c.history.failed));
    } finally {
      clearInFlight.current = false;
      if (mounted.current) setClearingHistory(false);
    }
  }
  const { busyIds, resolve, infraFix, issues } = useIssueActions(reloadAfterChange, presentOperation, feedIssues);
  const monitoringScan = useMonitoringScan({
    enabled: selfHosted,
    online,
    recheckOnReconnect: deployMode === "desktop",
    onComplete: async (session, notify) => {
      const organizationId = getActiveOrganizationId();
      await Promise.all([reloadAfterChange(), infra.reload()]);
      if (!mounted.current || !notify || organizationId !== getActiveOrganizationId()) return;
      const incomplete = session.stages.filter(monitoringScanIncomplete).length;
      toast(
        incomplete ? "info" : "success",
        incomplete ? interpolate(c.toast.rescanPartial, { n: String(incomplete) }) : c.toast.rescanned,
        c.toast.title,
      );
    },
  });
  const { scan, rescanning } = monitoringScan;

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
      } catch (diagnosticFailure) {
        observeCaughtError(diagnosticFailure, "dashboard/app/(dashboard)/issues/IssuesView");
        toast("error", t.servers.list.infra.applyFailed);
      }
    },
    [infra, toast, t.servers.list.infra],
  );

  useEffect(() => {
    void load();
    if (tab === "health" || tab === "security" || tab === "deployments" || tab === "notifications" || !online) return;
    const refresh = () => {
      if (document.visibilityState !== "hidden") void load({ silent: true });
    };
    const timer = window.setInterval(refresh, 15_000);
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [load, tab, online]);

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
      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
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
            onClick={monitoringScan.rescan}
            disabled={rescanning || !monitoringScan.canRescan}
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
        {tab === "resolved" && organizationId && selfHosted && canClearHistory && !loading && issues.length > 0 && (
          <Button type="button" variant="secondary" size="sm" disabled={!online || clearingHistory}
            onClick={() => { setClearError(null); setConfirmingClear(true); }}>
            <UiIcon name="trash" className="size-4" aria-hidden />
            {c.history.clear}
          </Button>
        )}
      </div>

      <MonitoringNavigation value={tab} onChange={setTab} selfHosted={selfHosted} securityCount={securityCount} />

      {tab !== "deployments" && tab !== "notifications" && tab !== "security" && online && (monitoringScan.error || feedError) && (
        <div role="alert" className="mb-5 flex items-center justify-between gap-3 rounded-xl bg-warning-bg px-4 py-3 text-sm text-warning">
          <p>{monitoringScan.error || feedError}</p>
          <button type="button" onClick={monitoringScan.error ? monitoringScan.refresh : reloadAfterChange} className="shrink-0 rounded-lg bg-warning/10 px-3 py-2 font-medium">
            {c.connectivity.retryStatus}
          </button>
        </div>
      )}

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
      {tab === "open" && securityCount > 0 && (
        <div className="mb-5 flex flex-wrap items-center justify-between gap-3 rounded-2xl bg-warning-bg p-4">
          <p className="flex items-center gap-2 text-sm font-medium">
            <UiIcon name="shield" className="size-4 text-warning" />
            {securityCopy.title}
          </p>
          <Button size="sm" variant="secondary" onClick={() => setTab("security")}>
            {interpolate(securityCopy.reviewApps, { count: securityCount })}
          </Button>
        </div>
      )}

      {/* The Resolved tab is honest about its coverage: only incidents have a lifecycle,
          so its silence is not a claim that nothing else ever broke. Sits above the
          content rather than inside the feed column, because it qualifies the whole tab —
          including the empty card, which is exactly when the caveat matters most. */}
      {!loading && tab === "resolved" && (
        <p className="mb-4 rounded-xl border border-border/50 bg-muted/25 px-4 py-3 text-[12px] leading-relaxed text-muted-foreground">
          {c.resolvedNote}
        </p>
      )}
      {tab === "resolved" && confirmingClear && canClearHistory && (
        <section aria-label={c.history.clear} className="mb-5 space-y-3 rounded-2xl bg-card p-5">
          <p className="text-sm text-foreground">{c.history.confirm}</p>
          <p className="text-sm text-muted-foreground">{c.history.hint}</p>
          {clearError && <p role="alert" className="text-sm text-danger">{clearError}</p>}
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="destructive" size="sm" disabled={clearingHistory || !online}
              onClick={() => void clearHistory()}>
              {clearingHistory && <UiIcon name="spinner" className="size-4 animate-spin" aria-hidden />}
              {clearingHistory ? c.history.clearing : c.history.confirmClear}
            </Button>
            <Button type="button" variant="secondary" size="sm" disabled={clearingHistory}
              onClick={() => setConfirmingClear(false)}>{c.history.cancel}</Button>
          </div>
        </section>
      )}

      {tab === "security" ? (
        <div className="space-y-5">
          <header className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="font-medium">{securityCopy.title}</h2>
              <p className="mt-1 text-sm text-muted-foreground">{securityCopy.persistent}</p>
            </div>
            <Button size="sm" variant="secondary" onClick={security.refresh} disabled={security.securityAvailable === null}>
              {t.actions.refresh}
            </Button>
          </header>
          {security.securityAvailable === null ? (
            <p role="status" className="text-sm text-muted-foreground">{securityCopy.checking}</p>
          ) : security.securityAvailable === false ? (
            <p role="alert" className="text-sm text-warning">{securityCopy.unavailable}</p>
          ) : (
            <SecurityOverviewPanel overview={security.securityOverview} onChecked={security.refresh} />
          )}
        </div>
      ) : tab === "deployments" ? (
        <DeploymentsContent monitoring hideHeader hideSidebar />
      ) : tab === "notifications" ? (
        <NotificationSettings mode="monitoring" />
      ) : tab === "health" ? (
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
      ) : (!online || feedError) && issues.length === 0 ? null : issues.length === 0 && (!showFleet || infra.empty) ? (
        // Nothing at all for this tab: the empty state stands alone, full width and
        // centred, with no filters or summary rail to frame an absence.
        tab === "open" && securityCount > 0 ? null : <EmptyIssues filtered={false} resolved={tab === "resolved"} />
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
                busyIds={busyIds}
                onResolve={resolve}
                onInfraFix={infraFix}
                onRecheck={monitoringScan.canRescan ? monitoringScan.recheckHealth : undefined}
                rechecking={rescanning}
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
  const incomplete = actionable.some(monitoringScanIncomplete);
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
            <circle cx="32" cy="32" r={radius} fill="none" stroke={session.status !== "completed" ? "var(--color-primary)" : incomplete ? "var(--color-warning-solid)" : "var(--color-success-solid)"} strokeWidth="6" strokeLinecap="round" strokeDasharray={circumference} strokeDashoffset={circumference * (1 - percent / 100)} className="transition-[stroke-dashoffset] duration-500" />
          </svg>
          <span className="absolute inset-0 flex items-center justify-center text-xs font-semibold tabular-nums">{percent}%</span>
        </div>
        <div className="min-w-0 flex-1">
          <div className="mb-2 flex items-center justify-between gap-3"><div><p className="text-sm font-semibold text-foreground">{session.status === "running" ? "Scanning monitoring sources" : "Latest monitoring scan"}</p><p className="text-xs text-muted-foreground">{finished} of {actionable.length} checkers finished · runs concurrently</p></div></div>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            {session.stages.map((stage) => <div key={stage.key} className="rounded-lg bg-muted/25 px-3 py-2"><div className="flex items-center gap-2"><span className={`size-2 rounded-full ${stage.status === "running" ? "animate-pulse bg-primary" : monitoringScanIncomplete(stage) ? "bg-warning-solid" : stage.status === "completed" ? "bg-success-solid" : "bg-muted-foreground/40"}`} /><span className="truncate text-xs font-medium text-foreground">{SCAN_LABELS[stage.key]}</span></div><p className="mt-1 text-xs text-muted-foreground">{scanStageDetail(stage)}</p></div>)}
          </div>
        </div>
      </div>
    </div>
  );
}

function scanStageDetail(stage: MonitoringScanSession["stages"][number]): string {
  if (stage.status === "pending") return "Waiting";
  if (stage.status === "running") return "Checking…";
  if (stage.status === "skipped") return "Not included in this scan";
  if (stage.status === "failed") return stage.error ?? "Failed";
  if (Number(stage.summary?.offline) > 0) return "This desktop is offline; remote health is unknown";
  if (Number(stage.summary?.unreachable) > 0) return `${stage.summary!.unreachable} server(s) not reached; health is unknown`;
  if (monitoringScanIncomplete(stage)) return "Some targets could not be checked";
  const values = Object.entries(stage.summary ?? {}).filter(([, value]) => typeof value === "number" && value > 0);
  if (!values.length) return "Completed";
  return values.slice(0, 2).map(([key, value]) => `${value} ${key}`).join(" · ");
}
