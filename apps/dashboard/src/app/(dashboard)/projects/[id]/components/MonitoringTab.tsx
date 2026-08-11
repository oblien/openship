"use client";

/**
 * Monitoring tab — hook wiring only.
 *
 * All layout lives in `@/components/monitoring/MonitoringView`, which takes every input
 * as a prop. That split exists so the layout can be rendered from fixtures at
 * `/dev/monitoring` instead of needing a control plane, a deployed project and real
 * traffic to look at.
 *
 * Four sources, deliberately separate — they have genuinely different shapes:
 *   useProjectUsageStream  — SSE, ~5s. Live resources; keeps nothing.
 *   useProjectUsageHistory — sampled 5-minute buckets. What the stream forgets.
 *   useAnalyticsGeo        — per-DAY rollups: countries, visitors, paths, statuses.
 *   useAnalyticsData       — per-MINUTE series for the traffic chart.
 *
 * The geo/overview split isn't arbitrary: countries, visitors and paths are only
 * aggregated daily at the edge (per-minute would multiply its shared-dict cardinality
 * by ~1440 and evict the request counters they annotate), so they can't come from the
 * same fetch as the minute series.
 */

import React, { useMemo, useState } from "react";
import { TrafficChart, TopPaths } from "./general";
import { MonitoringView } from "@/components/monitoring/MonitoringView";
import { useProjectSettings } from "@/context/ProjectSettingsContext";
import { usePlatform } from "@/context/PlatformContext";
import { useI18n, interpolate } from "@/components/i18n-provider";
import { formatCount } from "@/components/monitoring/format";
import { api } from "@/lib/api";
import { endpoints } from "@/lib/api/endpoints";
import {
  useAnalyticsData,
  useAnalyticsGeo,
  useProjectUsageHistory,
} from "@/hooks/useProjectEndpoints";
import { useProjectUsageStream } from "@/hooks/useProjectUsageStream";
import { MOCK_VARIANTS, type MockVariant } from "@/components/monitoring/fixtures";
import { useLiveHits } from "@/components/monitoring/LiveHits";
import { TopPathsEmptyState } from "@/components/monitoring/TopPathsEmptyState";
import { useRequestLogStream } from "@/hooks/useRequestLogStream";

/** Dev builds only — the fixture path must never be reachable in production. */
const PREVIEW_ALLOWED = process.env.NODE_ENV !== "production";

/** The sampler writes a point every 5 min; a 60s poll picks up new buckets soon after
 *  they land so the chart grows without a page reload, at a cost of one small GET/min. */
const USAGE_HISTORY_POLL_MS = 60_000;

/**
 * Initial preview variant from the URL, read from `window.location.search` directly
 * rather than `useSearchParams()`.
 *
 * Deliberate: `useSearchParams` is empty during prerender and only fills after
 * hydration, and this needs to be right on the FIRST client render or the tab
 * flashes its empty state. Reading `window.location` in a lazy `useState`
 * initializer runs exactly once, on the client, after the URL is final.
 *
 * Accepts `?mock=1` (the obvious thing to type) as well as a named variant.
 */
function initialPreview(): MockVariant | null {
  if (!PREVIEW_ALLOWED || typeof window === "undefined") return null;
  const raw = new URLSearchParams(window.location.search).get("mock");
  if (!raw) return null;
  const key = raw === "1" || raw === "true" ? "compose" : raw;
  return key in MOCK_VARIANTS ? (key as MockVariant) : "compose";
}

export const MonitoringTab = () => {
  const { id, projectData, domain } = useProjectSettings();
  // Desktop runs no background sampler, so the persisted history series is always
  // empty there — hide the chart and skip its poll. The live "right now" card still
  // works (it reads the local Docker socket) and is unaffected.
  const { deployMode } = usePlatform();
  const isDesktop = deployMode === "desktop";

  /**
   * Which domain the whole tab is scoped to. `null` = All.
   *
   * Deliberately NOT the context's `selectedDomain`: that one defaults to the project's
   * PRIMARY domain, so a multi-domain project silently showed one domain's traffic as if
   * it were the project's. Local state defaulting to All means the first thing you see is
   * everything, and narrowing is an explicit act.
   *
   * The edge already keys its counters by host, and every analytics endpoint takes
   * `?domain=`, so scoping is a query param — no new server work.
   */
  const { t } = useI18n();
  const [domainScope, setDomainScope] = useState<string | null>(null);
  const domains = useMemo<string[]>(() => {
    const list = (projectData?.domains ?? []) as Array<{ domain?: string }>;
    return Array.from(
      new Set(list.map((d) => d.domain?.trim()).filter((d): d is string => !!d)),
    );
  }, [projectData?.domains]);
  // Primary-first, so the live-stream cap (MAX_STREAMS) drops the least-used tail, not the
  // domain that matters most. Mirrors ServerLogs so the map's default All scope fans out
  // across every route instead of tailing only the primary — a busy secondary domain must
  // still ripple when the primary is idle.
  const streamDomains = useMemo(
    () => (domain && domains.includes(domain) ? [domain, ...domains.filter((d) => d !== domain)] : domains),
    [domains, domain],
  );

  /**
   * Fixture preview. Starts from the URL, but is also toggleable from the empty
   * state — a query param is easy to lose to a navigation and easy to mistype, and
   * "I can't see the populated layout" was the whole problem.
   */
  const [mock, setMock] = React.useState<MockVariant | null>(initialPreview);

  // Atomic fetches — own state, own loading, no context coupling. Backed by
  // module-level caches shared with OverviewTab, so both tabs make one request each.
  // Hooks always run — calling them conditionally would break the hook order. The
  // mock swaps their RESULTS, and passes `null` id so no request is made.
  const liveId = mock ? null : id;
  const { data: liveAnalytics, isLoading: isLoadingAnalytics } = useAnalyticsData(liveId, domainScope);
  const { data: liveGeo, isLoading: isLoadingGeo } = useAnalyticsGeo(liveId, domainScope);
  const { usage: liveUsage, isConnected, error: usageError, reconnect } = useProjectUsageStream(liveId);

  /** Scope for the history read. Held here rather than in the view because it keys the
   *  fetch — the view raises changes through `onServiceKeyChange`. */
  const [serviceKey, setServiceKey] = React.useState<string | null>(null);
  const { data: liveHistory, isLoading: isLoadingHistory } = useProjectUsageHistory(
    liveId,
    serviceKey,
    isDesktop ? undefined : USAGE_HISTORY_POLL_MS,
  );

  /**
   * Live hits on the map, off by default.
   *
   * Wired HERE rather than inside the map because opening the stream needs the projectId
   * and the cloud-vs-self-hosted token branch, and because the view has to stay renderable
   * from fixtures with no network at all.
   *
   * Same feed as the Logs tab (`useRequestLogStream`), so a ripple corresponds to a row
   * you can go and read there — and the country on it is the one the edge resolved, which
   * behind Cloudflare is the visitor rather than the PoP.
   */
  const [liveOn, setLiveOn] = useState(false);
  const hits = useLiveHits();
  const [liveStatus, setLiveStatus] = useState<string | null>(null);
  useRequestLogStream({
    projectId: id,
    domain: domainScope,
    // When no single domain is scoped (default All), fan out across every route so the map
    // aggregates all domains combined; a scoped `domainScope` still wins over this list.
    domains: streamDomains,
    // Never while a fixture is driving the page: the preview must not open a socket, and
    // real ripples over mock aggregates would be two different projects on one map. The
    // preview gets simulated hits instead — see below.
    enabled: liveOn && !mock,
    onEntry: (e) => hits.push({ country: e.country, path: e.path, statusCode: e.statusCode }),
    onStatus: (st) => setLiveStatus(st.state === "error" || st.state === "unavailable" ? st.state : null),
  });


  // Turning it off, or changing which domain is in scope, clears the counter and the feed —
  // carrying a total across a scope change would attribute one domain's hits to another.
  // Same reason as above: depend on the stable `reset`, not on the whole object. As a prop
  // on VisitorMap, an unstable `setLive` also re-rendered the map on every tick.
  const resetHits = hits.reset;
  const setLive = React.useCallback(
    (on: boolean) => {
      resetHits();
      setLiveOn(on);
    },
    [resetHits],
  );
  React.useEffect(() => {
    resetHits();
  }, [domainScope, resetHits]);

  /**
   * Memoized on `mock`, which matters for more than tidiness.
   *
   * Rebuilding it every render gives `fixture.geo` a new identity each time, and the
   * simulated-hits effect below depends on it — so every simulated hit re-rendered, which
   * re-created the fixture, which tore down and re-armed the interval. It would never have
   * settled into a steady tick. Memoizing also stops the whole fixture set being
   * regenerated on every keystroke elsewhere in the tab.
   */
  const fixture = useMemo(() => (mock ? MOCK_VARIANTS[mock]() : null), [mock]);
  const analytics = fixture ? fixture.analytics : liveAnalytics;
  const geo = fixture ? fixture.geo : liveGeo;
  const usage = fixture ? fixture.usage : liveUsage;
  const history = fixture ? fixture.history : liveHistory;

  /**
   * Simulated hits for the fixture preview.
   *
   * Without this, turning Live on in sample mode did nothing at all — the switch lit up and
   * the map stayed still, which reads as a broken feature rather than as "there is no real
   * stream here". Since the preview exists to show what the finished thing looks like, the
   * animation is part of what it has to show.
   *
   * Sampled from the FIXTURE's own country counts, weighted, so the ripples land where that
   * fixture's traffic actually is — the US flashes far more often than Italy, and the map
   * agrees with the legend beneath it. Paths and statuses are drawn from the same fixture
   * for the same reason.
   */
  const mockGeoData = fixture?.geo;
  React.useEffect(() => {
    if (!liveOn || !mock || !mockGeoData) return;
    const countries = (mockGeoData.countries ?? []).filter((c) => c.count > 0);
    if (countries.length === 0) return;
    // Cumulative weights, so one uniform draw picks a country in proportion to its traffic.
    const cumulative: Array<{ code: string; upto: number }> = [];
    let running = 0;
    for (const c of countries) {
      running += c.count;
      cumulative.push({ code: c.code, upto: running });
    }
    const paths = (mockGeoData.topPaths ?? []).map((p) => p.path);
    const codes = Object.keys(mockGeoData.statuses ?? {}).filter((c) => Number(c) >= 200);

    const emit = () => {
      const r = Math.random() * running;
      hits.push({
        country: cumulative.find((c) => r <= c.upto)?.code,
        path: paths.length ? paths[Math.floor(Math.random() * paths.length)] : "/",
        // Weighted toward 2xx the way real traffic is, rather than uniform across codes —
        // a preview where a third of the hits are 500s misrepresents the feature.
        statusCode:
          Math.random() < 0.9 || codes.length === 0
            ? 200
            : Number(codes[Math.floor(Math.random() * codes.length)]),
      });
    };

    /*
     * Rate VARIES, in bursts.
     *
     * A metronome at a fixed interval would show one pace and hide the fact that the
     * display adapts to the arrival rate at all. Real traffic is bursty, and the preview
     * exists to show what the finished thing looks like — including how it behaves when a
     * spike arrives. Alternates roughly: ~2s quiet (a few hits/sec), then ~3s busy
     * (tens/sec), which crosses both ends of the pacing curve in useLiveHits.
     */
    let stop = false;
    let phaseEndsAt = 0;
    let busy = false;
    const loop = () => {
      if (stop) return;
      const now = performance.now();
      if (now >= phaseEndsAt) {
        busy = !busy;
        phaseEndsAt = now + (busy ? 3000 : 2000);
      }
      const perTick = busy ? 6 : 1;
      for (let i = 0; i < perTick; i++) emit();
      window.setTimeout(loop, busy ? 45 : 320);
    };
    loop();
    return () => {
      stop = true;
    };
    // `hits.push` and `hits.reset`, NOT `hits`.
    //
    // useLiveHits returns a fresh object every render (it has to — `ripples` and `feed`
    // are state). Depending on the object meant this effect tore down and re-armed the
    // interval on EVERY render, and since each hit causes a render, the timer restarted
    // before it could fire again. Whenever renders outpaced the 200ms interval — which the
    // real tab does, with the log stream and its status updating alongside — the generator
    // starved completely and the first toggle produced nothing. `push` and `reset` are
    // useCallback([]) and stable for the component's life.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveOn, mock, mockGeoData, hits.push]);

  /**
   * Turn per-path collection on or off.
   *
   * Optimistic on the client but authoritative on the server: the API persists the row
   * THEN pushes to the edge's shared dict, and every route apply re-pushes from the row —
   * so a failed edge push self-heals rather than leaving the two disagreeing. The local
   * flag is only so the card flips immediately instead of after the next geo refetch.
   */
  const [pathsOverride, setPathsOverride] = React.useState<boolean | null>(null);
  const [pathsBusy, setPathsBusy] = React.useState(false);
  const setPathsCollection = React.useCallback(
    async (enabled: boolean) => {
      setPathsBusy(true);
      try {
        await api.post(`${endpoints.analytics.pathsCollection}/${encodeURIComponent(id)}`, {
          enabled,
        });
        setPathsOverride(enabled);
      } catch {
        // Leave the card as it was — pretending it flipped would misreport what the edge
        // is actually doing to every request.
      } finally {
        setPathsBusy(false);
      }
    },
    [id],
  );

  // Cloud reports pathsEnabled: true unconditionally — Oblien's edge aggregates paths
  // regardless, so there is nothing to switch and no button should be offered.
  const canTogglePaths = geo?.source === "self-hosted" && !mock;
  const pathsEnabled = pathsOverride ?? geo?.pathsEnabled ?? false;

  // Share is against the summed PATH hits, not totalRequests: static assets are
  // excluded from path counting, so dividing by total requests would make every share
  // look artificially small.
  const topPaths = React.useMemo(() => {
    const list = geo?.topPaths ?? [];
    const total = list.reduce((sum, p) => sum + p.count, 0);
    return list.map((p) => ({
      ...p,
      percentage: total > 0 ? ((p.count / total) * 100).toFixed(1) : "0.0",
    }));
  }, [geo]);

  const dateRange = analytics
    ? `${new Date(analytics.summary.firstRequest).toLocaleDateString()} - ${new Date(analytics.summary.lastRequest).toLocaleDateString()}`
    : undefined;

  return (
    <MonitoringView
      analytics={analytics}
      isLoadingAnalytics={fixture ? false : isLoadingAnalytics}
      geo={geo}
      isLoadingGeo={fixture ? false : isLoadingGeo}
      history={history}
      isLoadingHistory={fixture ? false : isLoadingHistory}
      // Fixtures always show the populated layout; real data hides the chart on desktop
      // where nothing is ever sampled.
      historySupported={fixture ? true : !isDesktop}
      usage={usage}
      isUsageConnected={fixture ? true : isConnected}
      usageError={fixture ? null : usageError}
      onReconnectUsage={reconnect}
      serviceKey={serviceKey}
      onServiceKeyChange={setServiceKey}
      // Shown on the traffic block's fold line, so a collapsed block still states the
      // number and only the shape of the curve costs a click.
      trafficSummary={
        analytics
          ? interpolate(t.projects.monitoring.trafficSummary, {
              count: formatCount(analytics.summary.totalRequests),
            })
          : undefined
      }
      trafficChart={
        <TrafficChart
          trafficData={analytics?.trafficByHour ?? []}
          isLoading={fixture ? false : isLoadingAnalytics}
          dateRange={dateRange}
          totalRequests={analytics?.summary.totalRequests}
        />
      }
      topPaths={
        // Three states, and they must not collapse into one: collection OFF (offer to turn
        // it on), ON with data, and ON with nothing yet (the card renders its own zero
        // state). Before `pathsEnabled` existed, off and on-but-empty looked identical.
        pathsEnabled ? (
          topPaths.length > 0 ? (
            <TopPaths
              paths={topPaths}
              onDisable={canTogglePaths ? () => setPathsCollection(false) : undefined}
              isBusy={pathsBusy}
            />
          ) : null
        ) : canTogglePaths ? (
          <TopPathsEmptyState onEnable={() => setPathsCollection(true)} isBusy={pathsBusy} />
        ) : null
      }
      previewVariant={mock}
      onPreviewChange={PREVIEW_ALLOWED ? setMock : undefined}
      domains={domains}
      domainScope={domainScope}
      live={{
        enabled: liveOn,
        onEnabledChange: setLive,
        total: hits.total,
        ripples: hits.ripples,
        feed: hits.feed,
        status: liveStatus,
      }}
      onDomainScopeChange={setDomainScope}
    />
  );
};
