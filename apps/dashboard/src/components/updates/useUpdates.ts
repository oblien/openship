"use client";

/**
 * Update + advisory state for the dashboard (desktop AND self-hosted).
 *
 * The backend caches tagged releases and the separately signed security feed.
 * Nothing in either feed executes remote instructions. Pure resolution lives
 * in @repo/core; this hook only does I/O + preference persistence.
 */

import { reportCaughtError as observeCaughtError } from "@repo/core/diagnostics";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  parseManifest,
  resolveUpdateState,
  matchAdvisories,
  type AdvisoryMode,
  compareSemver,
  type AdvisoryManifest,
  type LatestRelease,
  type Advisory,
  type UpdateState,
} from "@repo/core";
import { useDeploymentInfo } from "@/hooks/useDeploymentInfo";
import type { AdvisoryFeedResult, SecurityOverview } from "@repo/contracts";
import { useCloudResourceKey } from "@/context/CloudResourceContext";
import { getApiRequestScopeVersion } from "@/lib/api/client";
import { updatesApi } from "@/lib/api/updates";
import { getRestApiBaseUrl } from "@/lib/api/urls";

const LS_MUTED = "openship_update_muted";
const LS_DISMISSED = "openship_dismissed_advisories";
const LS_LAST_SEEN = "openship_last_seen_version";

// The header and Settings can both consume this hook. A dismissal belongs to
// the app session, so a remount or an in-flight refresh must not undo it.
const EMPTY_DISMISSALS: ReadonlySet<string> = new Set();
let sessionDismissals = EMPTY_DISMISSALS;
const dismissalListeners = new Set<() => void>();
const getSessionDismissals = () => sessionDismissals;
const getServerDismissals = () => EMPTY_DISMISSALS;
function subscribeDismissals(listener: () => void) {
  dismissalListeners.add(listener);
  return () => {
    dismissalListeners.delete(listener);
  };
}

function isDesktop(): boolean {
  return typeof window !== "undefined" && !!window.desktop?.isDesktop;
}

interface Prefs {
  muted: boolean;
  dismissed: string[];
  lastSeen: string | null;
}

/** Prefs live in the desktop config store (native app) or localStorage (web). */
async function getPrefs(): Promise<Prefs> {
  const cfg = isDesktop() ? window.desktop?.config : undefined;
  if (cfg) {
    const notif = await cfg
      .get<boolean | undefined>("updateNotifications")
      .catch((diagnosticFailure) => {
        observeCaughtError(diagnosticFailure, "dashboard/components/updates/useUpdates");
        return undefined;
      });
    const dismissed =
      (await cfg.get<string[] | undefined>("dismissedAdvisoryIds").catch((diagnosticFailure) => {
        observeCaughtError(diagnosticFailure, "dashboard/components/updates/useUpdates");
        return undefined;
      })) ?? [];
    const lastSeen =
      (await cfg.get<string | undefined>("lastSeenVersion").catch((diagnosticFailure) => {
        observeCaughtError(diagnosticFailure, "dashboard/components/updates/useUpdates");
        return undefined;
      })) ?? null;
    return { muted: notif === false, dismissed, lastSeen };
  }
  let dismissed: string[] = [];
  try {
    dismissed = JSON.parse(localStorage.getItem(LS_DISMISSED) ?? "[]");
  } catch {
    dismissed = [];
  }
  return {
    muted: localStorage.getItem(LS_MUTED) === "1",
    dismissed,
    lastSeen: localStorage.getItem(LS_LAST_SEEN),
  };
}

async function persistMuted(muted: boolean): Promise<void> {
  const cfg = isDesktop() ? window.desktop?.config : undefined;
  if (cfg) await cfg.set("updateNotifications", !muted);
  else localStorage.setItem(LS_MUTED, muted ? "1" : "0");
}

async function persistDismissed(id: string): Promise<void> {
  const cfg = isDesktop() ? window.desktop?.config : undefined;
  if (cfg) {
    const cur =
      (await cfg.get<string[] | undefined>("dismissedAdvisoryIds").catch((diagnosticFailure) => {
        observeCaughtError(diagnosticFailure, "dashboard/components/updates/useUpdates");
        return undefined;
      })) ?? [];
    if (!cur.includes(id)) await cfg.set("dismissedAdvisoryIds", [...cur, id]);
    return;
  }
  let cur: string[] = [];
  try {
    cur = JSON.parse(localStorage.getItem(LS_DISMISSED) ?? "[]");
  } catch {
    cur = [];
  }
  if (!cur.includes(id)) localStorage.setItem(LS_DISMISSED, JSON.stringify([...cur, id]));
}

async function persistLastSeen(version: string): Promise<void> {
  const cfg = isDesktop() ? window.desktop?.config : undefined;
  if (cfg) await cfg.set("lastSeenVersion", version);
  else localStorage.setItem(LS_LAST_SEEN, version);
}

// Public feed polling is shared on the backend. This response also contains
// private workload matches: coalesce ONLY within the current account/workspace.
let remoteCache: {
  scope: string;
  promise: Promise<AdvisoryFeedResult | null>;
  checkedAt: number;
  pending: boolean;
} | null = null;
function fetchRemote(scope: string): Promise<AdvisoryFeedResult | null> {
  if (
    remoteCache?.scope === scope &&
    (remoteCache.pending || Date.now() - remoteCache.checkedAt < 5 * 60_000)
  )
    return remoteCache.promise;
  const previous = remoteCache?.scope === scope ? remoteCache.promise : null;
  const promise = updatesApi
    .advisories()
    .then(({ data }) => data)
    .catch(async (error) => {
      observeCaughtError(error, "dashboard/components/updates/useUpdates");
      const cached = await previous;
      if (!cached) return null;
      // Keep a known warning visible offline, with refresh actions disabled.
      return {
        ...cached,
        stale: true,
        overview: cached.overview && {
          ...cached.overview,
          projects: cached.overview.projects.map((project) => ({
            ...project,
            feedStale: true,
            findings: project.findings.map((finding) => ({ ...finding, canRefresh: false })),
          })),
        },
      };
    })
    .finally(() => {
      entry.pending = false;
      entry.checkedAt = Date.now();
    });
  const entry = { scope, checkedAt: 0, pending: true, promise };
  remoteCache = entry;
  return promise;
}

const refreshListeners = new Set<(resourceKey: string) => void>();
const queuedRefreshes = new Set<string>();
function refreshConsumers(resourceKey: string) {
  if (queuedRefreshes.has(resourceKey)) return;
  queuedRefreshes.add(resourceKey);
  queueMicrotask(() => {
    queuedRefreshes.delete(resourceKey);
    const scope = `${resourceKey}:${getApiRequestScopeVersion()}`;
    // Consent/check mutations must supersede reads started before the mutation.
    // Keep the old snapshot only as an offline warning fallback.
    if (remoteCache?.scope === scope)
      remoteCache = { ...remoteCache, pending: false, checkedAt: 0 };
    for (const listener of refreshListeners) listener(resourceKey);
  });
}

const deploymentChecks = new Map<string, Promise<void>>();
/** A successful deploy is a reason to recheck, never proof that an advisory is fixed. */
export function refreshSecurityAfterDeployment(
  resourceKey: string,
  projectId: string,
  deploymentId: string,
): Promise<void> {
  const version = getApiRequestScopeVersion();
  const scope = `${resourceKey}:${version}`;
  if (remoteCache?.scope !== scope) return Promise.resolve();
  const key = `${scope}:${projectId}:${deploymentId}`;
  const pending = deploymentChecks.get(key);
  if (pending) return pending;
  const snapshot = remoteCache.promise;
  const current = () => version === getApiRequestScopeVersion() && remoteCache?.scope === scope;
  const task = (async () => {
    const feed = await snapshot;
    if (!current()) return;
    const project = feed?.overview.projects.find((item) => item.projectId === projectId);
    if (!project || (!project.findings.length && project.checkedAt && !project.autoRefresh)) return;
    if (project.deploymentId === deploymentId && project.checkedAt) return;
    // This read reuses the backend's deployment-keyed inventory. Replays of a
    // completed build do not rerun version commands on the same container.
    const { data } = await updatesApi.security(projectId);
    if (current() && data.projectId === projectId && data.deploymentId === deploymentId)
      refreshConsumers(resourceKey);
  })()
    .catch((error) => {
      observeCaughtError(error, "dashboard/components/updates/deployment-security-check");
    })
    .finally(() => {
      deploymentChecks.delete(key);
    });
  deploymentChecks.set(key, task);
  return task;
}

const EMPTY_OVERVIEW: SecurityOverview = { projects: [], pendingProjects: 0, unknownProjects: 0 };
interface RuntimeAdvisory extends Advisory {
  projects: SecurityOverview["projects"];
}
function runtimeNotices(overview: SecurityOverview, scope: string): RuntimeAdvisory[] {
  const notices = new Map<string, RuntimeAdvisory>();
  for (const project of overview.projects)
    for (const finding of project.findings) {
      const id = `runtime:${scope}:${finding.id}:${finding.revision}`;
      const existing = notices.get(id);
      if (existing) {
        const affected = existing.projects.find((item) => item.projectId === project.projectId);
        if (affected) affected.findings.push(finding);
        else existing.projects.push({ ...project, findings: [finding] });
        continue;
      }
      notices.set(id, {
        id,
        projects: [{ ...project, findings: [finding] }],
        title: finding.title,
        message: finding.message,
        severity:
          finding.severity === "critical" || finding.severity === "high"
            ? "critical"
            : "recommended",
        announce: true,
        affects: "*",
        action: { kind: "open-url", label: "Read advisory", url: finding.url },
      });
    }
  return [...notices.values()];
}

// The SaaS advisory source: operator-pushed platform notices from our own API
// (partial outage, maintenance, upgrade advisories), returned in the SAME
// manifest shape as the GitHub advisory feed so the shared banner renders both
// identically. Same-origin on the SaaS; never throws (offline → no notices).
async function fetchNotices(): Promise<AdvisoryManifest> {
  try {
    const res = await fetch(`${getRestApiBaseUrl()}/notices`, {
      headers: { Accept: "application/json" },
      credentials: "include",
    });
    if (!res.ok) return { advisories: [] };
    return parseManifest(await res.json());
  } catch (diagnosticFailure) {
    observeCaughtError(diagnosticFailure, "dashboard/components/updates/useUpdates");
    return { advisories: [] };
  }
}

const SEVERITY_RANK: Record<string, number> = { critical: 0, recommended: 1, info: 2 };

/** Where the in-app download/install is in its lifecycle (desktop only). */
export type UpdatePhase = "idle" | "downloading" | "installing" | "error";

export interface UseUpdates {
  state: UpdateState | null;
  latest: LatestRelease | null;
  securityOverview: SecurityOverview;
  runtimeAdvisories: RuntimeAdvisory[];
  /** null while loading; false when no trustworthy snapshot is available. */
  securityAvailable: boolean | null;
  muted: boolean;
  desktop: boolean;
  /**
   * Which install this is — the same value advisories are filtered on. Surfaces
   * need it to offer the RIGHT action: desktop drives the native updater,
   * self-hosted has to run the CLI on the host, cloud has nothing to update.
   * "cloud" until deployment info loads, so nothing suggests a wrong action.
   */
  mode: AdvisoryMode;
  /** The version to celebrate in a "what's new" notice, or null. */
  whatsNewVersion: string | null;
  dismissAdvisory: (id: string) => void;
  dismissWhatsNew: () => void;
  setMuted: (muted: boolean) => void;
  /** Desktop: open the native updater window for the pending update. */
  startDesktopUpdate: () => void;
  /** Desktop: start the download in-place and stream progress into the header
   *  (no native modal). Falls back to the native offer if nothing is pending. */
  beginUpdate: () => void;
  /** Download/install lifecycle for the inline header progress bar. */
  updatePhase: UpdatePhase;
  /** Download fraction 0..1 (meaningful while `updatePhase === "downloading"`). */
  updateProgress: number;
  /** Error message when `updatePhase === "error"`. */
  updateError: string | null;
  reload: () => void;
  /** Refresh from the backend, preserving its GitHub cadence and backoff. */
  refresh: () => void;
}

export function useUpdates(): UseUpdates {
  const deployInfo = useDeploymentInfo();
  const dismissed = useSyncExternalStore(
    subscribeDismissals,
    getSessionDismissals,
    getServerDismissals,
  );
  const resourceKey = useCloudResourceKey();
  const scope = `${resourceKey}:${getApiRequestScopeVersion()}`;
  const identity = useRef(resourceKey);
  identity.current = resourceKey;
  const generation = useRef(0);
  const [result, setResult] = useState<{
    scope: string;
    state: UpdateState;
    latest: LatestRelease | null;
    overview: SecurityOverview;
    securityAvailable: boolean;
  } | null>(null);
  const currentResult = result?.scope === scope ? result : null;
  const state = currentResult?.state ?? null;
  const latest = currentResult?.latest ?? null;
  const securityOverview = currentResult?.overview ?? EMPTY_OVERVIEW;
  const runtimeAdvisories = runtimeNotices(securityOverview, resourceKey);
  const [muted, setMutedState] = useState(false);
  const [currentVersion, setCurrentVersion] = useState<string | null>(null);
  const [whatsNewVersion, setWhatsNewVersion] = useState<string | null>(null);
  const [updatePhase, setUpdatePhase] = useState<UpdatePhase>("idle");
  const [updateProgress, setUpdateProgress] = useState(0);
  const [updateError, setUpdateError] = useState<string | null>(null);

  // Which install is this? Mode-targeted advisories are filtered on it, so a
  // desktop-installer notice never reaches a VPS dashboard and an edge/compose
  // notice never reaches the desktop app. Desktop wins over selfHosted: the
  // Electron app reports selfHosted too, but it updates through its own
  // installer, not by the operator upgrading a server.
  const mode: AdvisoryMode = isDesktop()
    ? "desktop"
    : deployInfo?.selfHosted
      ? "selfhosted"
      : "cloud";

  const load = useCallback(
    async () => {
      if (!deployInfo && !isDesktop()) return;
      const request = ++generation.current;
      const requestScope = getApiRequestScopeVersion();
      const requestKey = `${resourceKey}:${requestScope}`;
      const isCurrent = () =>
        request === generation.current &&
        identity.current === resourceKey &&
        requestScope === getApiRequestScopeVersion();
      const current =
        isDesktop() && window.desktop?.app
          ? await window.desktop.app.version().catch((error) => {
              observeCaughtError(error, "dashboard/components/updates/useUpdates");
              return null;
            })
          : (deployInfo?.version ?? null);
      if (!current || !isCurrent()) return;
      const [prefs, remote, notices] = await Promise.all([
        getPrefs(),
        fetchRemote(requestKey),
        fetchNotices(),
      ]);
      if (!isCurrent()) return;
      setCurrentVersion(current);
      setMutedState(prefs.muted);
      // Managed Cloud never offers a control-plane update. Its customer workloads
      // still receive the same verified runtime notices as self-hosted and Desktop.
      const platformNotices: Advisory[] =
        mode === "cloud"
          ? []
          : (remote?.security?.advisories ?? []).flatMap((notice) =>
              notice.targets
                .filter((target) => target.kind === "platform")
                .map((target) => ({
                  id: `security:${notice.id}:${notice.revision}`,
                  title: notice.title,
                  message: notice.message,
                  severity:
                    notice.severity === "critical" || notice.severity === "high"
                      ? "critical"
                      : "recommended",
                  announce: true,
                  affects: target.affected,
                  action: { kind: "open-url", label: "Read advisory", url: notice.url },
                })),
            );
      const base = resolveUpdateState({
        currentVersion: current,
        latestRelease: mode === "cloud" ? null : (remote?.release.latest ?? null),
        manifest: {
          advisories:
            mode === "cloud"
              ? []
              : [...(remote?.release.manifest?.advisories ?? []), ...platformNotices],
        },
        dismissed: prefs.dismissed,
        muted: prefs.muted,
        mode,
      });
      const overview = remote?.overview ?? EMPTY_OVERVIEW;
      // Runtime matches are already evaluated by the shared backend matcher;
      // comparing them against the Openship version would hide affected apps.
      const advisories = [
        ...base.advisories,
        ...matchAdvisories(current, notices, mode),
        ...runtimeNotices(overview, resourceKey),
      ]
        .filter(
          (a) => a.severity === "critical" || (!prefs.muted && !prefs.dismissed.includes(a.id)),
        )
        .filter((a, i, all) => all.findIndex((b) => b.id === a.id) === i)
        .sort((a, b) => (SEVERITY_RANK[a.severity] ?? 9) - (SEVERITY_RANK[b.severity] ?? 9));
      setResult({
        scope: requestKey,
        state: { ...base, advisories },
        latest: mode === "cloud" ? null : (remote?.release.latest ?? null),
        overview,
        securityAvailable: remote !== null,
      });
      if (mode !== "cloud") {
        if (prefs.lastSeen === null) await persistLastSeen(current);
        else if (compareSemver(current, prefs.lastSeen) > 0) setWhatsNewVersion(current);
      }
    },
    [deployInfo?.version, deployInfo?.selfHosted, mode, resourceKey],
  );

  useEffect(() => {
    const onRefresh = (key: string) => {
      if (key === resourceKey) void load();
    };
    refreshListeners.add(onRefresh);
    void load();
    const timer = setInterval(() => {
      if (document.visibilityState !== "hidden") void load();
    }, 5 * 60_000);
    return () => {
      refreshListeners.delete(onRefresh);
      generation.current++;
      clearInterval(timer);
    };
  }, [load, resourceKey]);

  const dismissAdvisory = useCallback(
    (id: string) => {
      const adv = state?.advisories.find((a) => a.id === id);
      if (!adv || sessionDismissals.has(id)) return;
      sessionDismissals = new Set([...sessionDismissals, id]);
      for (const listener of dismissalListeners) listener();
      // Critical advisories are session-dismiss only (they resurface next launch
      // by design); everything else is remembered so it never nags again.
      // Keep the session choice even if the persistent store is unavailable.
      if (adv.severity !== "critical")
        void persistDismissed(id).catch((diagnosticFailure) => {
          observeCaughtError(diagnosticFailure, "dashboard/components/updates/useUpdates");
        });
    },
    [state],
  );

  const dismissWhatsNew = useCallback(() => {
    if (currentVersion) void persistLastSeen(currentVersion);
    setWhatsNewVersion(null);
  }, [currentVersion]);

  const setMuted = useCallback(
    (m: boolean) => {
      setMutedState(m);
      void persistMuted(m).then(() => load());
    },
    [load],
  );

  // Stream the native updater's download/install progress into the header bar.
  // The main process broadcasts these to the main window once a download starts
  // (from the native modal's "Update now" OR an in-place beginUpdate()).
  useEffect(() => {
    const u = typeof window !== "undefined" ? window.desktop?.updates : undefined;
    if (!u) return;
    const offProgress = u.onProgress?.((f) => {
      setUpdatePhase("downloading");
      setUpdateProgress(f);
    });
    const offDone = u.onDone?.(() => {
      setUpdatePhase("installing");
      setUpdateProgress(1);
    });
    const offError = u.onError?.((msg) => {
      setUpdatePhase("error");
      setUpdateError(msg || null);
    });
    return () => {
      offProgress?.();
      offDone?.();
      offError?.();
    };
  }, []);

  const startDesktopUpdate = useCallback(() => {
    void window.desktop?.updates?.open?.();
  }, []);

  // Download in-place: show the inline bar immediately, then kick the main
  // process. If nothing is pending there (start() → false), drop the inline
  // state and fall back to the native offer so the click is never a dead end.
  const beginUpdate = useCallback(() => {
    const u = typeof window !== "undefined" ? window.desktop?.updates : undefined;
    if (!u?.start) return;
    setUpdateError(null);
    setUpdateProgress(0);
    setUpdatePhase("downloading");
    void Promise.resolve(u.check?.(true))
      .then(() => u.start())
      .then((ok) => {
        if (ok === false) {
          setUpdatePhase("idle");
          void u.open?.();
        }
      })
      .catch((diagnosticFailure) => {
        observeCaughtError(diagnosticFailure, "dashboard/components/updates/useUpdates");
        return setUpdatePhase("idle");
      });
  }, []);

  // Concurrent consumers join the backend read. The native installer separately
  // verifies the matching release artifact before installing it.
  const refresh = useCallback(() => {
    refreshConsumers(resourceKey);
  }, [resourceKey]);

  return {
    state: state
      ? { ...state, advisories: state.advisories.filter((a) => !dismissed.has(a.id)) }
      : null,
    latest,
    securityOverview,
    securityAvailable: currentResult?.securityAvailable ?? null,
    runtimeAdvisories,
    muted,
    desktop: isDesktop(),
    mode,
    whatsNewVersion,
    dismissAdvisory,
    dismissWhatsNew,
    setMuted,
    startDesktopUpdate,
    beginUpdate,
    updatePhase,
    updateProgress,
    updateError,
    reload: load,
    refresh,
  };
}
