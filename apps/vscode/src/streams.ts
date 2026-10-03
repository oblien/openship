import { setTimeout as delay } from "node:timers/promises";
import { TextDecoder } from "node:util";
import {
  ApiError,
  consumeDeploymentEvents,
  type DeploymentEvent,
  type DeploymentOutcome,
  type LogEntry,
  type OpenshipClient,
} from "@repo/sdk/client";
import { cleanText, errorMessage } from "./errors";
import { isRecord } from "./model";

export interface LogSink {
  append(text: string): void;
  appendLine(text: string): void;
}

const finished = new Set([
  "ready",
  "failed",
  "cancelled",
  "partial_failure",
  "action_required",
  "rejected",
  "no_changes",
]);

function renderSnapshot(entries: LogEntry[], sink: LogSink): void {
  const decoders = new Map<string, TextDecoder>();
  for (const entry of entries) {
    if (entry.rawData) {
      const key = entry.serviceId ?? "";
      let decoder = decoders.get(key);
      if (!decoder) decoders.set(key, (decoder = new TextDecoder()));
      sink.append(
        cleanText(decoder.decode(Buffer.from(entry.rawData, "base64"), { stream: true })),
      );
    } else sink.appendLine(cleanText(entry.message));
  }
}

function reportOutcome(outcome: DeploymentOutcome, sink: LogSink): DeploymentOutcome {
  sink.appendLine(`\nDeployment status: ${outcome.status}`);
  if (outcome.message) sink.appendLine(cleanText(outcome.message));
  if (outcome.warning) sink.appendLine(cleanText(outcome.warning));
  return outcome;
}

/** Keep one decoder across reconnects, and resume from the last consumed event. */
export async function* deploymentEvents(
  client: OpenshipClient,
  id: string,
  signal: AbortSignal,
  sink: LogSink,
  retryDelayMs = 500,
): AsyncGenerator<DeploymentEvent> {
  let since: number | undefined;
  for (let retry = 0; ; retry++) {
    signal.throwIfAborted();
    try {
      for await (const event of client.deployments.events(id, { since, signal })) {
        if (event.id !== undefined && /^\d+$/.test(event.id)) {
          const cursor = Number(event.id);
          if (Number.isSafeInteger(cursor)) {
            if (since !== undefined && cursor <= since) continue;
            since = cursor;
          }
        }
        yield event;
        if (event.event === "end" || event.event === "error") return;
      }
      throw new Error("The deployment log stream disconnected.");
    } catch (error) {
      if (
        signal.aborted ||
        retry >= 3 ||
        (error instanceof ApiError && [401, 403, 404].includes(error.status))
      )
        throw error;
      sink.appendLine("\nReconnecting deployment logs…");
      await delay(retryDelayMs * 2 ** retry, undefined, { signal });
    }
  }
}

async function* preferRawLogs(
  events: AsyncIterable<DeploymentEvent>,
): AsyncGenerator<DeploymentEvent> {
  for await (const event of events) {
    // Runtime events include both a text preview and raw bytes. The preview
    // may have decoded an incomplete UTF-8 chunk; the SDK's streaming decoder
    // must receive the raw bytes to preserve multibyte output and line breaks.
    if (event.event === "log") {
      try {
        const payload: unknown = JSON.parse(event.data);
        if (isRecord(payload) && typeof payload.data === "string" && payload.data) {
          delete payload.message;
          yield { ...event, data: JSON.stringify(payload) };
          continue;
        }
      } catch {
        /* Plain text log events are also supported by the SDK. */
      }
    }
    yield event;
  }
}

async function renderEvents(events: AsyncIterable<DeploymentEvent>, sink: LogSink) {
  return consumeDeploymentEvents(preferRawLogs(events), (event) => {
    if (event.log !== undefined) {
      if (typeof event.payload.message === "string") sink.appendLine(cleanText(event.log));
      else sink.append(cleanText(event.log));
    }
    if (event.event === "error") {
      sink.appendLine(
        cleanText(
          typeof event.payload.error === "string"
            ? event.payload.error
            : "The log stream reported an error.",
        ),
      );
    }
  });
}

export async function watchDeployment(
  client: OpenshipClient,
  id: string,
  signal: AbortSignal,
  sink: LogSink,
  options: { pollIntervalMs?: number; retryDelayMs?: number } = {},
) {
  // A finished deployment may have no live session. Fetch its persisted logs
  // before the status waiter can return and close the subscription.
  const initial = await client.deployments.buildStatus(id);
  signal.throwIfAborted();
  if (
    finished.has(initial.deploymentStatus) &&
    !initial.completionPending &&
    !initial.cancellationPending
  ) {
    try {
      renderSnapshot(await client.deployments.logs(id, { tail: 500 }), sink);
    } catch (error) {
      if (!signal.aborted) sink.appendLine(`Logs unavailable: ${errorMessage(error)}`);
    }
    signal.throwIfAborted();
    return reportOutcome(
      await client.deployment(id).wait({ signal, pollIntervalMs: options.pollIntervalMs ?? 2000 }),
      sink,
    );
  }
  const streaming = new AbortController();
  const streamSignal = AbortSignal.any([signal, streaming.signal]);
  const logs = renderEvents(
    deploymentEvents(client, id, streamSignal, sink, options.retryDelayMs),
    sink,
  ).catch((error) => {
    if (!streamSignal.aborted)
      sink.appendLine(
        `\nLogs unavailable: ${errorMessage(error)}\nStill checking deployment status…`,
      );
  });
  try {
    // An ended SSE stream is not a successful deployment. The SDK checks
    // persisted state, cleanup leases, cancellation, and pending decisions.
    const outcome = await client
      .deployment(id)
      .wait({ signal, pollIntervalMs: options.pollIntervalMs ?? 2000 });
    return reportOutcome(outcome, sink);
  } finally {
    streaming.abort();
    await logs;
  }
}

export async function watchRuntimeLogs(
  client: OpenshipClient,
  projectId: string,
  signal: AbortSignal,
  sink: LogSink,
) {
  await renderEvents(client.projects.streamRuntimeLogs(projectId, { tail: 200 }, { signal }), sink);
  if (!signal.aborted)
    sink.appendLine("\nApplication log stream ended. Run Show Application Logs to reconnect.");
}
