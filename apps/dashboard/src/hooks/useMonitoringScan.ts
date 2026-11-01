"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { getApiErrorMessage, issuesApi, type MonitoringScanSession } from "@/lib/api";
import { getActiveOrganizationId } from "@/lib/api/client";

/** A checker may finish successfully while reporting gaps in its observations. */
export function monitoringScanIncomplete(stage: MonitoringScanSession["stages"][number]) {
  if (stage.status === "failed") return true;
  if (stage.status !== "completed") return false;
  const counters = stage.key === "services:health-watch"
    ? ["unreachable", "offline", "unresolved", "errors", "indeterminate", "skipped"]
    : ["errors", "unreachable"];
  return counters.some(
    (key) => typeof stage.summary?.[key] === "number" && (stage.summary[key] as number) > 0,
  );
}

/** One reader owns POST admission, reattachment and completion for every retry control. */
export function useMonitoringScan({
  enabled,
  online,
  recheckOnReconnect,
  onComplete,
}: {
  enabled: boolean;
  online: boolean;
  recheckOnReconnect: boolean;
  onComplete: (session: MonitoringScanSession, notify: boolean) => void | Promise<void>;
}) {
  const [scan, setScan] = useState<MonitoringScanSession | null>(null);
  const [rescanning, setRescanning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [canRescan, setCanRescan] = useState(false);
  const complete = useRef(onComplete);
  complete.current = onComplete;
  const lastScan = useRef<MonitoringScanSession | null>(null);
  // Admission may finish while offline. Retain its intent until a status read
  // identifies a new scan or confirms there is nothing to reattach to.
  const pendingScan = useRef<{
    organizationId: string | null;
    previousId: string | undefined;
    notify: boolean;
  } | null>(null);
  const wasOffline = useRef(!online);
  const controls = useRef<{ start: (healthOnly: boolean) => void; refresh: () => void } | null>(null);

  useEffect(() => {
    const reconnect = online && wasOffline.current;
    wasOffline.current = !online;
    if (!enabled || !online) return;

    let disposed = false;
    let reading = false;
    let starting = false;
    let permitted = false;
    let revision = 0;
    let failures = 0;
    let recheck = reconnect && recheckOnReconnect;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const current = (organizationId: string | null) =>
      !disposed && organizationId === getActiveOrganizationId();
    const clearTimer = () => { clearTimeout(timer); timer = undefined; };
    const schedule = (delay = 1200) => {
      clearTimer();
      if (!disposed) timer = setTimeout(() => {
        if (document.visibilityState !== "hidden") void read();
      }, delay);
    };
    const refreshChangedScope = (organizationId: string | null) => {
      if (disposed || organizationId === getActiveOrganizationId()) return;
      permitted = false;
      pendingScan.current = null;
      lastScan.current = null;
      setScan(null);
      setRescanning(false);
      setCanRescan(false);
      schedule(0);
    };

    const accept = (session: MonitoringScanSession | null) => {
      const previous = lastScan.current;
      const requested = pendingScan.current?.organizationId === getActiveOrganizationId()
        ? pendingScan.current
        : null;
      lastScan.current = session;
      setScan(session);
      setRescanning(session?.status === "running");
      setError(null);
      if (session?.status === "running") {
        schedule();
      } else {
        clearTimer();
        pendingScan.current = null;
        if (session && (
          (requested && session.id !== requested.previousId) ||
          (previous?.id === session.id && previous.status === "running")
        )) {
          void complete.current(session, requested?.notify ?? false);
        }
        // A reconnect during an older scan earns ONE fresh pass after it ends.
        // Reusing that scan alone could leave its pre-reconnect failures in place.
        if (recheck && permitted) {
          recheck = false;
          void start(false, true);
        }
      }
    };

    const read = async () => {
      if (disposed || reading || starting) return;
      clearTimer();
      reading = true;
      const version = revision;
      const organizationId = getActiveOrganizationId();
      try {
        const result = await issuesApi.rescanStatus();
        if (!current(organizationId) || version !== revision) return;
        permitted = true;
        setCanRescan(true);
        failures = 0;
        accept(result.data);
      } catch (err) {
        if (!current(organizationId) || version !== revision) return;
        const status = (err as { status?: number } | null)?.status;
        if (status === 401 || status === 403 || status === 404) {
          permitted = false;
          pendingScan.current = null;
          setCanRescan(false);
          setRescanning(false);
          return;
        }
        setError(getApiErrorMessage(err, "Could not read the monitoring scan. Retry to check its progress."));
        // Only status reads retry automatically; a timeout never repeats a POST.
        schedule(Math.min(15_000, 1200 * 2 ** Math.min(failures++, 4)));
      } finally {
        reading = false;
        // A newer POST can schedule its poll while this older GET is still
        // pending. If that timer fired, restore it after discarding this result.
        if (current(organizationId) && version !== revision && !starting) schedule();
        refreshChangedScope(organizationId);
      }
    };

    const start = async (showResult: boolean, healthOnly: boolean) => {
      if (disposed || starting || !permitted) return;
      if (lastScan.current?.status === "running") { void read(); return; }
      starting = true;
      revision++;
      clearTimer();
      setRescanning(true);
      setError(null);
      const organizationId = getActiveOrganizationId();
      pendingScan.current = { organizationId, previousId: lastScan.current?.id, notify: showResult };
      try {
        const result = await issuesApi.rescan({ healthOnly });
        if (!current(organizationId)) return;
        accept(result.data);
      } catch (err) {
        if (!current(organizationId)) return;
        setRescanning(false);
        permitted = false;
        setCanRescan(false);
        setError(getApiErrorMessage(err, "Could not start the monitoring scan."));
        // The server may have accepted a POST whose response was lost. Reattach
        // before offering another run instead of treating a timeout as rejection.
        schedule();
      } finally {
        starting = false;
        refreshChangedScope(organizationId);
      }
    };

    const refresh = () => { if (document.visibilityState !== "hidden") void read(); };
    controls.current = { start: (healthOnly) => void start(true, healthOnly), refresh: () => void read() };
    void read();
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      disposed = true;
      controls.current = null;
      clearTimer();
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [enabled, online, recheckOnReconnect]);

  return {
    scan,
    rescanning,
    error,
    canRescan: enabled && online && canRescan,
    rescan: useCallback(() => controls.current?.start(false), []),
    recheckHealth: useCallback(() => controls.current?.start(true), []),
    refresh: useCallback(() => controls.current?.refresh(), []),
  };
}
