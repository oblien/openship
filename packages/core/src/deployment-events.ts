/**
 * Pipeline step identifiers for stepper UI.
 *
 * "prepare" is one-time server provisioning (toolchain install, source
 * transfer) that runs BEFORE the build timer starts — so it's shown as its own
 * phase and excluded from the reported build duration.
 */
export type BuildStep = "prepare" | "clone" | "install" | "build" | "deploy";

export const BUILD_STEPS: readonly BuildStep[] = [
  "prepare",
  "clone",
  "install",
  "build",
  "deploy",
] as const;

export interface LogEntry {
  timestamp: string;
  message: string;
  level: "info" | "warn" | "error";
  /** When present, this entry is a step event for the stepper UI */
  step?: BuildStep;
  /** Step lifecycle status */
  stepStatus?: "running" | "completed" | "failed" | "skipped";
  /** Compose service name when this log belongs to one service. */
  serviceName?: string;
  /** Stable id of the service this log belongs to (compose deployments). Routes
   *  the line to its per-service tab without fragile name matching. */
  serviceId?: string;
  /** Pre-encoded base64 data - passed through to SSE without re-encoding. */
  rawData?: string;
  /** Monotonic sequence assigned by the session manager at append time, used as
   *  the SSE event id / client dedup cursor. Decoupled from the ring-buffer
   *  index so it never plateaus when the buffer trims. */
  seq?: number;
}

/** A user-decision prompt (edge takeover, port conflict, …) — the ONE shape
 *  shared by the deploy pipeline, server-setup, the CLI, and the dashboard modal
 *  that renders it. Resolves to the chosen action id. */
export interface PromptPayload {
  promptId: string;
  title: string;
  message: string;
  actions: Array<{ id: string; label: string; variant?: string }>;
  details?: Record<string, unknown>;
  /**
   * ISO deadline after which the hold gives up and the pipeline aborts.
   *
   * Stamped by whoever HOLDS the prompt (the session manager owns the timeout),
   * not by the code that raises it — so it is absent on the raising side and
   * present by the time a client sees it. A human watching a modal doesn't need
   * this; an API client that has to poll to notice the prompt at all does, or it
   * cannot tell "still waiting" from "I have 12 seconds left".
   */
  expiresAt?: string;
}

/** One exposed port's advisory probe outcome (persisted in `deployment.meta`). */
export interface PortCheckResult {
  /** The exposed/public port that was probed. */
  port: number;
  /** True if a listener was found inside the instance. */
  listening: boolean;
  /** False = probe inconclusive (runtime can't exec inside / probe errored) — no advisory. */
  checked: boolean;
  /** Compose only: which service this result belongs to. */
  serviceId?: string;
  serviceName?: string;
  /** Set when the probe was intentionally not run for this target. */
  skippedReason?: "not-exposed" | "no-exec" | "no-port";
}

