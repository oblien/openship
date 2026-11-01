export type ErrorSeverity = "debug" | "info" | "warn" | "error" | "fatal";
export type ErrorCategory =
  | "authentication"
  | "authorization"
  | "validation"
  | "not_found"
  | "conflict"
  | "rate_limit"
  | "capacity"
  | "billing"
  | "network"
  | "timeout"
  | "cancelled"
  | "deployment"
  | "storage"
  | "database"
  | "dependency"
  | "internal";

/** Deliberately excludes headers, cookies, bodies, commands, env, email and IP. */
export interface ErrorContext {
  source?: "api" | "dashboard" | "desktop" | "cli" | "sdk" | "worker" | "web";
  kind?:
    | "exception"
    | "http"
    | "operation"
    | "deployment"
    | "background"
    | "client"
    | "process"
    | "delivery";
  component?: string;
  operation?: string;
  summary?: string;
  requestId?: string;
  parentRequestId?: string;
  traceId?: string;
  errorId?: string;
  clientEventId?: string;
  organizationId?: string;
  userId?: string;
  projectId?: string;
  serverId?: string;
  deploymentId?: string;
  jobId?: string;
  runId?: string;
  resourceType?: string;
  resourceId?: string;
  method?: string;
  route?: string;
  statusCode?: number;
  durationMs?: number;
  attempt?: number;
  code?: string;
  providerStatus?: number;
  providerCode?: string;
  providerRequestId?: string;
  retryable?: boolean;
  severity?: ErrorSeverity;
  category?: ErrorCategory;
  handled?: boolean;
  /** Browser reports are untrusted observations, never authoritative API failures. */
  untrusted?: boolean;
}

export interface DiagnosticError {
  name: string;
  message: string;
  code?: string;
  stack?: string;
  cause?: DiagnosticError;
  errors?: DiagnosticError[];
}

export interface ErrorEvent {
  schemaVersion: 1;
  eventId: string;
  errorId: string;
  timestamp: string;
  severity: ErrorSeverity;
  category: ErrorCategory;
  error: DiagnosticError;
  context: ErrorContext;
}

/** A destination must honor cancellation. No request waits for this promise. */
export type ErrorSink = (
  events: readonly ErrorEvent[],
  signal: AbortSignal,
) => void | Promise<void>;
