import { reportCaughtError as observeCaughtError } from "@repo/core/diagnostics";
import { randomUUID } from "node:crypto";
import { AppError, safeErrorMessage } from "@repo/core";
import type { ProjectRoutingRetry, ProjectRoutingStreamOptions } from "@repo/contracts";
import type { ExecutionContext } from "../../../context";
import type { EventSubscription } from "../../../event-stream";
import { TtlCache } from "../../../state/cache";
import { audit, operationAuditContext } from "../../lib/audit-emitter";
import { trackBackgroundWork } from "../../lib/background-work";
import { createRunBus } from "../../lib/run-bus";
import { canRouteSelfApp } from "../../lib/self-app-routing";
import { verifyProjectRoutingDomains } from "../domains/domain.operations";
import { retryProjectRouting } from "./project-runtime.service";

type RoutingResult = Awaited<ReturnType<typeof retryProjectRouting>>;
type LogEvent = { type: "log"; message: string; level: "info" | "error" };
type CompleteEvent = { type: "complete"; status: "completed" | "failed" };
interface RoutingSession extends ProjectRoutingRetry {
  organizationId: string;
  projectId: string;
  logs: LogEvent[];
  logSize: number;
  requestKeys: Set<string>;
  done?: Promise<RoutingResult>;
}

// Like the server apply sessions, these belong to the running engine. A browser
// disconnect does not cancel work. Bound retained output and expire finished
// sessions, but never evict an active repair and accidentally allow a second one.
const sessions = new TtlCache<RoutingSession>({
  maxSize: 100,
  sweepIntervalMs: 0,
  canEvict: (session) => session.status !== "running",
});
const bus = createRunBus<LogEvent | CompleteEvent>((event) => event.type === "complete");

function latestSession(organizationId: string, projectId: string): RoutingSession | null {
  let latest: RoutingSession | null = null;
  for (const session of sessions.values()) {
    if (session.organizationId === organizationId && session.projectId === projectId)
      latest = session;
  }
  return latest;
}

/** Discovery for the canonical project read, without logs or another operation. */
export function getProjectRoutingRetry(
  organizationId: string,
  projectId: string,
): ProjectRoutingRetry | null {
  const session = latestSession(organizationId, projectId);
  if (!session) return null;
  return {
    sessionId: session.sessionId,
    status: session.status,
    startedAt: session.startedAt,
    ...(session.finishedAt === undefined ? {} : { finishedAt: session.finishedAt }),
  };
}

function appendLog(session: RoutingSession, message: string, level: LogEvent["level"] = "info") {
  const event: LogEvent = { type: "log", message: message.slice(-16_384), level };
  session.logs.push(event);
  session.logSize += event.message.length;
  while (session.logs.length > 500 || session.logSize > 512 * 1024)
    session.logSize -= session.logs.shift()!.message.length;
  bus.publish(session.sessionId, event);
}

async function runRoutingRetry(
  ctx: ExecutionContext,
  id: string,
  onLog?: (message: string) => void,
) {
  const isSelfApp = await canRouteSelfApp(ctx, id);
  const result = await retryProjectRouting(id, ctx.organizationId, {
    isSelfApp,
    onLog,
    verifyDomains: () => verifyProjectRoutingDomains(ctx, id, onLog),
  });
  audit.recordAsync(operationAuditContext(ctx), {
    eventType: "project.updated",
    resourceType: "project",
    resourceId: id,
    after: { action: "routing_retried", ok: result.ok },
  });
  return result;
}

function startRoutingRetry(
  ctx: ExecutionContext,
  id: string,
  idempotencyKey?: string,
): RoutingSession {
  if (idempotencyKey) {
    for (const session of sessions.values()) {
      if (
        session.organizationId === ctx.organizationId &&
        session.projectId === id &&
        session.requestKeys.has(idempotencyKey)
      )
        return session;
    }
  }
  const active = latestSession(ctx.organizationId, id);
  if (active?.status === "running") {
    if (idempotencyKey) {
      if (active.requestKeys.size >= 256)
        throw new AppError(
          "A routing repair is already running. Reopen its log to follow progress.",
          429,
          "ROUTING_RETRY_BUSY",
        );
      active.requestKeys.add(idempotencyKey);
    }
    return active;
  }
  const session: RoutingSession = {
    sessionId: `routing_${randomUUID()}`,
    organizationId: ctx.organizationId,
    projectId: id,
    status: "running",
    startedAt: Date.now(),
    logs: [],
    logSize: 0,
    requestKeys: new Set(idempotencyKey ? [idempotencyKey] : []),
  };
  try {
    sessions.set(session.sessionId, session, Infinity);
  } catch (diagnosticFailure) {
    observeCaughtError(diagnosticFailure, "platform/engine/modules/projects/project-routing-retry.operations");
    throw new AppError(
      "Routing repairs are busy. Please retry shortly.",
      503,
      "ROUTING_RETRY_BUSY",
    );
  }
  session.done = trackBackgroundWork(
    Promise.resolve().then(async () => {
      try {
        const result = await runRoutingRetry(ctx, id, (message) => appendLog(session, message));
        // The result aggregates errors already streamed while applying routes.
        const loggedLines = new Set(
          session.logs.flatMap((log) => log.message.split("\n").map((line) => line.trim())),
        );
        const message = result.ok
          ? "Routing and domain checks completed."
          : result.warning
              ?.split("\n")
              .filter((line) => !loggedLines.has(line.trim()))
              .join("\n");
        if (message) appendLog(session, message, result.ok ? "info" : "error");
        session.status = result.ok ? "completed" : "failed";
        return result;
      } catch (error) {
        appendLog(session, safeErrorMessage(error), "error");
        session.status = "failed";
        throw error;
      } finally {
        if (session.status === "running") session.status = "failed";
        session.finishedAt = Date.now();
        sessions.set(session.sessionId, session, 30 * 60);
        bus.publish(session.sessionId, { type: "complete", status: session.status });
      }
    }),
  );
  // Streaming callers observe the recorded failure, while JSON callers still
  // receive the original rejection. Do not leave an unhandled background promise.
  void session.done.catch((diagnosticFailure) => {
    observeCaughtError(diagnosticFailure, "platform/engine/modules/projects/project-routing-retry.operations");
  });
  return session;
}

/** JSON and streamed requests join the same active repair and audit it once. */
export async function retryProjectRoutingOperation(
  ctx: ExecutionContext,
  id: string,
  onLog?: (message: string) => void,
) {
  const session = startRoutingRetry(ctx, id);
  const unsubscribe = onLog
    ? bus.subscribe(session.sessionId, (event) => {
        if (event.type === "log") onLog(event.message);
      })
    : () => {};
  try {
    if (onLog) for (const log of session.logs) onLog(log.message);
    return await session.done!;
  } finally {
    unsubscribe();
  }
}

export function subscribeRoutingRetry(
  ctx: ExecutionContext,
  id: string,
  options: Omit<ProjectRoutingStreamOptions, "signal"> = {},
): EventSubscription {
  return (write) => {
    const session =
      options.sessionId === undefined
        ? startRoutingRetry(ctx, id, options.idempotencyKey)
        : sessions.get(options.sessionId);
    if (!session || session.organizationId !== ctx.organizationId || session.projectId !== id)
      throw new AppError(
        "This routing log is no longer available. Refresh the project to check its routes.",
        404,
        "ROUTING_RETRY_NOT_FOUND",
      );
    let closed = false;
    let unsubscribe = () => {};
    const emit = (event: string, data: unknown) => {
      if (!closed && !write(event, JSON.stringify(data))) {
        closed = true;
        unsubscribe();
      }
    };
    // Subscription + replay are synchronous, so no log can land between them.
    unsubscribe = bus.subscribe(session.sessionId, (event) => emit(event.type, event));
    emit("session", { type: "session", sessionId: session.sessionId });
    for (const log of session.logs) emit("log", log);
    if (session.status !== "running") {
      emit("complete", { type: "complete", status: session.status });
      unsubscribe();
    }
    return {
      success: true,
      unsubscribe: () => {
        closed = true;
        unsubscribe();
      },
    };
  };
}
