import { classifyError, diagnosticError } from "./classification";
import { diagnosticPath, diagnosticProperty, redactDiagnosticText } from "./redaction";
import type { ErrorContext, ErrorEvent, ErrorSeverity, ErrorSink } from "./types";

let sequence = 0;
export function diagnosticId(): string {
  try {
    if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  } catch {
    /* Restricted browser context. */
  }
  return `${Date.now().toString(36)}-${(++sequence).toString(36)}`;
}

const STRING_FIELDS = [
  "source",
  "kind",
  "component",
  "operation",
  "requestId",
  "parentRequestId",
  "traceId",
  "errorId",
  "clientEventId",
  "organizationId",
  "userId",
  "projectId",
  "serverId",
  "deploymentId",
  "jobId",
  "runId",
  "resourceType",
  "resourceId",
  "method",
  "code",
  "providerCode",
  "providerRequestId",
  "severity",
  "category",
] as const;
const CONTEXT_FIELDS = [
  ...STRING_FIELDS,
  "route",
  "summary",
  "statusCode",
  "providerStatus",
  "durationMs",
  "attempt",
  "handled",
  "untrusted",
  "retryable",
] as const;

/** Merge allowed data properties only; explicit undefined still clears a parent field. */
export function mergeDiagnosticContext(...contexts: ErrorContext[]): ErrorContext {
  const input: Record<string, unknown> = {};
  for (const context of contexts) {
    try {
      for (const key of CONTEXT_FIELDS) {
        if (context && Object.hasOwn(context, key)) input[key] = diagnosticProperty(context, key);
      }
    } catch {
      // Diagnostic context must not disrupt an operation, even for a bad Proxy.
    }
  }
  return diagnosticContext(input as ErrorContext);
}

export function diagnosticContext(input: ErrorContext): ErrorContext {
  const result: Record<string, string | number | boolean> = {};
  for (const key of STRING_FIELDS) {
    const value = diagnosticProperty(input, key);
    if (typeof value === "string") result[key] = redactDiagnosticText(value, 160);
  }
  const route = diagnosticProperty(input, "route");
  if (typeof route === "string") result.route = redactDiagnosticText(diagnosticPath(route), 512);
  const summary = diagnosticProperty(input, "summary");
  if (typeof summary === "string") result.summary = redactDiagnosticText(summary, 2048);
  for (const key of ["statusCode", "providerStatus", "durationMs", "attempt"] as const) {
    const value = diagnosticProperty(input, key);
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) result[key] = value;
  }
  for (const key of ["handled", "untrusted", "retryable"] as const) {
    const value = diagnosticProperty(input, key);
    if (typeof value === "boolean") result[key] = value;
  }
  return result as ErrorContext;
}

let localOutputDropped = 0;
let localOutputAvailable = () => true;
/** Runtime adapters supply backpressure without importing Node into browser/Edge code. */
export function setDiagnosticOutputGuard(available: () => boolean): void {
  localOutputAvailable = available;
}

/** The emergency destination cannot call the reporter recursively. */
export const consoleErrorSink: ErrorSink = (events) => {
  for (let index = 0; index < events.length; index++) {
    try {
      if (!localOutputAvailable()) {
        localOutputDropped += events.length - index;
        return;
      }
      if (localOutputDropped) {
        const loss = overflowEvent(localOutputDropped);
        loss.error.name = "DiagnosticOutputOverflow";
        loss.error.message = `${localOutputDropped} diagnostic events were dropped while the local output was unavailable.`;
        loss.error.code = "DIAGNOSTICS_OUTPUT_DROPPED";
        console.error(JSON.stringify(loss));
        localOutputDropped = 0;
        if (!localOutputAvailable()) {
          localOutputDropped += events.length - index;
          return;
        }
      }
      console.error(JSON.stringify(events[index]));
    } catch {
      /* A broken stderr must not crash an error handler. */
      localOutputDropped += events.length - index;
      return;
    }
  }
};

export interface ErrorReporterOptions {
  enabled?: boolean | (() => boolean);
  sink?: ErrorSink;
  /** Last-resort local synchronous writer. Async exporters belong in sink. */
  fallback?: ErrorSink;
  context?: () => ErrorContext;
  maxEvents?: number;
  maxBytes?: number;
  batchSize?: number;
  flushIntervalMs?: number;
  deliveryTimeoutMs?: number;
}

function formatEvent(
  value: unknown,
  context: ErrorContext,
  eventId: string,
  errorId: string,
): ErrorEvent {
  const status = diagnosticProperty(value, "statusCode") ?? diagnosticProperty(value, "status");
  if (
    context.statusCode === undefined &&
    typeof status === "number" &&
    status >= 400 &&
    status <= 599
  )
    context.statusCode = status;
  const error = diagnosticError(value);
  const event: ErrorEvent = {
    schemaVersion: 1,
    eventId,
    errorId,
    timestamp: new Date().toISOString(),
    ...classifyError(error, context),
    error,
    context,
  };
  if (JSON.stringify(event).length * 2 > 16_384) {
    delete error.errors;
    delete error.cause;
    error.stack = error.stack?.slice(0, 2048);
  }
  if (JSON.stringify(event).length * 2 > 16_384) {
    error.message = error.message.slice(0, 1024);
    error.stack = error.stack?.slice(0, 512);
    for (const [key, value] of Object.entries(context)) {
      if (typeof value === "string") (context as Record<string, unknown>)[key] = value.slice(0, 96);
    }
  }
  return event;
}

function overflowEvent(dropped: number): ErrorEvent {
  const id = diagnosticId();
  return {
    schemaVersion: 1,
    eventId: id,
    errorId: id,
    timestamp: new Date().toISOString(),
    severity: "warn",
    category: "internal",
    error: {
      name: "DiagnosticsOverflow",
      message: `${dropped} diagnostic events were dropped because the buffer was full.`,
      code: "DIAGNOSTICS_OVERFLOW",
    },
    context: { kind: "delivery", component: "diagnostics" },
  };
}

/**
 * One bounded, non-blocking handoff for application failures. No database,
 * network, disk, or promise is awaited by capture(). Destinations receive only
 * sanitized snapshots; arbitrary Error/request objects never leave this class.
 */
export class ErrorReporter {
  private enabledCheck: boolean | (() => boolean);
  private captureVersion = 0;
  private activeController?: AbortController;
  private sink: ErrorSink;
  private sinkVersion = 0;
  private fallback: ErrorSink;
  private context: () => ErrorContext;
  private queue: { event: ErrorEvent; bytes: number }[] = [];
  private bytes = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private running: Promise<void> | null = null;
  private activeEvents: readonly ErrorEvent[] = [];
  private identities = new WeakMap<object, { id: string; observations: Map<string, string> }>();
  private failures = 0;
  private lost = 0;
  private totalDropped = 0;
  private totalDelivered = 0;
  private totalDeliveryFailures = 0;
  private readonly maxEvents: number;
  private readonly maxBytes: number;
  private readonly batchSize: number;
  private readonly interval: number;
  private readonly timeout: number;

  constructor(options: ErrorReporterOptions = {}) {
    this.enabledCheck = options.enabled ?? true;
    this.sink = options.sink ?? consoleErrorSink;
    this.fallback = options.fallback ?? consoleErrorSink;
    this.context = options.context ?? (() => ({}));
    this.maxEvents = Math.max(1, Math.min(4096, options.maxEvents ?? 256));
    this.maxBytes = Math.max(16_384, Math.min(16 * 1024 * 1024, options.maxBytes ?? 1024 * 1024));
    this.batchSize = Math.max(1, Math.min(64, options.batchSize ?? 16));
    this.interval = Math.max(0, options.flushIntervalMs ?? 100);
    this.timeout = Math.max(10, options.deliveryTimeoutMs ?? 2000);
  }

  /** Install once at a process boundary, or replace with an operator-owned exporter. */
  setSink(sink: ErrorSink): void {
    this.sink = sink;
    this.sinkVersion++;
    this.failures = 0;
  }
  setContextProvider(context: () => ErrorContext): void {
    this.context = context;
  }

  /** Capture is opt-in at the owning process/UI boundary, never from account connection state. */
  setEnabled(enabled: boolean | (() => boolean)): void {
    this.enabledCheck = enabled;
    if (!this.isEnabled()) this.discard();
  }

  isEnabled(): boolean {
    try {
      return (
        (typeof this.enabledCheck === "function" ? this.enabledCheck() : this.enabledCheck) === true
      );
    } catch {
      return false; // A missing/broken configuration must fail closed.
    }
  }

  private discard(): void {
    this.captureVersion++;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.queue = [];
    this.bytes = 0;
    this.lost = 0;
    this.activeEvents = [];
    this.activeController?.abort();
    this.identities = new WeakMap();
  }

  capture(value: unknown, supplied: ErrorContext = {}): string {
    if (!this.isEnabled()) return "";
    const eventId = diagnosticId();
    try {
      // Check the cheap bound before inspecting a potentially expensive error.
      if (this.queue.length >= this.maxEvents || this.bytes >= this.maxBytes) {
        this.drop();
        return eventId;
      }
      const context = mergeDiagnosticContext(this.context(), supplied);
      let errorId = context.errorId ?? eventId;
      if (value && (typeof value === "object" || typeof value === "function")) {
        let identity = this.identities.get(value);
        if (!identity) {
          identity = { id: errorId, observations: new Map() };
          this.identities.set(value, identity);
        }
        errorId = identity.id;
        const boundary = [
          context.kind,
          context.requestId,
          context.operation,
          context.deploymentId,
          context.runId,
          context.component,
        ].join(":");
        const previous = identity.observations.get(boundary);
        if (previous) return previous;
        // A single Error can be reused by a provider. Never grow an unbounded
        // map on it; each new request still receives its own observation.
        if (identity.observations.size >= 16)
          identity.observations.delete(identity.observations.keys().next().value!);
        identity.observations.set(boundary, eventId);
      }
      const event = formatEvent(value, context, eventId, errorId);
      const bytes = JSON.stringify(event).length * 2;
      if (this.bytes + bytes > this.maxBytes) this.drop();
      else {
        this.queue.push({ event, bytes });
        this.bytes += bytes;
        this.schedule();
      }
    } catch {
      this.drop();
    }
    return eventId;
  }

  /** Fatal process exit only: use the exact same serializer, bypass the buffer. */
  emergency(value: unknown, context: ErrorContext, write: (event: ErrorEvent) => void): void {
    try {
      const id = diagnosticId();
      write(formatEvent(value, mergeDiagnosticContext(this.context(), context), id, id));
    } catch {
      /* There is no safe recursive destination during process exit. */
    }
  }

  /** Last-chance local write during process exit, when promises cannot finish. */
  flushLocal(write: (event: ErrorEvent) => void): void {
    if (!this.isEnabled()) {
      this.discard();
      return;
    }
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    // An in-flight delivery may have completed externally. Replaying the same
    // event IDs is preferable to losing the event; collectors can deduplicate.
    const pending = [...this.activeEvents, ...this.queue.splice(0).map((item) => item.event)];
    this.activeEvents = [];
    this.bytes = 0;
    if (this.lost) {
      pending.push(overflowEvent(this.lost));
      this.lost = 0;
    }
    for (const event of pending) {
      try {
        write(event);
      } catch {
        break;
      } // A broken local output cannot be repaired during exit.
    }
  }

  /** Migrate intentional warning/error logs without dumping attached provider fields. */
  log(severity: ErrorSeverity, component: string, ...values: unknown[]): string {
    try {
      const error = values.find(
        (value) => typeof diagnosticProperty(value, "message") === "string",
      );
      const text = values
        .filter((value) => ["string", "number", "boolean"].includes(typeof value))
        .map((value) => String(value).slice(0, 2048))
        .join(" ")
        .slice(0, 4096);
      const metadata: ErrorContext = {};
      // Existing structured logs sometimes deliberately use only status/code.
      // Preserve those fields without admitting arbitrary attached payloads.
      for (const value of values) {
        const status =
          diagnosticProperty(value, "statusCode") ?? diagnosticProperty(value, "status");
        const code = diagnosticProperty(value, "code");
        if (typeof status === "number" && status >= 100 && status <= 599)
          metadata.statusCode = status;
        if (typeof code === "string" && /^[\w.-]{1,100}$/.test(code)) metadata.code = code;
        const providerStatus = diagnosticProperty(value, "providerStatus");
        if (typeof providerStatus === "number" && providerStatus >= 100 && providerStatus <= 599) {
          metadata.providerStatus = providerStatus;
          metadata.category = "dependency";
          const providerCode = diagnosticProperty(value, "providerCode");
          const reference = diagnosticProperty(value, "reference");
          const retryable = diagnosticProperty(value, "retryable");
          const operation = diagnosticProperty(value, "operation");
          const method = diagnosticProperty(value, "method");
          if (typeof providerCode === "string" && /^[\w.-]{1,100}$/.test(providerCode))
            metadata.providerCode = providerCode;
          if (typeof reference === "string") metadata.providerRequestId = reference;
          if (typeof retryable === "boolean") metadata.retryable = retryable;
          if (typeof operation === "string") metadata.operation = diagnosticPath(operation);
          if (typeof method === "string") metadata.method = method;
        }
      }
      const context: ErrorContext = {
        ...metadata,
        component,
        severity,
        handled: true,
        ...(error && text ? { summary: text } : {}),
      };
      const value = error ?? (text || "Operation failed");
      if (!this.isEnabled()) {
        // Preserve intentional local warnings/errors. Recovered catches and
        // automatic captures stay off; a configured remote sink is never used.
        this.emergency(value, context, (event) =>
          consoleErrorSink([event], new AbortController().signal),
        );
        return "";
      }
      return this.capture(value, context);
    } catch {
      this.drop();
      return diagnosticId();
    }
  }

  stats() {
    return {
      queued: this.queue.length,
      queuedBytes: this.bytes,
      delivering: !!this.running,
      delivered: this.totalDelivered,
      dropped: this.totalDropped,
      deliveryFailures: this.totalDeliveryFailures,
    };
  }

  /** For graceful shutdown/tests only. Requests must never call or await flush. */
  async flush(deadlineMs = 2000): Promise<boolean> {
    const deadline = Date.now() + Math.max(0, deadlineMs);
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    while ((this.queue.length || this.running || this.lost) && Date.now() < deadline) {
      this.start();
      if (!this.running) break;
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        this.running,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, Math.max(0, deadline - Date.now()));
        }),
      ]);
      if (timer) clearTimeout(timer);
    }
    return !this.queue.length && !this.running && !this.lost;
  }

  private drop(): void {
    this.lost++;
    this.totalDropped++;
    this.schedule();
  }

  private schedule(): void {
    if (this.timer || this.running) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.start();
    }, this.interval);
    (this.timer as { unref?: () => void }).unref?.();
  }

  private start(): void {
    if (!this.isEnabled()) {
      this.discard();
      return;
    }
    if (this.running) return;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    const batch = this.queue.splice(0, this.batchSize);
    this.bytes -= batch.reduce((sum, item) => sum + item.bytes, 0);
    const events = batch.map((item) => item.event);
    if (this.lost) {
      events.push(overflowEvent(this.lost));
      this.lost = 0;
    }
    if (!events.length) return;
    this.activeEvents = events;
    this.running = this.deliver(events)
      .catch(() => {
        this.totalDeliveryFailures++;
      })
      .finally(() => {
        this.activeEvents = [];
        this.running = null;
        if (this.queue.length || this.lost) this.schedule();
      });
  }

  private async deliver(events: ErrorEvent[]): Promise<void> {
    const controller = new AbortController();
    this.activeController = controller;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const sink = this.sink;
    const version = this.sinkVersion;
    const captureVersion = this.captureVersion;
    try {
      await Promise.race([
        Promise.resolve().then(() => {
          if (!this.isEnabled() || controller.signal.aborted) return;
          return sink(events, controller.signal);
        }),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new Error("Diagnostic destination timed out"));
          }, this.timeout);
          (timer as { unref?: () => void }).unref?.();
        }),
      ]);
      if (!this.isEnabled() || controller.signal.aborted || captureVersion !== this.captureVersion)
        return;
      if (version === this.sinkVersion) this.failures = 0;
      this.totalDelivered += events.length;
    } catch {
      if (!this.isEnabled() || captureVersion !== this.captureVersion) return;
      this.totalDeliveryFailures++;
      if (version === this.sinkVersion) this.failures++;
      // A destination that ignores AbortSignal can remain pending forever.
      // Switch to the local fallback rather than accumulating hung promises.
      if (version === this.sinkVersion && (controller.signal.aborted || this.failures >= 3))
        this.sink = this.fallback;
      const id = diagnosticId();
      const failure: ErrorEvent = {
        schemaVersion: 1,
        eventId: id,
        errorId: id,
        timestamp: new Date().toISOString(),
        severity: "warn",
        category: "internal",
        error: {
          name: "DiagnosticDeliveryError",
          message: "Diagnostic destination failed; this batch is written to the local fallback.",
          code: "DIAGNOSTICS_DELIVERY_FAILED",
        },
        context: { kind: "delivery", component: "diagnostics" },
      };
      // Deliberately no recursive reporting/retry and no work added to the
      // application queue. Event IDs let external collectors deduplicate an
      // uncertain delivery that later completed remotely.
      this.writeFallback([...events, failure]);
    } finally {
      if (timer) clearTimeout(timer);
      if (this.activeController === controller) this.activeController = undefined;
    }
  }

  private writeFallback(events: readonly ErrorEvent[]): void {
    const fallback = this.fallback;
    try {
      // The last resort is local and synchronous. An accidentally asynchronous
      // fallback must not leave another pending request behind on every batch.
      const result = fallback(events, new AbortController().signal);
      if (!result || typeof result.then !== "function") return;
      void Promise.resolve(result).catch(() => {});
    } catch {
      /* Use the built-in local destination below. */
    }
    this.fallback = consoleErrorSink;
    if (this.sink === fallback) this.sink = consoleErrorSink;
    consoleErrorSink(events, new AbortController().signal);
  }
}

// Product entry points explicitly enable collection only for Cloud SaaS.
// Importing the shared SDK, Desktop or a self-hosted module cannot enable it.
export const errorReporter = new ErrorReporter({ enabled: false });
export const reportError = (error: unknown, context?: ErrorContext): string =>
  errorReporter.capture(error, context);
/** A caught recovery is observable without changing its return/throw behavior. */
export function reportCaughtError(error: unknown, component: string): void {
  if (!errorReporter.isEnabled()) return;
  // Redirects and rendering bailouts are framework control flow, not failures.
  const digest = diagnosticProperty(error, "digest");
  if (
    typeof digest === "string" &&
    (/^(NEXT_REDIRECT|NEXT_HTTP_ERROR_FALLBACK);/.test(digest) ||
      [
        "DYNAMIC_SERVER_USAGE",
        "BAILOUT_TO_CLIENT_SIDE_RENDERING",
        "NEXT_PRERENDER_INTERRUPTED",
      ].includes(digest))
  )
    return;
  const code = diagnosticProperty(error, "code");
  const expected =
    diagnosticProperty(error, "name") === "AbortError" ||
    (typeof code === "string" && ["ENOENT", "EEXIST", "ABORT_ERR"].includes(code));
  errorReporter.capture(error, {
    component,
    handled: true,
    severity: expected ? "info" : "warn",
  });
}
export const diagnostics = {
  error: (component: string, ...values: unknown[]): void => {
    errorReporter.log("error", component, ...values);
  },
  warn: (component: string, ...values: unknown[]): void => {
    errorReporter.log("warn", component, ...values);
  },
};
