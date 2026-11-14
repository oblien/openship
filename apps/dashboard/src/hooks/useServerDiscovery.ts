"use client";

import { reportCaughtError as observeCaughtError } from "@repo/core/diagnostics";
import { ApiError } from "@/lib/api/client";
import { discoveryApi, type DiscoveryRescan, type DiscoveryService, type DiscoveryStatus } from "@/lib/api";
import { useCallback, useEffect, useRef, useState } from "react";

/** Fast cadence while reconciliation, withdrawal, retry, or issuance is pending. */
const POLL_INTERVAL_MS = 8_000;
/**
 * Idle cadence while discovery is merely ENABLED: automatic server-side changes
 * (a container starting, a sweep reconciling, a certificate issuing) never push
 * to the dashboard, so a settled list still needs a slow refresh or it can sit
 * stale indefinitely — e.g. freshly enabled with zero services discovered yet.
 */
const IDLE_POLL_INTERVAL_MS = 60_000;

/**
 * True while server-side work may still change what the next status read
 * returns: a route apply/withdrawal is queued or retrying, reconciliation has
 * not caught up with the desired generation, or a certificate order is in
 * flight. Drives the card's polling — a settled server is not polled at all.
 */
export function discoveryNeedsPolling(status: DiscoveryStatus): boolean {
  return status.services.some(
    (s) =>
      s.withdrawalPending ||
      s.desiredGeneration !== s.appliedGeneration ||
      s.applyState === "pending" ||
      s.applyState === "error" ||
      // The domain row's TLS lifecycle writes provisioning while an order is
      // in flight (never "pending"/"issued").
      s.tls?.sslStatus === "provisioning",
  );
}

/**
 * True when a completed sweep reported anything that needs the operator's
 * attention: a failed stage, per-service failures, or a scan that did not run
 * cleanly. Retained/removed/withdrawn entries are PLANNED outcomes, not
 * failures.
 */
export function rescanHasFailures(summary: DiscoveryRescan): boolean {
  if (summary.failed.length > 0) return true;
  if (summary.scan && !summary.scan.ok) return true;
  if (summary.reconcile && (!summary.reconcile.ok || summary.reconcile.failed.length > 0)) return true;
  if (summary.repair && summary.repair.failed.length > 0) return true;
  return false;
}

/** Short human-readable list of what failed inside a finished sweep. */
export function rescanFailureDetail(summary: DiscoveryRescan): string {
  const parts: string[] = [];
  if (summary.scan && !summary.scan.ok) parts.push("scan");
  if (summary.reconcile && !summary.reconcile.ok) parts.push("reconcile");
  if (summary.reconcile?.failed.length) {
    parts.push(`${summary.reconcile.failed.length} service failure(s): ${summary.reconcile.failed[0].reason}`);
  }
  if (summary.repair?.failed.length) {
    parts.push(`${summary.repair.failed.length} repair failure(s): ${summary.repair.failed[0].reason}`);
  }
  if (summary.failed.length) parts.push(summary.failed.join(", "));
  return parts.join(", ");
}

/** An API failure that is really an authorization failure. */
export function isPermissionError(err: unknown): boolean {
  return err instanceof ApiError && (err.status === 401 || err.status === 403);
}

/**
 * Client source of truth for one server's discovery state.
 *
 * - Loads status once, then POLLS only while {@link discoveryNeedsPolling};
 *   a settled list never schedules timers.
 * - Stale-response guard: only the newest status read may land (a slow poll
 *   racing a manual refresh must not overwrite fresher data).
 * - Mutations serialize through one `busyKey` (duplicate submissions are
 *   impossible) and always refresh the status afterwards; single-service
 *   responses (suppress/unsuppress) are merged immediately so the row does
 *   not flicker back to its pre-action state.
 * - All timers and in-flight reads are cleaned up on unmount / server change.
 */
export function useServerDiscovery(serverId: string | null | undefined) {
  const [status, setStatus] = useState<DiscoveryStatus | null>(null);
  const [loading, setLoading] = useState(!!serverId);
  const [error, setError] = useState<string | null>(null);
  const [permissionDenied, setPermissionDenied] = useState(false);
  /** Identifies the in-flight mutation (e.g. "forget:id:my-app"); null = idle. */
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [rescanning, setRescanning] = useState(false);

  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // Stale-response guard + per-load abort. Only the newest read may land.
  const seq = useRef(0);
  const abort = useRef<AbortController | null>(null);

  const refresh = useCallback(
    async (opts: { silent?: boolean } = {}) => {
      if (!serverId) {
        setStatus(null);
        setLoading(false);
        return;
      }
      const current = ++seq.current;
      abort.current?.abort();
      abort.current = new AbortController();
      if (!opts.silent) setLoading(true);
      try {
        const next = await discoveryApi.status(serverId, { signal: abort.current.signal });
        if (mounted.current && current === seq.current) {
          setStatus(next);
          setError(null);
          setPermissionDenied(false);
        }
      } catch (err) {
        if (!mounted.current || current !== seq.current) return; // superseded
        if (isAbortError(err)) return;
        observeCaughtError(err, "dashboard/hooks/useServerDiscovery");
        if (isPermissionError(err)) setPermissionDenied(true);
        else setError(getDiscoveryErrorMessage(err));
      } finally {
        // Loading is owned by the non-silent read that set it. If THAT read was
        // superseded (a mutation's silent refresh landed first), it must still
        // clear the flag here — otherwise the newer silent read never touches
        // it and the UI hangs on skeletons forever.
        if (mounted.current && (!opts.silent || current === seq.current)) setLoading(false);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [serverId],
  );

  useEffect(() => {
    void refresh();
    return () => {
      seq.current++; // invalidate any in-flight read for the old server
      abort.current?.abort();
    };
  }, [refresh]);

  // Poll FAST while server-side reconciliation may still change the answer,
  // SLOWLY while discovery is merely enabled (automatic container/TLS changes
  // are invisible otherwise), and not at all when discovery is off and settled.
  const pending = status ? discoveryNeedsPolling(status) : false;
  const enabled = status?.settings.enabled ?? false;
  useEffect(() => {
    if (!pending && !enabled) return;
    const timer = setInterval(
      () => void refresh({ silent: true }),
      pending ? POLL_INTERVAL_MS : IDLE_POLL_INTERVAL_MS,
    );
    return () => clearInterval(timer);
  }, [pending, enabled, refresh]);

  /**
   * Run one operator mutation. `mergedService` (suppress/unsuppress) lands in
   * the list immediately; the status refetch that follows reconciles the rest.
   * The busy key makes duplicate submission impossible.
   */
  const runAction = useCallback(
    async (key: string, action: () => Promise<unknown>): Promise<{ ok: boolean; error?: string; permission?: boolean }> => {
      if (busyKey) return { ok: false };
      setBusyKey(key);
      try {
        const merged = await action();
        // Only single-service responses (suppress/unsuppress) carry serviceKey;
        // configure's full status and forget's {forgotten} just refresh below.
        const service = (merged as DiscoveryService | undefined)?.serviceKey ? (merged as DiscoveryService) : undefined;
        if (service && status) {
          setStatus((prev) =>
            prev
              ? { ...prev, services: prev.services.map((s) => (s.serviceKey === service.serviceKey ? service : s)) }
              : prev,
          );
        }
        await refresh({ silent: true });
        return { ok: true };
      } catch (err) {
        if (!isAbortError(err)) {
          observeCaughtError(err, "dashboard/hooks/useServerDiscovery");
          return { ok: false, error: getDiscoveryErrorMessage(err), permission: isPermissionError(err) };
        }
        return { ok: false };
      } finally {
        if (mounted.current) setBusyKey(null);
      }
    },
    [busyKey, status, refresh],
  );

  const runRescan = useCallback(async (): Promise<{
    ok: boolean;
    /** HTTP-level failure (network, 4xx/5xx, timeout). */
    error?: string;
    permission?: boolean;
    /** HTTP succeeded but the sweep reported stage failures / partial results. */
    summary?: DiscoveryRescan;
  }> => {
    if (!serverId || busyKey || rescanning) return { ok: false };
    setBusyKey("rescan");
    setRescanning(true);
    try {
      const summary = await discoveryApi.rescan(serverId);
      await refresh({ silent: true });
      // A 200 response can still report failures: scan not ok, reconciliation
      // or repair not ok, or per-service failed entries.
      const partial = rescanHasFailures(summary);
      return { ok: !partial, summary };
    } catch (err) {
      if (!isAbortError(err)) {
        observeCaughtError(err, "dashboard/hooks/useServerDiscovery");
        return { ok: false, error: getDiscoveryErrorMessage(err), permission: isPermissionError(err) };
      }
      return { ok: false };
    } finally {
      if (mounted.current) {
        setBusyKey(null);
        setRescanning(false);
      }
    }
  }, [serverId, busyKey, rescanning, refresh]);

  return {
    status,
    loading,
    error,
    permissionDenied,
    busyKey,
    rescanning,
    /** Server-side reconciliation may still be changing state (drives spinners). */
    reconciling: pending,
    refresh,
    runAction,
    runRescan,
  };
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === "AbortError";
}

function getDiscoveryErrorMessage(err: unknown): string {
  if (err instanceof ApiError && typeof err.body === "object" && err.body !== null) {
    // The API error handler serializes AppErrors as { error, code }.
    const body = err.body as { error?: unknown; message?: unknown };
    if (typeof body.error === "string" && body.error) return body.error;
    if (typeof body.message === "string" && body.message) return body.message;
  }
  return err instanceof Error ? err.message : "Discovery request failed";
}

export type { DiscoveryService };
