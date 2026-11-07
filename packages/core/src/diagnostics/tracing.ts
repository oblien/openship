import { diagnosticContext } from "./reporter";
import type { ErrorContext } from "./types";

export interface DiagnosticSpanOptions {
  kind?: "server" | "consumer" | "client" | "internal";
  parent?: string;
  root?: boolean;
}

export interface DiagnosticSpan {
  readonly correlation: { traceId: string; spanId: string; traceFlags?: number };
  run<T>(work: () => T): T;
  end(context?: ErrorContext, error?: unknown): void;
}

/** Installed by the Cloud host only. Core, browsers and native hosts own no exporter. */
export interface DiagnosticTelemetry {
  start(context: ErrorContext, options: DiagnosticSpanOptions): DiagnosticSpan;
  event(name: string, context: ErrorContext): void;
  enrich(context: ErrorContext): void;
  traceparent(): string | undefined;
}

let telemetry: DiagnosticTelemetry | undefined;

export function setDiagnosticTelemetry(value: DiagnosticTelemetry | undefined): () => void {
  telemetry = value;
  return () => {
    if (telemetry === value) telemetry = undefined;
  };
}

export function startDiagnosticSpan(
  context: ErrorContext,
  options: DiagnosticSpanOptions = {},
): DiagnosticSpan | undefined {
  if (!telemetry) return;
  try {
    return telemetry.start(diagnosticContext(context), options);
  } catch {
    /* An unavailable observer cannot prevent application work. */
  }
}

export function diagnosticTraceparent(): string | undefined {
  try {
    return telemetry?.traceparent();
  } catch {
    return undefined;
  }
}

export function endDiagnosticSpan(
  span: DiagnosticSpan | undefined,
  context?: ErrorContext,
  error?: unknown,
): void {
  try {
    span?.end(context, error);
  } catch {
    /* A broken exporter cannot replace a successful result or the original failure. */
  }
}

export function enrichDiagnosticSpan(context: ErrorContext): void {
  if (!telemetry) return;
  try {
    telemetry.enrich(diagnosticContext(context));
  } catch {
    /* Observation never changes authorization or an operation result. */
  }
}

/** Safe operational facts only: never audit diffs, request bodies, or notification payloads. */
export function emitDiagnosticEvent(name: string, context: ErrorContext): void {
  if (!telemetry || !/^[a-z][a-z0-9_.-]{0,95}$/.test(name)) return;
  try {
    telemetry.event(name, diagnosticContext(context));
  } catch {
    /* Delivery failures belong to the exporter, not the application. */
  }
}
