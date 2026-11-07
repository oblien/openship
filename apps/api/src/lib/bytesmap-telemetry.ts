import {
  createTelemetry,
  parseTraceparent,
  type LogOptions,
  type TraceContext,
} from "bytesmap/events/server";
import {
  diagnosticContext,
  diagnosticProperty,
  errorReporter,
  setDiagnosticTelemetry,
  type DiagnosticTelemetry,
  type ErrorContext,
  type ErrorEvent,
} from "@repo/core/diagnostics";
import { currentErrorContext } from "@repo/core/diagnostics/node";
import type { BytesMapTelemetryConfig } from "./bytesmap-telemetry-config";
import { randomUUID } from "node:crypto";
import { monitorEventLoopDelay } from "node:perf_hooks";

const fields = {
  source: "source",
  kind: "kind",
  component: "component",
  operation: "operation",
  requestId: "request_id",
  parentRequestId: "parent_request_id",
  errorId: "error_id",
  eventId: "observation_id",
  organizationId: "workspace_id",
  userId: "user_id",
  projectId: "project_id",
  serverId: "server_id",
  deploymentId: "deployment_id",
  jobId: "job_id",
  runId: "run_id",
  resourceType: "resource_type",
  resourceId: "resource_id",
  statusCode: "status_code",
  method: "http_method",
  route: "http_route",
  attempt: "attempt",
  code: "error_code",
  providerStatus: "provider_status",
  providerCode: "provider_code",
  providerRequestId: "provider_request_id",
  category: "error_category",
  handled: "handled",
  untrusted: "untrusted",
  retryable: "retryable",
} as const;

type Dimensions = NonNullable<LogOptions["dimensions"]>;
function attributes(context: ErrorContext): Dimensions {
  const safe = diagnosticContext(context);
  const result: Dimensions = {};
  for (const [name, key] of Object.entries(fields)) {
    const value = safe[name as keyof ErrorContext];
    if (value !== undefined) result[key] = value;
  }
  if (safe.statusCode !== undefined) result.http_status_code = safe.statusCode;
  return result;
}

function correlation(context: ErrorContext): TraceContext | undefined {
  return parseTraceparent(
    `00-${context.traceId ?? ""}-${context.spanId ?? ""}-${(context.traceFlags ?? 0).toString(16).padStart(2, "0")}`,
  );
}

/** OpenShip policy and diagnostics mapping; BytesMap owns every telemetry provider and transport. */
export function createBytesMapTelemetry(
  config: BytesMapTelemetryConfig,
  version: string,
  testing: { allowPlaintextLoopback?: boolean } = {},
) {
  let closed = false;
  let exportFailures = 0;
  let nextWarning = 0;
  const warn = () => {
    exportFailures++;
    if (Date.now() < nextWarning) return;
    nextWarning = Date.now() + 60_000;
    // No reporter recursion, URLs, exporter exceptions, headers or sending keys.
    try {
      if (
        !process.stderr.destroyed &&
        !process.stderr.writableNeedDrain &&
        process.stderr.writableLength < 65_536
      )
        process.stderr.write(
          "[bytesmap] Telemetry export failed; bounded buffers may drop records. Local diagnostics remain available.\n",
        );
    } catch {
      /* diagnostics-ignore: an unavailable diagnostic stream must not recurse or break the exporter callback. */
    }
  };
  const telemetry = createTelemetry({
    endpoint: config.endpoint,
    dataset: config.dataset,
    token: config.token,
    service: "openship-api",
    version,
    instanceId: randomUUID(),
    environment: config.environment,
    sampleRate: config.sampleRate,
    logSampling: "independent",
    maxBufferBytes: 16 * 1024 * 1024,
    maxBatchEvents: 32,
    flushIntervalMs: 1000,
    requestTimeoutMs: 1500,
    maxAttempts: 1,
    onError: warn,
    ...(testing.allowPlaintextLoopback ? { allowPlaintextLoopback: true } : {}),
  });
  const eventLoop = monitorEventLoopDelay({ resolution: 20 });
  eventLoop.enable();
  let cpu = process.cpuUsage();
  let measuredAt = performance.now();
  const observer: DiagnosticTelemetry = {
    start(context, options) {
      const name =
        context.operation ??
        (context.kind === "http"
          ? `${context.method ?? "HTTP"} ${context.route ?? "[unmatched]"}`
          : (context.component ?? context.kind ?? "operation"));
      const span = telemetry.startSpan(name, {
        dimensions: attributes(context),
        kind: options.kind,
        ...(options.parent
          ? { parent: parseTraceparent(options.parent) ?? null }
          : options.root
            ? { parent: null }
            : {}),
      });
      let ended = false;
      return {
        correlation: span.context,
        run: span.run,
        end(context = {}, error) {
          if (ended) return;
          ended = true;
          try {
            span.setDimensions(attributes(context));
            const status = context.statusCode ?? 0;
            const clientError = options.kind === "server" && status >= 400 && status < 500;
            if (error !== undefined && !clientError) {
              // Exception details come from the existing error reporter, once per observation.
              span.setStatus(
                diagnosticProperty(error, "name") === "AbortError" ? "unset" : "error",
              );
            } else if (status >= 500) span.setStatus("error");
          } finally {
            span.end();
          }
        },
      };
    },
    enrich(context) {
      telemetry.current()?.setDimensions(attributes(context));
    },
    event(name, supplied) {
      if (closed) return;
      const context = { ...currentErrorContext(), ...supplied };
      const failed = /\.(failed|unhealthy|unavailable|lost)$/.test(name);
      if (failed) telemetry.current()?.setStatus("error");
      telemetry.log(failed ? "error" : "info", name, {
        dimensions: { ...attributes(context), event_name: name },
      });
    },
    traceparent() {
      return telemetry.headers().get("traceparent") ?? undefined;
    },
  };
  function observeError(event: Readonly<ErrorEvent>) {
    if (closed) return;
    const context = correlation(event.context);
    const active = telemetry.current();
    if (
      active &&
      active.context.spanId === context?.spanId &&
      ["error", "fatal"].includes(event.severity)
    )
      active.setStatus("error");
    telemetry.log(event.severity, event.error.message, {
      context: context ?? null,
      timestamp: new Date(event.timestamp),
      dimensions: {
        ...attributes(event.context),
        event_name: "openship.error",
        observation_id: event.eventId,
        error_id: event.errorId,
        error_category: event.category,
        ...(event.error.code ? { error_code: event.error.code } : {}),
      },
      data: { diagnostic: JSON.stringify(event) },
    });
  }
  let disconnect: (() => void) | undefined;
  return {
    observer,
    observeError,
    heartbeat() {
      if (closed) return;
      const now = performance.now();
      const delta = process.cpuUsage(cpu);
      cpu = process.cpuUsage();
      const memory = process.memoryUsage();
      telemetry.log("info", "openship.control_plane.heartbeat", {
        context: null,
        dimensions: {
          event_name: "openship.control_plane.heartbeat",
          uptime_seconds: Math.round(process.uptime()),
          memory_rss_mb: memory.rss / 1_048_576,
          heap_used_mb: memory.heapUsed / 1_048_576,
          cpu_percent: (delta.user + delta.system) / Math.max(1, now - measuredAt) / 10,
          event_loop_p95_ms: eventLoop.percentile(95) / 1_000_000,
          export_failures: exportFailures,
        },
      });
      measuredAt = now;
      eventLoop.reset();
    },
    install() {
      if (closed || disconnect) return;
      const stopTracing = setDiagnosticTelemetry(observer);
      const stopErrors = errorReporter.setObserver(observeError);
      disconnect = () => {
        stopTracing();
        stopErrors();
      };
    },
    async flush(timeoutMillis = 2000) {
      await telemetry.flush({ timeoutMillis });
    },
    async close() {
      if (closed) return;
      closed = true;
      disconnect?.();
      try {
        await telemetry.close();
      } finally {
        eventLoop.disable();
      }
    },
    status: () => ({ enabled: !closed, exportFailures }),
  };
}

export type BytesMapTelemetry = ReturnType<typeof createBytesMapTelemetry>;
