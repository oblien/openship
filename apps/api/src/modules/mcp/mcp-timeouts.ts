/**
 * MCP time budgets. Two layers on purpose:
 *
 *   - Per-tool: a read must not hang the agent on a stuck SSH probe / log tail.
 *     A write that actually waits (exec) has a larger budget. Long-running
 *     tools are supposed to return an operation id immediately, so they share
 *     the write budget only as a safety net.
 *   - Outer: handleMcpMessage / tools/call used to be unbounded. One stuck
 *     dispatch held the HTTP request forever. The outer deadline is always
 *     larger than any per-tool budget so the inner timeout wins first.
 */

export const MCP_READ_TIMEOUT_MS = 10_000;
export const MCP_TOOL_TIMEOUT_MS = 30_000;
export const MCP_EXECUTION_DEADLINE_MS = 60_000;

export class McpTimeoutError extends Error {
  readonly code: "MCP_TOOL_TIMEOUT" | "MCP_EXECUTION_DEADLINE";
  constructor(message: string, code: McpTimeoutError["code"]) {
    super(message);
    this.name = "McpTimeoutError";
    this.code = code;
  }
}

export function toolTimeoutMs(opts: { readOnly: boolean; timeoutMs?: number }): number {
  if (opts.timeoutMs && opts.timeoutMs > 0) return opts.timeoutMs;
  return opts.readOnly ? MCP_READ_TIMEOUT_MS : MCP_TOOL_TIMEOUT_MS;
}

/** Reject when `ms` elapses. Caller must still abort the underlying work. */
export function withDeadline<T>(
  promise: Promise<T>,
  ms: number,
  code: McpTimeoutError["code"],
  message: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return new Promise<T>((resolve, reject) => {
    timer = setTimeout(() => reject(new McpTimeoutError(message, code)), ms);
    promise.then(resolve, reject);
  }).finally(() => {
    if (timer) clearTimeout(timer);
  });
}
