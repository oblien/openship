/**
 * Build session manager - manages active build SSE streams.
 *
 * Responsibilities:
 *   - Track active build sessions with log buffers
 *   - Broadcast log entries to SSE subscribers
 *   - Auto-cleanup stale sessions
 *   - SSE heartbeat keep-alive for proxy compatibility
 */

import { SYSTEM } from "@repo/core";
import { TtlCache } from "../../lib/cache";
import type { LogEntry, PromptPayload } from "@repo/adapters";
import { PromptRegistry } from "../../lib/prompt-gateway";
import type { PortCheckResult } from "../../lib/deployment-runtime";
import { STEP_INDEX, STEP_PROGRESS, progressForStep } from "./build-steps";

export interface ServiceStatusPayload {
  serviceName: string;
  serviceId: string;
  status: "pending" | "building" | "built" | "deploying" | "running" | "failed";
  error?: string;
  containerId?: string;
  hostPort?: number;
}

export interface BuildSessionState {
  deploymentId: string;
  projectId: string;
  status: "queued" | "building" | "deploying" | "ready" | "failed" | "cancelled";
  logs: LogEntry[];
  warningMessage?: string;
  errorMessage?: string;
  /** Per-service deployment statuses (compose projects only, for replay on reconnect) */
  serviceStatuses: Map<string, ServiceStatusPayload>;
  /** The prompt currently awaiting a user decision (e.g. edge 80/443 takeover,
   *  port conflict). Held here — not just broadcast — so a page refresh /
   *  reconnect re-shows it (replayed in subscribe). Cleared on response/timeout. */
  currentPrompt?: PromptPayload;
  /** SSE writer callbacks for active subscribers */
  subscribers: Set<SseWriter>;
  startedAt: number;
  /** Monotonic counter for per-entry `seq` (the SSE event id). Never reset by
   *  the ring-buffer trim, so the client's dedup cursor keeps advancing instead
   *  of plateauing at the buffer cap. */
  nextSeq: number;
}

export type SseWriter = (event: string, data: string) => boolean;

// The prompt shape is the ONE shared PromptPayload from @repo/adapters (used by
// the deploy pipeline, server-setup, CLI, and dashboard modal). Re-exported here
// so existing importers of session-manager keep working.
export type { PromptPayload };


/** Convert a LogEntry into the JSON payload the frontend expects. The event id
 *  is the entry's stable `seq` (assigned in appendLog), NOT the ring-buffer
 *  index — the index plateaus at the buffer cap and froze the client dedup. */
function formatLogPayload(entry: LogEntry): string {
  // Use native base64 when available (cloud adapter), otherwise encode.
  // Local/SSH logs are single lines without trailing newlines - append \n
  // so the terminal renders each entry on its own line.
  const base64Data = entry.rawData ?? Buffer.from(entry.message + "\n").toString("base64");
  return JSON.stringify({
    type: "log",
    data: base64Data,
    eventId: entry.seq,
    step: entry.step,
    stepStatus: entry.stepStatus,
    level: entry.level,
    serviceName: entry.serviceName,
    serviceId: entry.serviceId,
  });
}

/** Active sessions cache - keyed by deployment ID (dep_xxx) */
const sessions = new TtlCache<BuildSessionState>({
  maxSize: SYSTEM.SSE.MAX_SESSIONS,
  sweepIntervalMs: SYSTEM.SSE.SWEEP_INTERVAL_MS,
});

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

/** Create a new build session - keyed by deployment ID (dep_xxx). */
export function createSession(
  deploymentId: string,
  projectId: string,
): BuildSessionState {
  const state: BuildSessionState = {
    deploymentId,
    projectId,
    status: "queued",
    logs: [],
    serviceStatuses: new Map(),
    subscribers: new Set(),
    startedAt: Date.now(),
    nextSeq: 0,
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

  // Assign the stable seq BEFORE the ring-buffer trim so it never plateaus.
  entry.seq = session.nextSeq++;

  session.logs.push(entry);
  if (session.logs.length > SYSTEM.SSE.MAX_LOGS_PER_SESSION) {
    session.logs.splice(0, session.logs.length - SYSTEM.SSE.MAX_LOGS_PER_SESSION);
  }

  // Step-metadata entries (running/completed/failed) only drive the progress
  // bar - they should NOT be written to the terminal as log lines.
  const isStepMeta = !!entry.step && !!entry.stepStatus;

  // Broadcast raw log to terminal (skip step-metadata-only entries)
  if (!isStepMeta) {
    const logPayload = formatLogPayload(entry);
    const dead: SseWriter[] = [];
    for (const writer of session.subscribers) {
      const ok = writer("log", logPayload);
      if (!ok) dead.push(writer);
    }
    for (const w of dead) session.subscribers.delete(w);
  }

  // Emit a progress event for every step metadata update so the UI stays in sync
  if (entry.step && entry.stepStatus && entry.step in STEP_INDEX) {
    const progressPayload = JSON.stringify({
      type: "progress",
      currentStep: STEP_INDEX[entry.step],
      progress: progressForStep(entry.step, entry.stepStatus),
    });
    for (const writer of session.subscribers) {
      writer("progress", progressPayload);
    }
  }
}

/** Broadcast per-service deployment status to SSE subscribers (compose projects) */
export function broadcastServiceStatus(
  sessionId: string,
  serviceStatus: ServiceStatusPayload,
): void {
  const session = sessions.get(sessionId);
  if (!session) return;

  // Store for replay on reconnect
  session.serviceStatuses.set(serviceStatus.serviceId, serviceStatus);

  const payload = JSON.stringify({
    type: "service-status",
    ...serviceStatus,
  });
  const dead: SseWriter[] = [];
  for (const writer of session.subscribers) {
    const ok = writer("service-status", payload);
    if (!ok) dead.push(writer);
  }
  for (const w of dead) session.subscribers.delete(w);
}

/** Update session status and broadcast typed events */
export function updateStatus(
  sessionId: string,
  status: BuildSessionState["status"],
  meta?: {
    errorCode?: string;
    errorDetails?: Record<string, unknown>;
    warningMessage?: string;
    errorMessage?: string;
    /** Advisory post-deploy port-check results, forwarded on the `complete` event. */
    portCheck?: PortCheckResult[];
  },
): void {
  const session = sessions.get(sessionId);
  if (!session) return;

  session.status = status;
  session.warningMessage = meta?.warningMessage;
  session.errorMessage = meta?.errorMessage;

  // Broadcast typed events matching frontend expectations
  if (status === "ready") {
    const payload = JSON.stringify({
      type: "complete",
      success: true,
      ...(session.warningMessage ? { warningMessage: session.warningMessage } : {}),
      ...(meta?.portCheck && meta.portCheck.length > 0 ? { portCheck: meta.portCheck } : {}),
    });
    for (const writer of session.subscribers) {
      writer("complete", payload);
    }
  } else if (status === "failed") {
    const lastError = [...session.logs].reverse().find((l) => l.level === "error");
    const payload = JSON.stringify({
      type: "complete",
      success: false,
      message: session.errorMessage || lastError?.message || "Build failed",
      ...(meta?.errorCode && { errorCode: meta.errorCode }),
      ...(meta?.errorDetails && { errorDetails: meta.errorDetails }),
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

/**
 * Subscribe a new SSE writer to a session, returns unsubscribe fn.
 *
 * `sinceSeq` is the highest `seq` the client already has (from the history
 * snapshot it fetched before connecting). Entries with `seq <= sinceSeq` are
 * NOT replayed, so a refresh/reconnect streams only genuinely new events
 * instead of re-delivering the whole buffer. Omit it for a fresh subscription.
 */
export function subscribe(
  sessionId: string,
  writer: SseWriter,
  sinceSeq?: number,
): { success: boolean; unsubscribe: () => void } {
  const session = sessions.get(sessionId);
  if (!session) return { success: false, unsubscribe: () => {} };

  // Enforce subscriber limit - evict oldest if full
  if (session.subscribers.size >= SYSTEM.SSE.MAX_SUBSCRIBERS_PER_SESSION) {
    const oldest = session.subscribers.values().next().value;
    if (oldest) {
      oldest("end", JSON.stringify({ message: "Evicted: subscriber limit reached" }));
      session.subscribers.delete(oldest);
    }
  }

  session.subscribers.add(writer);

  // Replay existing logs in the format the frontend expects
  // Skip step-metadata entries (same filter as appendLog) - they drive progress, not terminal
  // Track the highest step seen so we can emit a final progress event after replay
  let highestStep = -1;
  let highestStepProgress = 0;

  for (let i = 0; i < session.logs.length; i++) {
    const entry = session.logs[i];
    const isStepMeta = !!entry.step && !!entry.stepStatus;

    // Only replay real output entries to the terminal, and skip anything the
    // client already has (seq <= sinceSeq) so a resume streams only new events.
    const alreadySeen =
      sinceSeq !== undefined && entry.seq !== undefined && entry.seq <= sinceSeq;
    if (!isStepMeta && !alreadySeen) {
      const ok = writer("log", formatLogPayload(entry));
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

  // Replay per-service statuses (compose projects)
  for (const svcStatus of session.serviceStatuses.values()) {
    writer("service-status", JSON.stringify({
      type: "service-status",
      ...svcStatus,
    }));
  }

  // Re-show a still-pending decision prompt (edge takeover, port conflict) so a
  // refresh/reconnect lands back on the modal instead of a silent stalled build.
  // Only for a live session — a finished build's prompt is stale.
  if (session.currentPrompt && !["ready", "failed", "cancelled"].includes(session.status)) {
    writer("prompt", JSON.stringify({ type: "prompt", ...session.currentPrompt }));
  }

  // If session already finished, send typed completion + end events
  if (["ready", "failed", "cancelled"].includes(session.status)) {
    if (session.status === "ready") {
      writer("complete", JSON.stringify({
        type: "complete",
        success: true,
        ...(session.warningMessage ? { warningMessage: session.warningMessage } : {}),
      }));
    } else if (session.status === "failed") {
      const lastError = [...session.logs].reverse().find((l) => l.level === "error");
      writer("complete", JSON.stringify({
        type: "complete",
        success: false,
        message: session.errorMessage || lastError?.message || "Build failed",
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
  // Clean up any pending prompt - reject so the pipeline doesn't hang
  rejectPendingPrompt(sessionId, "Session removed");
}

// The block-on-a-promise + timeout mechanic lives once in PromptRegistry; this
// manager keeps only the session-object hold (currentPrompt, for replay) + the
// SSE broadcast.
const promptRegistry = new PromptRegistry();

/**
 * Broadcast a prompt SSE event and block until the user responds.
 *
 * Called from the deploy pipeline's preflight (via build.service).
 * Returns the user's chosen action string (e.g. "free_port", "abort").
 */
export async function promptUser(
  sessionId: string,
  prompt: PromptPayload,
): Promise<string> {
  const session = sessions.get(sessionId);
  if (!session) throw new Error("No active session for prompt");

  // Hold the prompt on the session so a refresh/reconnect re-shows it (replayed
  // in subscribe), not just a one-shot broadcast.
  session.currentPrompt = prompt;
  const payload = JSON.stringify({ type: "prompt", ...prompt });
  for (const writer of session.subscribers) {
    writer("prompt", payload);
  }

  return promptRegistry.wait(sessionId, () => {
    if (session.currentPrompt?.promptId === prompt.promptId) session.currentPrompt = undefined;
  });
}

/**
 * Resolve a pending prompt with the user's chosen action.
 * Called from the API route handler.
 */
export function respondToPrompt(sessionId: string, action: string): boolean {
  const ok = promptRegistry.respond(sessionId, action);
  if (ok) {
    const session = sessions.get(sessionId);
    if (session) session.currentPrompt = undefined;
  }
  return ok;
}

/** Reject a pending prompt (cleanup helper). */
function rejectPendingPrompt(sessionId: string, reason: string): void {
  if (!promptRegistry.has(sessionId)) return;
  const session = sessions.get(sessionId);
  if (session) session.currentPrompt = undefined;
  promptRegistry.reject(sessionId, reason);
}
