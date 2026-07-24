/**
 * Uptime monitor runner.
 *
 * Periodic loop (started in app.ts boot) that claims due monitors,
 * probes each URL with a GET, records a monitor_check row, and drives
 * the down/recovered state machine:
 *
 *   failure → consecutiveFailures + 1; crossing failureThreshold flips
 *             the monitor to "down", opens a monitor_incident, and
 *             emits a "monitor.down" notification
 *   success → resets the streak; a "down" monitor flips back to "up",
 *             resolves its incident, and emits "monitor.recovered"
 *
 * The transition rules live in evaluateTransition() — a pure function
 * over (monitor, ok) so the state machine is unit-testable without a
 * probe or a DB. Notifications ride the existing dispatcher; per-channel
 * delivery is notification-workers' job.
 */

import { repos, type Monitor, type MonitorStatus } from "@repo/db";
import { safeErrorMessage } from "@repo/core";
import { notification } from "./notification-dispatcher";

/* ─── State machine ───────────────────────────────────────────────────────── */

export interface MonitorTransition {
  /** Next monitor.status. */
  status: MonitorStatus;
  /** Next monitor.consecutiveFailures. */
  consecutiveFailures: number;
  /** True exactly when this check crossed the failure threshold. */
  wentDown: boolean;
  /** True exactly when a "down" monitor produced a successful check. */
  recovered: boolean;
}

/**
 * Pure threshold state machine: given the monitor's current runner state
 * and one probe outcome, compute the next state + which transition (if
 * any) fired. A monitor already "down" never re-alerts on further
 * failures; a failure streak below the threshold never changes status.
 */
export function evaluateTransition(
  monitor: Pick<Monitor, "status" | "consecutiveFailures" | "failureThreshold">,
  ok: boolean,
): MonitorTransition {
  if (ok) {
    return {
      status: "up",
      consecutiveFailures: 0,
      wentDown: false,
      recovered: monitor.status === "down",
    };
  }

  const consecutiveFailures = monitor.consecutiveFailures + 1;
  const wentDown = monitor.status !== "down" && consecutiveFailures >= monitor.failureThreshold;
  return {
    status: wentDown ? "down" : (monitor.status as MonitorStatus),
    consecutiveFailures,
    wentDown,
    recovered: false,
  };
}

/* ─── Probe ───────────────────────────────────────────────────────────────── */

interface ProbeResult {
  ok: boolean;
  statusCode: number | null;
  responseMs: number | null;
  error: string | null;
}

/**
 * GET the monitor's URL. Success = expectedStatus match when set, any
 * status < 400 otherwise. Never throws — network/timeout failures come
 * back as { ok: false, error }.
 */
async function probe(monitor: Monitor): Promise<ProbeResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), monitor.timeoutMs);
  const startedAt = Date.now();
  try {
    const res = await fetch(monitor.url, {
      redirect: "follow",
      headers: { "User-Agent": "Openship-Monitor/1.0" },
      signal: controller.signal,
    });
    const responseMs = Date.now() - startedAt;
    // Release the connection — the body itself is never inspected.
    await res.body?.cancel().catch(() => {});

    const ok =
      monitor.expectedStatus !== null ? res.status === monitor.expectedStatus : res.status < 400;
    return {
      ok,
      statusCode: res.status,
      responseMs,
      error: ok
        ? null
        : monitor.expectedStatus !== null
          ? `Expected status ${monitor.expectedStatus}, got ${res.status}`
          : `HTTP ${res.status}`,
    };
  } catch (err) {
    return {
      ok: false,
      statusCode: null,
      responseMs: Date.now() - startedAt,
      error: controller.signal.aborted
        ? `Timed out after ${monitor.timeoutMs}ms`
        : probeErrorMessage(err),
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Node's fetch wraps network errors in a generic "fetch failed" — the
 *  useful part (ECONNREFUSED, DNS failure) lives on `cause`. */
function probeErrorMessage(err: unknown): string {
  if (err instanceof Error && err.cause instanceof Error && err.cause.message) {
    return err.cause.message;
  }
  return safeErrorMessage(err);
}

/* ─── Check + transition ──────────────────────────────────────────────────── */

async function checkMonitor(monitor: Monitor): Promise<void> {
  const result = await probe(monitor);
  const transition = evaluateTransition(monitor, result.ok);

  await repos.monitorCheck.create({
    monitorId: monitor.id,
    ok: result.ok,
    statusCode: result.statusCode,
    responseMs: result.responseMs,
    error: result.error,
  });

  await repos.monitor.recordCheckResult(monitor.id, {
    status: transition.status,
    consecutiveFailures: transition.consecutiveFailures,
    lastStatusCode: result.statusCode,
    lastResponseMs: result.responseMs,
  });

  if (transition.wentDown) {
    await repos.monitorIncident.open({
      monitorId: monitor.id,
      organizationId: monitor.organizationId,
      projectId: monitor.projectId,
      error: result.error,
      failedChecks: transition.consecutiveFailures,
    });
    await emitMonitorEvent(monitor, "monitor.down", {
      errorMessage: result.error,
      statusCode: result.statusCode,
    });
    return;
  }

  if (!result.ok && transition.status === "down") {
    // Still down: keep the open incident's last-failure snapshot current
    // so its `error` / `failedChecks` reflect the latest probe, not the
    // one that crossed the threshold.
    await repos.monitorIncident.updateOpen(monitor.id, {
      error: result.error,
      failedChecks: transition.consecutiveFailures,
    });
    return;
  }

  if (transition.recovered) {
    const incident = await repos.monitorIncident.findOpen(monitor.id);
    let durationMs: number | null = null;
    if (incident) {
      // The pre-reset streak is every failed probe of this downtime
      // window (the streak began before the incident opened).
      await repos.monitorIncident.resolve(incident.id, {
        failedChecks: monitor.consecutiveFailures,
      });
      durationMs = Date.now() - incident.startedAt.getTime();
    }
    await emitMonitorEvent(monitor, "monitor.recovered", { durationMs });
  }
}

async function emitMonitorEvent(
  monitor: Monitor,
  eventType: "monitor.down" | "monitor.recovered",
  extra: Record<string, unknown>,
): Promise<void> {
  const project = await repos.project.findById(monitor.projectId).catch(() => undefined);
  notification.emit({
    organizationId: monitor.organizationId,
    eventType,
    resourceType: "monitor",
    resourceId: monitor.id,
    payload: {
      projectName: project?.name ?? monitor.projectId,
      monitorName: monitor.name,
      url: monitor.url,
      ...extra,
    },
  });
}

/* ─── Runner loop ─────────────────────────────────────────────────────────── */

const CHECK_RETENTION_DAYS = 7;
const PRUNE_INTERVAL_MS = 60 * 60 * 1000;

let lastPruneAt = 0;
let tickInFlight = false;

/**
 * Probe all currently-due monitors. Called by a periodic timer (started
 * in app.ts boot). Each invocation claims a batch of due monitors
 * (enabled + lastCheckedAt null/older than intervalSeconds), probes them
 * concurrently, and applies the state machine per monitor. Also sweeps
 * monitor_check retention (7 days) at most once an hour.
 *
 * Ticks never overlap: a probe can hang up to timeoutMs (30s max, longer
 * than the tick interval), and lastCheckedAt is only stamped after the
 * probe — an overlapping tick would re-claim the same monitors from a
 * stale snapshot and double-open incidents. A tick that arrives while
 * one is in flight is skipped.
 */
export async function runMonitorChecks(): Promise<void> {
  if (tickInFlight) return;
  tickInFlight = true;
  try {
    const due = await repos.monitor.claimDue(25).catch(() => [] as Monitor[]);

    await Promise.all(
      due.map(async (mon) => {
        try {
          await checkMonitor(mon);
        } catch (err) {
          console.error(`[monitor] check failed for ${mon.id}:`, safeErrorMessage(err));
        }
      }),
    );

    if (Date.now() - lastPruneAt >= PRUNE_INTERVAL_MS) {
      lastPruneAt = Date.now();
      await repos.monitorCheck
        .prune(CHECK_RETENTION_DAYS)
        .catch((err) => console.warn("[monitor] check prune failed:", err));
    }
  } finally {
    tickInFlight = false;
  }
}

let runnerInterval: ReturnType<typeof setInterval> | null = null;

/** Start the periodic runner. Called from app.ts boot. */
export function startMonitorRunner(intervalMs = 15_000): void {
  if (runnerInterval) return;
  runnerInterval = setInterval(() => {
    void runMonitorChecks().catch((err) => console.error("[monitor] runner tick failed:", err));
  }, intervalMs);
}

export function stopMonitorRunner(): void {
  if (runnerInterval) {
    clearInterval(runnerInterval);
    runnerInterval = null;
  }
}
