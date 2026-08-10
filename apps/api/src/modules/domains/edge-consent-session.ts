/**
 * Edge-consent session — the transport for the project-scoped "ensure edge (+
 * apply routes)" trigger. It's the SAME generic prompt contract the deploy
 * pipeline and server-setup use (`PromptPayload` + `PromptRegistry` + an SSE
 * `prompt` event + a `/respond` endpoint), just keyed by a routing session id
 * instead of a build/setup session — so the ONE port-80/443 takeover consent
 * modal is reachable from route-apply without a container redeploy.
 *
 * Deliberately its own tiny store (not the server-setup session) so a project's
 * edge takeover never shows up as an "active server setup" and vice-versa.
 */

import type { PromptPayload } from "@repo/adapters";
import { PromptRegistry } from "../../lib/prompt-gateway";
import { TtlCache } from "../../lib/cache";

export type SseWriter = (event: string, data: string) => boolean;
export type EdgeSessionStatus = "running" | "completed" | "failed";

export interface EdgeLogEntry {
  timestamp: string;
  message: string;
  level: "info" | "warn" | "error";
}

export interface EdgeConsentSession {
  id: string;
  projectId: string;
  status: EdgeSessionStatus;
  logs: EdgeLogEntry[];
  subscribers: Set<SseWriter>;
  startedAt: number;
  finishedAt?: number;
  /** The prompt the flow is blocked on (replayed to reattaching clients). */
  pendingPrompt?: PromptPayload;
}

const sessions = new TtlCache<EdgeConsentSession>({ maxSize: 50, sweepIntervalMs: 60_000 });
const promptRegistry = new PromptRegistry();

const heartbeat = setInterval(() => {
  for (const session of sessions.values()) {
    const dead: SseWriter[] = [];
    for (const w of session.subscribers) if (!w("ping", "{}")) dead.push(w);
    for (const w of dead) session.subscribers.delete(w);
  }
}, 15_000);
if (heartbeat.unref) heartbeat.unref();

function broadcast(session: EdgeConsentSession, event: string, data: string): void {
  const dead: SseWriter[] = [];
  for (const w of session.subscribers) if (!w(event, data)) dead.push(w);
  for (const w of dead) session.subscribers.delete(w);
}

/** One in-flight edge-consent session per project (serialize edge ops). */
export function getActiveEdgeSessionForProject(projectId: string): EdgeConsentSession | null {
  for (const s of sessions.values()) {
    if (s.projectId === projectId && s.status === "running") return s;
  }
  return null;
}

export function createEdgeConsentSession(projectId: string): EdgeConsentSession {
  const id = `edge_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const session: EdgeConsentSession = {
    id,
    projectId,
    status: "running",
    logs: [],
    subscribers: new Set(),
    startedAt: Date.now(),
  };
  sessions.set(id, session, 1800); // 30 min TTL
  return session;
}

export function getEdgeConsentSession(id: string): EdgeConsentSession | null {
  return sessions.get(id);
}

export function appendEdgeLog(
  sessionId: string,
  message: string,
  level: EdgeLogEntry["level"] = "info",
): void {
  const session = sessions.get(sessionId);
  if (!session) return;
  const entry: EdgeLogEntry = { timestamp: new Date().toISOString(), message, level };
  session.logs.push(entry);
  if (session.logs.length > 2000) session.logs.splice(0, session.logs.length - 2000);
  broadcast(session, "log", JSON.stringify({ type: "log", ...entry }));
}

/** Broadcast a prompt and block until the user responds (or timeout). */
export function promptEdgeUser(sessionId: string, prompt: PromptPayload): Promise<string> {
  const session = sessions.get(sessionId);
  if (!session) throw new Error("No active edge-consent session for prompt");
  session.pendingPrompt = prompt;
  broadcast(session, "prompt", JSON.stringify({ type: "prompt", ...prompt }));
  return promptRegistry.wait(sessionId);
}

/** Resolve a pending prompt with the user's chosen action id. */
export function respondToEdgePrompt(sessionId: string, action: string): boolean {
  const ok = promptRegistry.respond(sessionId, action);
  if (ok) {
    const session = sessions.get(sessionId);
    if (session) session.pendingPrompt = undefined;
  }
  return ok;
}

export function finishEdgeConsentSession(sessionId: string, status: "completed" | "failed"): void {
  const session = sessions.get(sessionId);
  if (!session) return;
  // A finished flow can't answer a prompt — unblock any waiter.
  session.pendingPrompt = undefined;
  promptRegistry.reject(sessionId, "Edge-consent session finished");
  session.status = status;
  session.finishedAt = Date.now();
  broadcast(session, "complete", JSON.stringify({ type: "complete", status }));
  const end = JSON.stringify({ type: "end", status });
  for (const w of session.subscribers) w("end", end);
  session.subscribers.clear();
}

/** Subscribe an SSE writer; replays logs + any unanswered prompt (reattach). */
export function subscribeEdgeConsentSession(
  sessionId: string,
  writer: SseWriter,
): { success: boolean; unsubscribe: () => void } {
  const session = sessions.get(sessionId);
  if (!session) return { success: false, unsubscribe: () => {} };

  if (session.subscribers.size >= 10) {
    const oldest = session.subscribers.values().next().value;
    if (oldest) {
      oldest("end", JSON.stringify({ message: "Evicted: subscriber limit reached" }));
      session.subscribers.delete(oldest);
    }
  }
  session.subscribers.add(writer);

  for (const entry of session.logs) {
    if (!writer("log", JSON.stringify({ type: "log", ...entry }))) {
      session.subscribers.delete(writer);
      return { success: false, unsubscribe: () => {} };
    }
  }
  if (session.status === "running" && session.pendingPrompt) {
    writer("prompt", JSON.stringify({ type: "prompt", ...session.pendingPrompt }));
  }
  if (session.status !== "running") {
    writer("complete", JSON.stringify({ type: "complete", status: session.status }));
    writer("end", JSON.stringify({ type: "end", status: session.status }));
    session.subscribers.delete(writer);
  }

  return { success: true, unsubscribe: () => session.subscribers.delete(writer) };
}
