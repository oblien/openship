/**
 * Server container-apply session — the replayable transport for a single
 * edge/mail image swap on one server.
 *
 * Same shape as the edge-consent session (in-memory `TtlCache` of sessions,
 * each holding a log ring + a subscriber set, replayed on subscribe so a client
 * can RE-ATTACH to an in-flight swap), minus the prompt machinery — a container
 * update never blocks on the user. It adds a small fixed STEP model (pull →
 * recreate → verify) so the modal can render a percentage bar, driven from the
 * reconcile's own log lines by {@link advanceStep}.
 *
 * One running session per (server, component): both the manual "Update" click
 * and the boot-time auto-update go through {@link runContainerApply}, which
 * reuses the active session if one exists — so the two paths never double-swap
 * and a late-arriving watcher sees the same progress.
 */

import { TtlCache } from "./cache";

export type SseWriter = (event: string, data: string) => boolean;
export type ContainerSessionStatus = "running" | "completed" | "failed";
export type ContainerComponent = "edge" | "mail";

export type StepId = "pull" | "recreate" | "verify";
export type StepStatus = "pending" | "running" | "done" | "error";

export interface ContainerStep {
  id: StepId;
  label: string;
  status: StepStatus;
}

export interface ContainerLogEntry {
  timestamp: string;
  message: string;
  level: "info" | "warn" | "error";
}

export interface ContainerApplyResult {
  updated: boolean;
  down: boolean;
}

export interface ContainerApplySession {
  id: string;
  serverId: string;
  component: ContainerComponent;
  status: ContainerSessionStatus;
  steps: ContainerStep[];
  logs: ContainerLogEntry[];
  subscribers: Set<SseWriter>;
  startedAt: number;
  finishedAt?: number;
  /** Populated when the swap reports its outcome (drives the terminal event). */
  result?: ContainerApplyResult;
  /** Failure detail, surfaced on the `error`/`complete` frame. */
  error?: string;
  /** Resolves when the background swap settles — awaited by the auto path. */
  donePromise?: Promise<ContainerApplyResult>;
}

const sessions = new TtlCache<ContainerApplySession>({ maxSize: 100, sweepIntervalMs: 60_000 });

const heartbeat = setInterval(() => {
  for (const session of sessions.values()) {
    const dead: SseWriter[] = [];
    for (const w of session.subscribers) if (!w("ping", "{}")) dead.push(w);
    for (const w of dead) session.subscribers.delete(w);
  }
}, 15_000);
if (heartbeat.unref) heartbeat.unref();

function seedSteps(component: ContainerComponent): ContainerStep[] {
  const noun = component === "edge" ? "edge" : "mail engine";
  return [
    { id: "pull", label: `Pull the new ${noun} image`, status: "pending" },
    { id: "recreate", label: `Recreate the ${noun} container`, status: "pending" },
    { id: "verify", label: `Verify the ${noun} is serving`, status: "pending" },
  ];
}

function broadcast(session: ContainerApplySession, event: string, data: string): void {
  const dead: SseWriter[] = [];
  for (const w of session.subscribers) if (!w(event, data)) dead.push(w);
  for (const w of dead) session.subscribers.delete(w);
}

function stepsFrame(session: ContainerApplySession): string {
  return JSON.stringify({ type: "steps", steps: session.steps });
}

/** The one running session for a (server, component), if any. */
export function getActiveContainerApplySession(
  serverId: string,
  component: ContainerComponent,
): ContainerApplySession | null {
  for (const s of sessions.values()) {
    if (s.serverId === serverId && s.component === component && s.status === "running") return s;
  }
  return null;
}

export function createContainerApplySession(
  serverId: string,
  component: ContainerComponent,
): ContainerApplySession {
  const id = `capp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const session: ContainerApplySession = {
    id,
    serverId,
    component,
    status: "running",
    steps: seedSteps(component),
    logs: [],
    subscribers: new Set(),
    startedAt: Date.now(),
  };
  sessions.set(id, session, 1800); // 30 min TTL
  return session;
}

export function getContainerApplySession(id: string): ContainerApplySession | null {
  return sessions.get(id);
}

export function appendContainerLog(
  sessionId: string,
  message: string,
  level: ContainerLogEntry["level"] = "info",
): void {
  const session = sessions.get(sessionId);
  if (!session) return;
  const entry: ContainerLogEntry = { timestamp: new Date().toISOString(), message, level };
  session.logs.push(entry);
  if (session.logs.length > 2000) session.logs.splice(0, session.logs.length - 2000);
  broadcast(session, "log", JSON.stringify({ type: "log", ...entry }));
}

const STEP_ORDER: StepId[] = ["pull", "recreate", "verify"];

function setStep(session: ContainerApplySession, id: StepId, status: StepStatus): void {
  const step = session.steps.find((s) => s.id === id);
  if (!step) return;
  // Monotonic: a later log line never drags a completed step back to running.
  const rank = { pending: 0, running: 1, done: 2, error: 2 } as const;
  if (rank[status] < rank[step.status]) return;
  step.status = status;
}

/**
 * Advance the step model from a reconcile log line. The swap paths in
 * `ensureContainerEdge` / `ensureContainerMail` emit a stable sentence per phase
 * ("Updating the …" → pull, docker's "Status: …" → image in hand, "… updated to
 * …" → live); everything else is pull-output noise that keeps `pull` running.
 * Best-effort — an unmatched line just leaves the bar where it is.
 */
export function advanceStep(sessionId: string, message: string): void {
  const session = sessions.get(sessionId);
  if (!session) return;
  const m = message.toLowerCase();

  if (/rollback to .* also failed|is down on this server/.test(m)) {
    for (const id of STEP_ORDER) if (session.steps.find((s) => s.id === id)!.status !== "done") setStep(session, id, "error");
  } else if (/could not pull/.test(m)) {
    setStep(session, "pull", "error");
  } else if (/failed to come up|rolling back/.test(m)) {
    setStep(session, "recreate", "error");
    setStep(session, "verify", "error");
  } else if (/^updating the |^pulling /.test(m)) {
    setStep(session, "pull", "running");
  } else if (/^status: (downloaded|image is up to date)/.test(m)) {
    setStep(session, "pull", "done");
    setStep(session, "recreate", "running");
  } else if (/updated to |container running/.test(m)) {
    setStep(session, "pull", "done");
    setStep(session, "recreate", "done");
    setStep(session, "verify", "done");
  }

  broadcast(session, "steps", stepsFrame(session));
}

export function finishContainerApplySession(
  sessionId: string,
  status: "completed" | "failed",
  result?: ContainerApplyResult,
  error?: string,
): void {
  const session = sessions.get(sessionId);
  if (!session) return;
  session.status = status;
  session.result = result;
  session.error = error;
  session.finishedAt = Date.now();
  // On success, any step the classifier left short of "done" is now settled.
  if (status === "completed") for (const s of session.steps) if (s.status !== "error") s.status = "done";
  broadcast(session, "steps", stepsFrame(session));
  broadcast(
    session,
    "complete",
    JSON.stringify({ type: "complete", status, result: result ?? null, error: error ?? null }),
  );
  const end = JSON.stringify({ type: "end", status });
  for (const w of session.subscribers) w("end", end);
  session.subscribers.clear();
}

/** Subscribe an SSE writer; replays steps + logs + any terminal (reattach). */
export function subscribeContainerApplySession(
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

  writer("steps", stepsFrame(session));
  for (const entry of session.logs) {
    if (!writer("log", JSON.stringify({ type: "log", ...entry }))) {
      session.subscribers.delete(writer);
      return { success: false, unsubscribe: () => {} };
    }
  }
  if (session.status !== "running") {
    writer(
      "complete",
      JSON.stringify({
        type: "complete",
        status: session.status,
        result: session.result ?? null,
        error: session.error ?? null,
      }),
    );
    writer("end", JSON.stringify({ type: "end", status: session.status }));
    session.subscribers.delete(writer);
  }

  return { success: true, unsubscribe: () => session.subscribers.delete(writer) };
}
