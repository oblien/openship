import { AsyncLocalStorage } from "node:async_hooks";
import { writeSync } from "node:fs";
import type { Writable } from "node:stream";
import {
  errorReporter,
  diagnosticContext,
  diagnosticId,
  mergeDiagnosticContext,
  setDiagnosticOutputGuard,
} from "./reporter";
import type { ErrorContext, ErrorSink } from "./types";

const contexts = new AsyncLocalStorage<ErrorContext>();
const observedOutputs = new WeakSet<Writable>();
errorReporter.setContextProvider(() => contexts.getStore() ?? {});
setDiagnosticOutputGuard(() => {
  // console.error ignores Writable backpressure. Keep the emergency destination
  // bounded when Node's stderr stalls, including before reporting is enabled.
  const output = process.stderr;
  return (
    !output.destroyed &&
    output.writable !== false &&
    !output.writableNeedDrain &&
    output.writableLength < 65_536
  );
});

export function currentErrorContext(): ErrorContext {
  return { ...contexts.getStore() };
}

/** Stores identifiers only, never the request, authenticated user, or credentials. */
export function withErrorContext<T>(context: ErrorContext, fn: () => T, replace = false): T {
  const parent = replace ? {} : currentErrorContext();
  return contexts.run(mergeDiagnosticContext(parent, context), fn);
}

/** Enrich this request frame after authorization; never sets a process-global user. */
export function enrichErrorContext(context: ErrorContext): void {
  const frame = contexts.getStore();
  if (frame) Object.assign(frame, diagnosticContext(context));
}

export async function observeOperation<T>(context: ErrorContext, fn: () => Promise<T>): Promise<T> {
  return withErrorContext(context, async () => {
    try {
      return await fn();
    } catch (error) {
      errorReporter.capture(error, { kind: "operation", handled: true });
      throw error;
    }
  });
}

/** A background task starts a fresh frame; a cron tick cannot inherit a tenant. */
export async function observeBackground<T>(
  context: ErrorContext,
  fn: () => Promise<T>,
): Promise<T> {
  return withErrorContext(
    {
      source: "worker",
      kind: "background",
      traceId: diagnosticId(),
      ...context,
    },
    async () => {
      try {
        return await fn();
      } catch (error) {
        errorReporter.capture(error, { kind: "background", handled: true });
        throw error;
      }
    },
    true,
  );
}

/** Backpressure is awaited by the reporter's single consumer, never a request. */
export function writableErrorSink(stream: Writable): ErrorSink {
  if (!observedOutputs.has(stream)) {
    observedOutputs.add(stream);
    // Writable emits 'error' after its failed write callback, possibly after
    // cancellation. Keep one passive listener so an unavailable log output
    // cannot become an uncaught process error after the per-batch listener left.
    stream.on("error", () => {});
  }
  return (events, signal) =>
    new Promise<void>((resolve, reject) => {
      if (signal.aborted) {
        reject(new Error("Diagnostic delivery cancelled"));
        return;
      }
      const done = (error?: Error | null) => {
        signal.removeEventListener("abort", aborted);
        stream.removeListener("error", failed);
        if (error) reject(error);
        else resolve();
      };
      const failed = (error: Error) => done(error);
      const aborted = () => done(new Error("Diagnostic delivery cancelled"));
      signal.addEventListener("abort", aborted, { once: true });
      stream.once("error", failed);
      try {
        stream.write(events.map((event) => JSON.stringify(event)).join("\n") + "\n", done);
      } catch (error) {
        done(error instanceof Error ? error : new Error("Diagnostic output failed"));
      }
    });
}

let installed = false;
/** Records fatal errors without swallowing them or keeping a corrupt process alive. */
export function installNodeErrorReporting(source: ErrorContext["source"]): void {
  if (installed) return;
  installed = true;
  errorReporter.setContextProvider(() => ({ source, ...contexts.getStore() }));
  errorReporter.setSink(writableErrorSink(process.stderr));
  const localWrite = (event: import("./types").ErrorEvent) => {
    writeSync(2, JSON.stringify(event) + "\n");
  };
  // Explicit process.exit() skips finally/beforeExit (several CLI refusals use
  // it). Retain pending sanitized events without changing the command's exit.
  process.once("exit", () => errorReporter.flushLocal(localWrite));
  const fatal = (error: unknown, origin: string) => {
    // Returning from uncaughtException would keep a possibly corrupt process
    // alive. Exit nonzero after a bounded redacted write; do not ask a queue or
    // network exporter to finish. Node's raw default error printer would expose
    // SDK request/credential fields, so this handler replaces that printer.
    errorReporter.emergency(
      error,
      {
        source,
        kind: "process",
        operation: origin,
        severity: "fatal",
        handled: false,
      },
      localWrite,
    );
    process.exit(1);
  };
  process.on("uncaughtException", fatal);
  process.on("unhandledRejection", (error) => fatal(error, "unhandledRejection"));
}
