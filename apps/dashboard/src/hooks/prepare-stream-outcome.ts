/**
 * What a prepare/verify stream should REPORT when it ends — extracted from
 * `useSystemPrepareModal` so the rule is stated once and testable.
 *
 * The rule exists because of a specific failure: the modal treated the stream
 * ending, and any late socket error, as the outcome. So a run that had already
 * reported `complete` got overwritten by teardown noise, and a run whose
 * connection dropped got "the connection closed before the operation reported a
 * result — check the domain's status" — which discards what actually happened and
 * asks the operator to go and find out for themselves.
 */

export type StreamPhase = "running" | "completed" | "failed" | "error";

/** What a caller-supplied `resolveOutcome` found, or null when it couldn't tell. */
export interface StreamOutcome {
  ok: boolean;
  message: string;
}

export interface LostStreamReport {
  phase: Extract<StreamPhase, "completed" | "failed">;
  /** Appended to the log — the run succeeded, this just says how we know. */
  logLine?: string;
  /** Shown as the failure banner. */
  error?: string;
}

export const UNKNOWN_OUTCOME_MESSAGE =
  "The connection dropped before this run reported a result, and its current state couldn't be read. The log above is what it got through.";

/**
 * True when the stream's end (or a late error) is allowed to set the outcome.
 *
 * Once a terminal event has arrived the result is KNOWN, and everything after it
 * is the socket being torn down. Letting that through turned finished operations
 * into generic failures — and took the log with it, since the failure view used to
 * replace the console.
 */
export function canReportStreamEnd(sawTerminalEvent: boolean): boolean {
  return !sawTerminalEvent;
}

/**
 * The report for a stream that ended WITHOUT a terminal event, given whatever the
 * server could tell us afterwards. `null` outcome = we genuinely don't know, which
 * is the only case that gets the unknown message.
 */
export function reportLostStream(outcome: StreamOutcome | null): LostStreamReport {
  if (outcome?.ok) {
    return { phase: "completed", logLine: outcome.message };
  }
  return { phase: "failed", error: outcome?.message ?? UNKNOWN_OUTCOME_MESSAGE };
}
