"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Loader2, RefreshCw, Search } from "lucide-react";

import {
  getApiErrorMessage,
  issuesApi,
  type IssueCounts,
  type IssueSeverity,
  type SystemIssue,
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

type SeverityFilter = "all" | IssueSeverity;

const SEVERITY_FILTERS: SeverityFilter[] = ["all", "outage", "action_required", "advisory"];

/**
 * The global issue tracker.
 *
 * All the judgement lives server-side in `/api/issues` — severity, grouping, and the
 * fix each row carries. What's left here is genuinely presentational state (which
 * tab, which severity, the search box) plus dispatching a row's fix to the mechanism
 * that already performs it: an HTTP call for project/domain items, the shared
 * `useInfraFix` modal flow for managed containers.
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

  // Refresh recovery: if an edge install/repair is running (the fix a row here
  // dispatches), re-open its live modal rather than leaving the operator on a
  // static "issue" row with no sign the work is already underway.
  useReattachActiveFix({ install: true });

  const [tab, setTab] = useState<"open" | "resolved">("open");
  const [issues, setIssues] = useState<SystemIssue[]>([]);
  const [counts, setCounts] = useState<IssueCounts | null>(null);
  const [loading, setLoading] = useState(true);
  const [rescanning, setRescanning] = useState(false);
  const [severity, setSeverity] = useState<SeverityFilter>("all");
  const [query, setQuery] = useState("");
  const [queryDraft, setQueryDraft] = useState("");
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(
    async (opts: { silent?: boolean } = {}) => {
      if (!opts.silent) setLoading(true);
      try {
        const res = await issuesApi.list(tab);
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

  const { busyId, resolve, infraFix } = useIssueActions(load);

  useEffect(() => {
    void load();
  }, [load]);

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
      const failed = res?.data?.failed?.length ?? 0;
      toast(
        failed > 0 ? "error" : "success",
        failed > 0 ? interpolate(c.toast.rescanPartial, { n: String(failed) }) : c.toast.rescanned,
        c.toast.title,
      );
      await load({ silent: true });
    } catch (err) {
      toast("error", getApiErrorMessage(err, c.toast.rescanFailed), c.toast.title);
    } finally {
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
        {/* Re-scan runs the SCHEDULED checkers early; on cloud they don't exist. */}
        {selfHosted && (
          <button
            type="button"
            onClick={handleRescan}
            disabled={rescanning}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-xl border border-border/60 bg-card px-4 py-2.5 text-[13px] font-medium text-foreground transition-colors hover:bg-muted/50 disabled:opacity-60"
          >
            {rescanning ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <RefreshCw className="size-4" />
            )}
            {rescanning ? c.rescanning : c.rescan}
          </button>
        )}
      </div>

      {/* Open / Resolved. Same geometry as the deployments status switch. */}
      <div className="mb-4 inline-flex items-center gap-1 rounded-xl bg-muted/35 p-1">
        {(["open", "resolved"] as const).map((key) => (
          <button
            key={key}
            type="button"
            onClick={() => setTab(key)}
            className={`inline-flex h-8 items-center rounded-lg px-3.5 text-[12px] font-medium transition-colors ${
              tab === key
                ? "border border-border/60 bg-card text-foreground"
                : "text-muted-foreground hover:bg-background/60 hover:text-foreground"
            }`}
          >
            {c.tabs[key]}
          </button>
        ))}
      </div>

      {/* The Resolved tab is honest about its coverage: only incidents have a lifecycle,
          so its silence is not a claim that nothing else ever broke. Sits above the
          content rather than inside the feed column, because it qualifies the whole tab —
          including the empty card, which is exactly when the caveat matters most. */}
      {!loading && tab === "resolved" && (
        <p className="mb-4 rounded-xl border border-border/50 bg-muted/25 px-4 py-3 text-[12px] leading-relaxed text-muted-foreground">
          {c.resolvedNote}
        </p>
      )}

      {loading ? (
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
      ) : issues.length === 0 ? (
        // Nothing at all for this tab: the empty state stands alone, full width and
        // centred, with no filters or summary rail to frame an absence.
        <EmptyIssues filtered={false} resolved={tab === "resolved"} />
      ) : (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1fr_340px]">
          {/* ── LEFT COLUMN — the feed ── */}
          <div className="min-w-0">
            <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center">
              <div className="relative w-full sm:flex-1 sm:min-w-[220px]">
                <Search className="pointer-events-none absolute start-3.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
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
          </div>

          {/* ── RIGHT COLUMN — sticky summary ── */}
          <div className="space-y-4 lg:sticky lg:top-6 lg:self-start">
            <IssueSummary issues={issues} tab={tab} />
          </div>
        </div>
      )}
    </PageContainer>
  );
}
