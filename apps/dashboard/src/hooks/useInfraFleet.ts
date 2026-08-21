"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { systemApi, type ContainerApplyActive, type ServerContainerGroup } from "@/lib/api/system";
import type { ContainerApplyIntent } from "@/lib/api/system";
import { applyKey, summarizeSettled, type ApplyOutcome } from "@/lib/infra-apply-status";
import { summarizeInfraFleet, type InfraBucket } from "@/lib/infra-fleet-state";
import { infraScanStale, markInfraScanned } from "@/lib/infra-autoscan";

export type { InfraBucket, InfraServerSummary } from "@/lib/infra-fleet-state";
export type InfraSegment = "all" | InfraBucket;

/** How long the settled line stays up before the card returns to its resting state. */
const OUTCOME_MS = 8000;
/** Progress cadence while something is in flight — a step at a time, not a spinner. */
const POLL_MS = 2500;
/**
 * Polls in a row where the cache claims work is in flight but the API reports NOTHING
 * running (~1 min). That combination is the stale-flag case — a control plane that
 * died mid-swap leaves the flag set, and its session died with it. It is not the slow
 * case: a queued target always has a running sibling, and a long image pull reports
 * itself as running for as long as it takes, so neither trips this.
 */
const STALL_BUDGET = 24;
/** Absolute ceiling (~20 min) so even a wedged SSH session stops being polled. */
const WATCH_BUDGET = 480;

const keysOf = (active: ContainerApplyActive[]): Set<string> =>
  new Set(active.map((t) => applyKey(t.serverId, t.component)));

const sameKeys = (a: Set<string>, b: Set<string>): boolean =>
  a.size === b.size && [...a].every((k) => b.has(k));

/**
 * Fleet-wide managed-container state for the Servers tab: the cached grouped view,
 * a per-server summary, the counts the header/segments render, live apply progress,
 * and the two bulk actions. Detect (Scan) and apply (Update all / Restart stopped)
 * both go through the same endpoints the per-server rows use, so nothing here
 * re-implements a fix — an apply started in bulk is the same replayable session a
 * row click re-attaches to.
 *
 * The in-flight half is why this hook holds two reads. The cached rows say WHICH
 * components were accepted (queued targets included, since the bulk endpoint flags
 * them before it answers); `/containers/applying` says how far the running ones have
 * got and how the finished ones ended. A row alone can't tell a caller that a swap
 * succeeded: it clears its drift and its in-progress flag in the same write, so
 * watching rows only ever shows work disappear.
 *
 * `enabled` is the self-hosted/desktop gate: on cloud these endpoints are
 * `assertNotCloud`, so we never call them.
 */
/**
 * Coerce a container-groups response to an array.
 *
 * `?? []` is not enough: it admits any non-null value, and a 2xx body that isn't
 * the array we asked for (a proxy answering for the API, a version skew) then
 * reached `.some(...)` DURING RENDER — which throws, and this hook is called by
 * the servers LIST page, so a single odd payload took the whole fleet view to the
 * error boundary and left no route to any server.
 */
function asGroups(value: unknown): ServerContainerGroup[] {
  return Array.isArray(value) ? (value as ServerContainerGroup[]) : [];
}

export function useInfraFleet(enabled: boolean) {
  const [groups, setGroups] = useState<ServerContainerGroup[] | null>(null);
  const [scanning, setScanning] = useState(false);
  const [applying, setApplying] = useState<ContainerApplyIntent | null>(null);
  const [active, setActive] = useState<ContainerApplyActive[]>([]);
  const [outcome, setOutcome] = useState<ApplyOutcome | null>(null);
  /** Every (server, component) seen in flight since the last idle — the outcome is
   *  reported only for these, so a surface opened mid-run never announces a finish
   *  it didn't watch. */
  const watched = useRef<Set<string>>(new Set());
  const activeKeys = useRef<Set<string>>(new Set());
  /** Consecutive polls with a flag set but nothing running (see STALL_BUDGET). */
  const stallTicks = useRef(0);
  /** Polls since this watch began (see WATCH_BUDGET). */
  const watchTicks = useRef(0);
  const [pollTick, setPollTick] = useState(0);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const load = useCallback(async (): Promise<ServerContainerGroup[]> => {
    if (!enabled) return [];
    try {
      const fresh = asGroups(await systemApi.listAllContainers());
      if (alive.current) setGroups(fresh);
      return fresh;
    } catch {
      if (alive.current) setGroups([]); // cloud / read error → the card simply doesn't render
      return [];
    }
  }, [enabled]);

  const scan = useCallback(async () => {
    if (!enabled) return;
    setScanning(true);
    try {
      setGroups(asGroups(await systemApi.scanAllContainers()));
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
        if (!cancelled) setGroups(asGroups(fresh));
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

  /** Components the cache says are mid-apply — the durable half of "in flight". */
  const flagged = useMemo(
    () =>
      new Set(
        (groups ?? []).flatMap((g) =>
          g.components.filter((r) => r.latestInProgress).map((r) => applyKey(g.server.id, r.component)),
        ),
      ),
    [groups],
  );
  /** The same set as reported by the progress read — covers a run whose row is gone. */
  const live = useMemo(() => keysOf(active), [active]);
  const busy = flagged.size > 0 || live.size > 0;

  /**
   * One progress read. Anything that changed the in-flight SET also re-reads the
   * rows, so the counts settle from the same beat that moved the status — and a
   * drained set produces the outcome line before the polling stops.
   */
  const poll = useCallback(async () => {
    watchTicks.current += 1;
    const next = await systemApi.applyingContainers().catch(() => null);
    if (next && alive.current) {
      // A session anywhere means the control plane is alive and doing the work, so
      // only its absence counts toward the stall bound.
      stallTicks.current = next.active.some((t) => t.state === "running")
        ? 0
        : stallTicks.current + 1;
      const nextKeys = keysOf(next.active);
      for (const k of nextKeys) watched.current.add(k);
      const moved = !sameKeys(activeKeys.current, nextKeys);
      activeKeys.current = nextKeys;
      setActive(next.active);
      if (moved) {
        await load(); // the set changed — let the counts follow the same beat
        if (nextKeys.size === 0) {
          const settled = summarizeSettled(next.recent, watched.current);
          watched.current = new Set();
          if (settled && alive.current) setOutcome(settled);
        }
      }
    }
    if (alive.current) setPollTick((n) => n + 1);
  }, [load]);

  // Chained (never overlapping) while anything is in flight, driven by `pollTick` so
  // a failed request still schedules the next attempt. Only the opening tick of a
  // watch is immediate — that's the one that turns a just-accepted bulk into a
  // visible queue; everything after it is spaced, including the ticks that follow a
  // transition, so a fast-moving set can't turn into a request loop.
  useEffect(() => {
    if (!enabled || !busy) return;
    if (stallTicks.current >= STALL_BUDGET || watchTicks.current >= WATCH_BUDGET) return;
    const opening = watchTicks.current === 0 && live.size === 0;
    const timer = setTimeout(() => void poll(), opening ? 0 : POLL_MS);
    return () => clearTimeout(timer);
  }, [enabled, busy, live.size, pollTick, poll]);

  // Idle again → forget the last run's progress so a later apply starts clean.
  useEffect(() => {
    if (busy) return;
    stallTicks.current = 0;
    watchTicks.current = 0;
    activeKeys.current = new Set();
  }, [busy]);

  useEffect(() => {
    if (!outcome) return;
    const timer = setTimeout(() => setOutcome(null), OUTCOME_MS);
    return () => clearTimeout(timer);
  }, [outcome]);

  /** Per-server summary + the fleet counts, from the one shared derivation. */
  const { summaries, counts } = useMemo(() => summarizeInfraFleet(groups, live), [groups, live]);

  /**
   * Bulk apply. Targets are derived server-side from the cache — we only say which
   * classes to act on — then the view is re-read so the rows flip to "Updating…".
   * The re-read is in the `finally`: a POST that aborts or 5xxs may still have
   * started work, and leaving the card idle over running applies is the worse lie.
   */
  const applyAll = useCallback(
    async (intent: ContainerApplyIntent) => {
      if (!enabled) return;
      setApplying(intent);
      setOutcome(null);
      try {
        return await systemApi.applyAllContainers([intent]);
      } finally {
        setApplying(null);
        await load();
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
    /** Live per-component progress for everything in flight (queued + running). */
    active,
    /** The just-settled beat, or null. Cleared automatically. */
    outcome,
    scan,
    applyAll,
    reload: load,
    /** Nothing tracked yet (no servers, or cloud) → callers hide the surface. */
    empty: (groups?.length ?? 0) === 0,
  };
}
