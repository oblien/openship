/**
 * Setup session manager - tracks active system install SSE streams.
 *
 * Similar to the build session manager but simpler: tracks install
 * progress per component, streams real-time logs to subscribers,
 * and supports log replay for late joiners / page reloads.
 */

import type { PromptPayload } from "@repo/adapters";
import { PromptRegistry } from "../../lib/prompt-gateway";
import { TtlCache } from "../../lib/cache";

// ─── Types ───────────────────────────────────────────────────────────────────

export type SetupSessionStatus = "running" | "completed" | "failed";

export interface ComponentProgress {
  name: string;
  label: string;
  status: "pending" | "installing" | "installed" | "failed";
  error?: string;
}

export interface SetupLogEntry {
  timestamp: string;
  component: string;
  message: string;
  level: "info" | "warn" | "error";
}

// The setup prompt is the ONE shared PromptPayload from @repo/adapters — aliased
// so this file's existing `SetupPrompt` references stay put.
export type SetupPrompt = PromptPayload;

export interface SetupSessionState {
  id: string;
  serverId: string;
  status: SetupSessionStatus;
  components: ComponentProgress[];
  logs: SetupLogEntry[];
  subscribers: Set<SseWriter>;
  startedAt: number;
  finishedAt?: number;
  /** The prompt the pipeline is currently blocked on (replayed to reattachers). */
  pendingPrompt?: SetupPrompt;
}

export type SseWriter = (event: string, data: string) => boolean;

// ─── Cache ───────────────────────────────────────────────────────────────────

/** Active setup sessions - keyed by session ID. TTL 30 min. */
const sessions = new TtlCache<SetupSessionState>({
  maxSize: 50,
  sweepIntervalMs: 60_000,
});

// ─── Heartbeat ───────────────────────────────────────────────────────────────

const heartbeatTimer = setInterval(() => {
  for (const session of sessions.values()) {
    const dead: SseWriter[] = [];
    for (const writer of session.subscribers) {
      const ok = writer("ping", "{}");
      if (!ok) dead.push(writer);
    }
    for (const w of dead) session.subscribers.delete(w);
  }
}, 15_000);

if (heartbeatTimer.unref) heartbeatTimer.unref();

// ─── Public API ──────────────────────────────────────────────────────────────

/** Create a new setup session. */
export function createSetupSession(
  componentNames: { name: string; label: string }[],
  serverId: string,
): SetupSessionState {
  const id = `setup_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const state: SetupSessionState = {
    id,
    serverId,
    status: "running",
    components: componentNames.map((c) => ({
      name: c.name,
      label: c.label,
      status: "pending",
    })),
    logs: [],
    subscribers: new Set(),
    startedAt: Date.now(),
  };
  sessions.set(id, state, 1800); // 30 min TTL
  return state;
}

/** Get a session by ID. */
export function getSetupSession(id: string): SetupSessionState | null {
  return sessions.get(id);
}

/** Get the currently active session (status === "running"). */
export function getActiveSetupSession(): SetupSessionState | null {
  for (const session of sessions.values()) {
    if (session.status === "running") return session;
  }
  return null;
}

/** Update a component's progress and broadcast. */
export function updateComponentProgress(
  sessionId: string,
  componentName: string,
  status: ComponentProgress["status"],
  error?: string,
): void {
  const session = sessions.get(sessionId);
  if (!session) return;

  const comp = session.components.find((c) => c.name === componentName);
  if (comp) {
    comp.status = status;
    comp.error = error;
  }

  broadcast(session, "progress", JSON.stringify({
    type: "progress",
    component: componentName,
    status,
    error,
    components: session.components,
  }));
}

/** Append a log entry and broadcast to subscribers. */
export function appendSetupLog(
  sessionId: string,
  component: string,
  message: string,
  level: SetupLogEntry["level"] = "info",
): void {
  const session = sessions.get(sessionId);
  if (!session) return;

  const entry: SetupLogEntry = {
    timestamp: new Date().toISOString(),
    component,
    message,
    level,
  };

  session.logs.push(entry);
  // Cap logs for memory safety
  if (session.logs.length > 5000) {
    session.logs.splice(0, session.logs.length - 5000);
  }

  broadcast(session, "log", JSON.stringify({
    type: "log",
    ...entry,
  }));
}

// ─── Interactive prompts (the "hold" mechanism) ────────────────────────────────

/**
 * A prompt the install pipeline is blocked on while the user decides in the
 * dashboard. Mirrors the deploy session manager's prompt/respond so the SAME
 * generic prompt modal drives both flows (e.g. OpenResty edge takeover).
 */
// The block-on-a-promise + timeout mechanic lives once in PromptRegistry; this
// manager keeps only the session-object hold (pendingPrompt, for replay) + the
// SSE broadcast.
const promptRegistry = new PromptRegistry();

export function rejectPendingSetupPrompt(sessionId: string, reason: string): void {
  const session = sessions.get(sessionId);
  if (session) session.pendingPrompt = undefined;
  promptRegistry.reject(sessionId, reason);
}

/** Is a session currently blocked on a prompt, and does anyone hold its stream? */
export function setupPromptState(sessionId: string): { pending: boolean; subscribers: number } {
  const session = sessions.get(sessionId);
  return { pending: Boolean(session?.pendingPrompt), subscribers: session?.subscribers.size ?? 0 };
}

/**
 * Broadcast a `prompt` SSE event and block until the user responds (or timeout).
 * Returns the chosen action id (e.g. "override", "cancel").
 */
export function promptSetupUser(sessionId: string, prompt: PromptPayload): Promise<string> {
  const session = sessions.get(sessionId);
  if (!session) throw new Error("No active setup session for prompt");

  // Persist so a reattaching client (page reload / dropped socket) can re-render
  // the modal — the broadcast only reaches sockets open right now.
  session.pendingPrompt = prompt;
  broadcast(session, "prompt", JSON.stringify({ type: "prompt", ...prompt }));

  return promptRegistry.wait(sessionId);
}

/** Resolve a pending prompt with the user's chosen action. */
export function respondToSetupPrompt(sessionId: string, action: string): boolean {
  const ok = promptRegistry.respond(sessionId, action);
  if (ok) {
    const session = sessions.get(sessionId);
    if (session) session.pendingPrompt = undefined;
  }
  return ok;
}

/** Mark the session as completed or failed and notify subscribers. */
export function finishSetupSession(
  sessionId: string,
  status: "completed" | "failed",
): void {
  const session = sessions.get(sessionId);
  if (!session) return;

  // A finished session can't answer a prompt - unblock the pipeline.
  rejectPendingSetupPrompt(sessionId, "Setup session finished");

  session.status = status;
  session.finishedAt = Date.now();

  broadcast(session, "complete", JSON.stringify({
    type: "complete",
    status,
    components: session.components,
    durationMs: session.finishedAt - session.startedAt,
  }));

  // Send end event and close all subscribers
  const endPayload = JSON.stringify({ type: "end", status });
  for (const writer of session.subscribers) {
    writer("end", endPayload);
  }
  session.subscribers.clear();
}

/** Subscribe an SSE writer to a session; replays existing logs. */
export function subscribeSetupSession(
  sessionId: string,
  writer: SseWriter,
): { success: boolean; unsubscribe: () => void } {
  const session = sessions.get(sessionId);
  if (!session) return { success: false, unsubscribe: () => {} };

  // Enforce subscriber limit
  if (session.subscribers.size >= 10) {
    const oldest = session.subscribers.values().next().value;
    if (oldest) {
      oldest("end", JSON.stringify({ message: "Evicted: subscriber limit reached" }));
      session.subscribers.delete(oldest);
    }
  }

  session.subscribers.add(writer);

  // Replay current progress state
  writer("progress", JSON.stringify({
    type: "progress",
    component: null,
    status: session.status,
    components: session.components,
  }));

  // Replay existing logs
  for (const entry of session.logs) {
    const ok = writer("log", JSON.stringify({ type: "log", ...entry }));
    if (!ok) {
      session.subscribers.delete(writer);
      return { success: false, unsubscribe: () => {} };
    }
  }

  // Re-surface an unanswered prompt so a reattached stream (page reload / dropped
  // socket) can render the modal — otherwise the pipeline hangs until timeout.
  if (session.status === "running" && session.pendingPrompt) {
    writer("prompt", JSON.stringify({ type: "prompt", ...session.pendingPrompt }));
  }

  // If session already finished, send completion + end
  if (session.status !== "running") {
    writer("complete", JSON.stringify({
      type: "complete",
      status: session.status,
      components: session.components,
      durationMs: (session.finishedAt ?? Date.now()) - session.startedAt,
    }));
    writer("end", JSON.stringify({ type: "end", status: session.status }));
    session.subscribers.delete(writer);
  }

  return {
    success: true,
    unsubscribe: () => session.subscribers.delete(writer),
  };
}

/** Remove a session. */
export function removeSetupSession(id: string): void {
  rejectPendingSetupPrompt(id, "Setup session removed");
  const session = sessions.get(id);
  if (session) {
    for (const writer of session.subscribers) {
      writer("end", JSON.stringify({ message: "Session removed" }));
    }
    session.subscribers.clear();
  }
  sessions.delete(id);
}

// ─── Internal ────────────────────────────────────────────────────────────────

function broadcast(session: SetupSessionState, event: string, data: string): void {
  const dead: SseWriter[] = [];
  for (const writer of session.subscribers) {
    const ok = writer(event, data);
    if (!ok) dead.push(writer);
  }
  for (const w of dead) session.subscribers.delete(w);
}
