/**
 * Build session manager — manages active build SSE streams.
 *
 * Ported from old sessionManager.js into a typed, TtlCache-backed implementation.
 * Uses Hono's SSE streaming instead of raw Express res.write().
 *
 * Responsibilities:
 *   - Track active build sessions with log buffers
 *   - Broadcast log entries to SSE subscribers
 *   - Auto-cleanup stale sessions
 *   - SSE heartbeat keep-alive for proxy compatibility
 */

import { SYSTEM } from "@repo/core";
import { TtlCache } from "../../lib/cache";
import type { LogEntry } from "@repo/adapters";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface BuildSessionState {
  deploymentId: string;
  projectId: string;
  status: "queued" | "building" | "deploying" | "ready" | "failed" | "cancelled";
  logs: LogEntry[];
  /** SSE writer callbacks for active subscribers */
  subscribers: Set<SseWriter>;
  startedAt: number;
}

export type SseWriter = (event: string, data: string) => boolean;

// ─── Step-to-progress mapping ────────────────────────────────────────────────

const STEP_INDEX: Record<string, number> = {
  clone: 0,
  install: 1,
  build: 2,
  deploy: 3,
};

const STEP_PROGRESS: Record<string, number> = {
  clone: 5,
  install: 25,
  build: 50,
  deploy: 75,
};

/** Convert a LogEntry into the JSON payload the frontend expects. */
function formatLogPayload(entry: LogEntry, eventId: number): string {
  // Use native base64 when available (cloud adapter), otherwise encode.
  // Local/SSH logs are single lines without trailing newlines — append \n
  // so the terminal renders each entry on its own line.
  const base64Data = entry.rawData ?? Buffer.from(entry.message + "\n").toString("base64");
  return JSON.stringify({
    type: "log",
    data: base64Data,
    eventId,
    step: entry.step,
    stepStatus: entry.stepStatus,
    level: entry.level,
  });
}

// ─── Cache ───────────────────────────────────────────────────────────────────

/** Active sessions cache — keyed by deployment ID (dep_xxx) */
const sessions = new TtlCache<BuildSessionState>({
  maxSize: SYSTEM.SSE.MAX_SESSIONS,
  sweepIntervalMs: SYSTEM.SSE.SWEEP_INTERVAL_MS,
});

// ─── Heartbeat ───────────────────────────────────────────────────────────────

/** Send keep-alive pings to all active subscribers to prevent connection drops */
const heartbeatTimer = setInterval(() => {
  for (const session of sessions.values()) {
    const dead: SseWriter[] = [];
    for (const writer of session.subscribers) {
      const ok = writer("ping", "{}");
      if (!ok) dead.push(writer);
    }
    for (const w of dead) session.subscribers.delete(w);
  }
}, SYSTEM.SSE.HEARTBEAT_INTERVAL_MS);

// Don't keep the process alive just for heartbeats
if (heartbeatTimer.unref) heartbeatTimer.unref();

/** Create a new build session — keyed by deployment ID (dep_xxx). */
export function createSession(
  deploymentId: string,
  projectId: string,
): BuildSessionState {
  const state: BuildSessionState = {
    deploymentId,
    projectId,
    status: "queued",
    logs: [],
    subscribers: new Set(),
    startedAt: Date.now(),
  };
  sessions.set(deploymentId, state, SYSTEM.SSE.SESSION_TTL_SECONDS);
  return state;
}

/** Get an active session */
export function getSession(sessionId: string): BuildSessionState | null {
  return sessions.get(sessionId);
}

/** Append a log entry and broadcast to subscribers */
export function appendLog(sessionId: string, entry: LogEntry): void {
  const session = sessions.get(sessionId);
  if (!session) return;

  session.logs.push(entry);
  if (session.logs.length > SYSTEM.SSE.MAX_LOGS_PER_SESSION) {
    session.logs.splice(0, session.logs.length - SYSTEM.SSE.MAX_LOGS_PER_SESSION);
  }

  // Step-metadata entries (running/completed/failed) only drive the progress
  // bar — they should NOT be written to the terminal as log lines.
  const isStepMeta = !!entry.step && !!entry.stepStatus;

  // Broadcast raw log to terminal (skip step-metadata-only entries)
  if (!isStepMeta) {
    const logPayload = formatLogPayload(entry, session.logs.length - 1);
    const dead: SseWriter[] = [];
    for (const writer of session.subscribers) {
      const ok = writer("log", logPayload);
      if (!ok) dead.push(writer);
    }
    for (const w of dead) session.subscribers.delete(w);
  }

  // Emit a progress event when a new step starts
  if (entry.step && entry.stepStatus === "running" && entry.step in STEP_INDEX) {
    const progressPayload = JSON.stringify({
      type: "progress",
      currentStep: STEP_INDEX[entry.step],
      progress: STEP_PROGRESS[entry.step],
    });
    for (const writer of session.subscribers) {
      writer("progress", progressPayload);
    }
  }
}

/** Update session status and broadcast typed events */
export function updateStatus(
  sessionId: string,
  status: BuildSessionState["status"],
): void {
  const session = sessions.get(sessionId);
  if (!session) return;

  session.status = status;

  // Broadcast typed events matching frontend expectations
  if (status === "ready") {
    const payload = JSON.stringify({ type: "complete", success: true });
    for (const writer of session.subscribers) {
      writer("complete", payload);
    }
  } else if (status === "failed") {
    const lastError = [...session.logs].reverse().find((l) => l.level === "error");
    const payload = JSON.stringify({
      type: "complete",
      success: false,
      message: lastError?.message || "Build failed",
    });
    for (const writer of session.subscribers) {
      writer("complete", payload);
    }
  } else if (status === "cancelled") {
    const payload = JSON.stringify({ type: "cancelled", message: "Build cancelled" });
    for (const writer of session.subscribers) {
      writer("cancelled", payload);
    }
  }

  // Terminal states: send end event and close all subscribers
  if (status === "ready" || status === "failed" || status === "cancelled") {
    const endPayload = JSON.stringify({ type: "end", status });
    for (const writer of session.subscribers) {
      writer("end", endPayload);
    }
    session.subscribers.clear();
  }
}

/** Subscribe a new SSE writer to a session, returns unsubscribe fn */
export function subscribe(
  sessionId: string,
  writer: SseWriter,
): { success: boolean; unsubscribe: () => void } {
  const session = sessions.get(sessionId);
  if (!session) return { success: false, unsubscribe: () => {} };

  // Enforce subscriber limit — evict oldest if full
  if (session.subscribers.size >= SYSTEM.SSE.MAX_SUBSCRIBERS_PER_SESSION) {
    const oldest = session.subscribers.values().next().value;
    if (oldest) {
      oldest("end", JSON.stringify({ message: "Evicted: subscriber limit reached" }));
      session.subscribers.delete(oldest);
    }
  }

  session.subscribers.add(writer);

  // Replay existing logs in the format the frontend expects
  // Skip step-metadata entries (same filter as appendLog) — they drive progress, not terminal
  // Track the highest step seen so we can emit a final progress event after replay
  let highestStep = -1;
  let highestStepProgress = 0;

  for (let i = 0; i < session.logs.length; i++) {
    const entry = session.logs[i];
    const isStepMeta = !!entry.step && !!entry.stepStatus;

    // Only replay real output entries to the terminal
    if (!isStepMeta) {
      const ok = writer("log", formatLogPayload(entry, i));
      if (!ok) {
        session.subscribers.delete(writer);
        return { success: false, unsubscribe: () => {} };
      }
    }

    // Track step progress from replayed entries
    if (entry.step && entry.step in STEP_INDEX) {
      const idx = STEP_INDEX[entry.step];
      if (idx > highestStep) {
        highestStep = idx;
        highestStepProgress = STEP_PROGRESS[entry.step];
      }
    }
  }

  // Emit a progress event so the frontend knows the current step after replay
  if (highestStep >= 0) {
    writer("progress", JSON.stringify({
      type: "progress",
      currentStep: highestStep,
      progress: highestStepProgress,
    }));
  }

  // If session already finished, send typed completion + end events
  if (["ready", "failed", "cancelled"].includes(session.status)) {
    if (session.status === "ready") {
      writer("complete", JSON.stringify({ type: "complete", success: true }));
    } else if (session.status === "failed") {
      const lastError = [...session.logs].reverse().find((l) => l.level === "error");
      writer("complete", JSON.stringify({
        type: "complete",
        success: false,
        message: lastError?.message || "Build failed",
      }));
    } else if (session.status === "cancelled") {
      writer("cancelled", JSON.stringify({ type: "cancelled", message: "Build cancelled" }));
    }
    writer("end", JSON.stringify({ type: "end", status: session.status }));
    session.subscribers.delete(writer);
  }

  return {
    success: true,
    unsubscribe: () => session.subscribers.delete(writer),
  };
}

/** Remove a session completely */
export function removeSession(sessionId: string): void {
  const session = sessions.get(sessionId);
  if (session) {
    for (const writer of session.subscribers) {
      writer("end", JSON.stringify({ message: "Session ended" }));
    }
    session.subscribers.clear();
  }
  sessions.delete(sessionId);
}
