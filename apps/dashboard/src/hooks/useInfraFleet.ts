"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { systemApi, type ServerContainerGroup } from "@/lib/api/system";
import type { ContainerApplyIntent } from "@/lib/api/system";
import { infraScanStale, markInfraScanned } from "@/lib/infra-autoscan";

/** What one server's managed containers add up to, for chips and filtering. */
export interface InfraServerSummary {
  /** Down components that still exist (a one-click restart), by component. */
  down: ("edge" | "mail")[];
  /** Components running an older image than we pin. */
  updates: number;
  /** Down but gone — the fix is the setup path, so it's not bulk-restartable. */
  missing: ("edge" | "mail")[];
  /** No edge row at all AND projects deployed here → the edge needs installing. */
  edgeAbsent: boolean;
}

export type InfraSegment = "all" | "attention" | "updates" | "healthy";

/** 5 s × 60 ≈ 5 min of settle-watching per apply — an image swap is far quicker. */
const POLL_BUDGET = 60;

/**
 * Fleet-wide managed-container state for the Servers tab: the cached grouped view,
 * a per-server summary, the counts the header/segments render, and the two bulk
 * actions. Detect (Scan) and apply (Update all / Restart stopped) both go through
 * the same endpoints the per-server rows use, so nothing here re-implements a fix —
 * an apply started in bulk is the same replayable session a row click re-attaches to.
 *
 * `enabled` is the self-hosted/desktop gate: on cloud these endpoints are
 * `assertNotCloud`, so we never call them.
 */
export function useInfraFleet(enabled: boolean) {
  const [groups, setGroups] = useState<ServerContainerGroup[] | null>(null);
  const [scanning, setScanning] = useState(false);
  const [applying, setApplying] = useState<ContainerApplyIntent | null>(null);

  const load = useCallback(async () => {
    if (!enabled) return;
    try {
      setGroups(await systemApi.listAllContainers());
    } catch {
      setGroups([]); // cloud / read error → the card simply doesn't render
    }
  }, [enabled]);

  const scan = useCallback(async () => {
    if (!enabled) return;
    setScanning(true);
    try {
      setGroups(await systemApi.scanAllContainers());
      markInfraScanned();
    } catch {
      // Best-effort: one unreachable box shouldn't wipe the cached view.
    } finally {
      setScanning(false);
    }
  }, [enabled]);

  // Read the cache immediately, then — when auto-scan is on and the shared
  // throttle window has lapsed — refresh it with ONE detect-only sweep. The ref
  // holds under StrictMode's double-mount; the localStorage stamp is shared with
  // the home page so opening both doesn't probe twice.
  const autoScanRan = useRef(false);
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    void (async () => {
      await load();
      if (cancelled || autoScanRan.current || !infraScanStale()) return;
      const on = await systemApi.getInfraAutoScan().catch(() => false);
      if (cancelled || !on) return;
      autoScanRan.current = true;
      markInfraScanned();
      setScanning(true);
      try {
        const fresh = await systemApi.scanAllContainers();
        if (!cancelled) setGroups(fresh);
      } catch {
        /* cached view stays */
      } finally {
        if (!cancelled) setScanning(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [enabled, load]);

  // While any apply is in flight (started here or from a server's own page), re-read
  // the cached view every few seconds so the counts settle on their own. Chains off
  // `groups`, so it stops as soon as nothing is in progress — no interval to clear.
  //
  // Bounded, because `latestInProgress` is cleared by the apply's own `finally`: if
  // the API restarts mid-swap the flag is stuck true forever, and an unbounded chain
  // would poll an open tab for the rest of the session. After the budget the counts
  // just need a manual Scan.
  const polls = useRef(0);
  const inFlight = (groups ?? []).some((g) => g.components.some((r) => r.latestInProgress));
  useEffect(() => {
    if (!inFlight) polls.current = 0;
  }, [inFlight]);
  useEffect(() => {
    if (!enabled || !inFlight || polls.current >= POLL_BUDGET) return;
    const timer = setTimeout(() => {
      polls.current += 1;
      void load();
    }, 5000);
    return () => clearTimeout(timer);
  }, [enabled, inFlight, groups, load]);

  /** Per-server summary keyed by server id. */
  const summaries = useMemo(() => {
    const map = new Map<string, InfraServerSummary>();
    for (const g of groups ?? []) {
      const down: ("edge" | "mail")[] = [];
      const missing: ("edge" | "mail")[] = [];
      let updates = 0;
      for (const r of g.components) {
        if (r.behind) updates++;
        else if (r.detail?.down) (r.detail.containerMissing ? missing : down).push(r.component);
      }
      map.set(g.server.id, {
        down,
        updates,
        missing,
        edgeAbsent: g.server.projectCount > 0 && !g.components.some((r) => r.component === "edge"),
      });
    }
    return map;
  }, [groups]);

  const counts = useMemo(() => {
    let attention = 0;
    let updates = 0;
    let healthy = 0;
    /** Bulk-restartable components (stopped in place), fleet-wide. */
    let stopped = 0;
    /** Behind components, fleet-wide — what "Update all (N)" acts on. */
    let behind = 0;
    for (const s of summaries.values()) {
      const needs = s.down.length + s.missing.length + (s.edgeAbsent ? 1 : 0);
      if (needs > 0) attention++;
      else if (s.updates > 0) updates++;
      else healthy++;
      stopped += s.down.length;
      behind += s.updates;
    }
    return { attention, updates, healthy, stopped, behind };
  }, [summaries]);

  /**
   * Bulk apply. Targets are derived server-side from the cache — we only say which
   * classes to act on — then the view is re-read so the rows flip to "Updating…".
   */
  const applyAll = useCallback(
    async (intent: ContainerApplyIntent) => {
      if (!enabled) return;
      setApplying(intent);
      try {
        const res = await systemApi.applyAllContainers([intent]);
        await load();
        return res;
      } finally {
        setApplying(null);
      }
    },
    [enabled, load],
  );

  return {
    groups,
    summaries,
    counts,
    scanning,
    applying,
    scan,
    applyAll,
    reload: load,
    /** Nothing tracked yet (no servers, or cloud) → callers hide the surface. */
    empty: (groups?.length ?? 0) === 0,
  };
}
