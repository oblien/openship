"use client";

/**
 * Update + advisory state for the dashboard (desktop AND self-hosted).
 *
 * Everything is PULLED from the public GitHub repo — the latest release + an
 * advisory manifest pinned to that release's tag (so unreleased commits to main
 * never reach clients). Nothing is pushed to the app. Pure resolution lives in
 * @repo/core; this hook only does I/O + persistence.
 */

import { useCallback, useEffect, useState } from "react";
import {
  RELEASES_LATEST_API,
  advisoryManifestUrl,
  parseManifest,
  resolveUpdateState,
  compareSemver,
  type AdvisoryManifest,
  type LatestRelease,
  type UpdateState,
} from "@repo/core";
import { useDeploymentInfo } from "@/hooks/useDeploymentInfo";
import { getRestApiBaseUrl } from "@/lib/api/urls";

const LS_MUTED = "openship_update_muted";
const LS_DISMISSED = "openship_dismissed_advisories";
const LS_LAST_SEEN = "openship_last_seen_version";

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
    const notif = await cfg.get<boolean | undefined>("updateNotifications").catch(() => undefined);
    const dismissed = (await cfg.get<string[] | undefined>("dismissedAdvisoryIds").catch(() => undefined)) ?? [];
    const lastSeen = (await cfg.get<string | undefined>("lastSeenVersion").catch(() => undefined)) ?? null;
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
    const cur = (await cfg.get<string[] | undefined>("dismissedAdvisoryIds").catch(() => undefined)) ?? [];
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

// Session-scoped cache: fetch GitHub once per app session (GitHub rate-limits
// unauthenticated calls to 60/hr/IP; navigation shouldn't re-hit it).
let remoteCache: Promise<{ latest: LatestRelease | null; manifest: AdvisoryManifest | null }> | null = null;

async function fetchRemote(): Promise<{ latest: LatestRelease | null; manifest: AdvisoryManifest | null }> {
  remoteCache ??= (async () => {
    let latest: LatestRelease | null = null;
    let manifest: AdvisoryManifest | null = null;
    try {
      const res = await fetch(RELEASES_LATEST_API, {
        headers: { Accept: "application/vnd.github+json" },
      });
      if (res.ok) {
        const data = (await res.json()) as { tag_name?: string; body?: string };
        const tag = data.tag_name ?? "";
        if (tag) {
          latest = { version: tag.replace(/^v/, ""), tag, notes: data.body ?? "" };
          // Advisories pinned to the release TAG — main commits never surface.
          try {
            const m = await fetch(advisoryManifestUrl(tag), { headers: { Accept: "application/json" } });
            if (m.ok) manifest = parseManifest(await m.json());
          } catch {
            /* no manifest at this tag → no advisories */
          }
        }
      }
    } catch {
      /* offline / rate-limited → no update info */
    }
    return { latest, manifest };
  })();
  return remoteCache;
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
  } catch {
    return { advisories: [] };
  }
}

const SEVERITY_RANK: Record<string, number> = { critical: 0, recommended: 1, info: 2 };

/** Where the in-app download/install is in its lifecycle (desktop only). */
export type UpdatePhase = "idle" | "downloading" | "installing" | "error";

export interface UseUpdates {
  state: UpdateState | null;
  latest: LatestRelease | null;
  muted: boolean;
  desktop: boolean;
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
  /** Force a fresh GitHub check, bypassing the session cache. */
  refresh: () => void;
}

export function useUpdates(): UseUpdates {
  const deployInfo = useDeploymentInfo();
  const [state, setState] = useState<UpdateState | null>(null);
  const [latest, setLatest] = useState<LatestRelease | null>(null);
  const [muted, setMutedState] = useState(false);
  const [currentVersion, setCurrentVersion] = useState<string | null>(null);
  const [whatsNewVersion, setWhatsNewVersion] = useState<string | null>(null);
  const [updatePhase, setUpdatePhase] = useState<UpdatePhase>("idle");
  const [updateProgress, setUpdateProgress] = useState(0);
  const [updateError, setUpdateError] = useState<string | null>(null);

  const load = useCallback(async () => {
    // Desktop + self-hosted operators control their own install → the GitHub
    // update + advisory feed below. The managed SaaS (cloud) has nothing to
    // self-update, but still surfaces OPERATOR-pushed platform notices (partial
    // outage, maintenance, advisories) through the SAME advisory banner —
    // different source (our /api/notices), identical shape + dismissal rules.
    const desktopOrSelfHosted = isDesktop() || deployInfo?.selfHosted === true;
    if (!desktopOrSelfHosted) {
      if (!deployInfo) return; // deploy info still loading — not yet known to be cloud
      const [prefs, manifest] = await Promise.all([getPrefs(), fetchNotices()]);
      setMutedState(prefs.muted);
      const advisories = manifest.advisories
        .filter((a) => a.severity === "critical" || (!prefs.muted && !prefs.dismissed.includes(a.id)))
        .sort((x, y) => (SEVERITY_RANK[x.severity] ?? 9) - (SEVERITY_RANK[y.severity] ?? 9));
      setState({
        currentVersion: deployInfo.version ?? "",
        latestVersion: null,
        updateAvailable: false,
        advisories,
        changelogUrl: "",
        latestChangelogUrl: "",
      });
      return;
    }

    let current: string | null = null;
    if (isDesktop() && window.desktop?.app) {
      current = await window.desktop.app.version().catch(() => null);
    } else {
      current = deployInfo?.version ?? null;
    }
    if (!current) return;
    setCurrentVersion(current);

    // Also pull operator-pushed platform notices here (not just on cloud) so a
    // self-hosted/desktop operator sees danger/maintenance advisories through
    // the SAME banner. Merge them with the GitHub release advisories.
    const [prefs, remote, notices] = await Promise.all([
      getPrefs(),
      fetchRemote(),
      fetchNotices().catch(() => ({ advisories: [] })),
    ]);
    setMutedState(prefs.muted);
    setLatest(remote.latest);
    const base = resolveUpdateState({
      currentVersion: current,
      latestRelease: remote.latest,
      manifest: remote.manifest,
      dismissed: prefs.dismissed,
      muted: prefs.muted,
    });
    const noticeAdvisories = notices.advisories.filter(
      (a) => a.severity === "critical" || (!prefs.muted && !prefs.dismissed.includes(a.id)),
    );
    const advisories = [...base.advisories, ...noticeAdvisories]
      .filter((a, i, arr) => arr.findIndex((b) => b.id === a.id) === i)
      .sort((x, y) => (SEVERITY_RANK[x.severity] ?? 9) - (SEVERITY_RANK[y.severity] ?? 9));
    setState({ ...base, advisories });

    // "What's new": show once when the running version is newer than the last
    // version we announced. First run (no record) just seeds the baseline.
    if (prefs.lastSeen === null) {
      await persistLastSeen(current);
    } else if (compareSemver(current, prefs.lastSeen) > 0) {
      setWhatsNewVersion(current);
    }
  }, [deployInfo?.version, deployInfo?.selfHosted]);

  useEffect(() => {
    void load();
  }, [load]);

  const dismissAdvisory = useCallback(
    (id: string) => {
      const adv = state?.advisories.find((a) => a.id === id);
      setState((s) => (s ? { ...s, advisories: s.advisories.filter((a) => a.id !== id) } : s));
      // Critical advisories are session-dismiss only (they resurface next launch
      // by design); everything else is remembered so it never nags again.
      if (adv && adv.severity !== "critical") void persistDismissed(id);
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
    void Promise.resolve(u.start())
      .then((ok) => {
        if (ok === false) {
          setUpdatePhase("idle");
          void u.open?.();
        }
      })
      .catch(() => setUpdatePhase("idle"));
  }, []);

  // Force a fresh GitHub check (the session cache is otherwise reused). Also
  // prime the desktop main process so its pending-update state — which the
  // native wizard + install act on — re-checks in lockstep with the renderer,
  // instead of only being set by the boot check.
  const refresh = useCallback(() => {
    remoteCache = null;
    void window.desktop?.updates?.check?.();
    void load();
  }, [load]);

  return {
    state,
    latest,
    muted,
    desktop: isDesktop(),
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
