/**
 * Pure retry policy for the live service log stream (#667). Extracted from
 * LiveServiceLogsTerminal so the decision matrix is unit-testable without a
 * DOM: retries only for unexpected drops while the tab is still watching.
 */
export function shouldRetryLiveStream(state: {
  exited: boolean;
  stopping: boolean;
  active: boolean;
  attempts: number;
  maxAttempts: number;
}): boolean {
  if (state.exited) return false;
  if (state.stopping) return false;
  if (!state.active) return false;
  return state.attempts < state.maxAttempts;
}
