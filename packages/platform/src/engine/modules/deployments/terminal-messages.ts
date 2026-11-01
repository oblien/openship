/**
 * Which terminal prose a deployment status read carries.
 *
 * Its own module, with no imports: it is a pure decision about two strings, and
 * keeping it out of the status projection's import graph is what makes it
 * exercisable without standing up the DB and the whole build platform.
 *
 * `failureMessage` used to be gated on `effectiveStatus === "failed"` alone, which
 * threw away the reason on every CANCELLED row. That mattered because a cancel is
 * not always a user's Stop: the boot sweep writes "Interrupted by a server restart
 * — redeploy to try again.", and a superseded partial-failure writes why it was
 * superseded. With the reason blanked, the app-install wizard had nothing left but
 * its own generic "Install failed" fallback to print over a row saying `cancelled`.
 *
 * Both statuses are consulted deliberately. `effectiveStatus` is SSE-facing (the
 * in-memory session, else the build session, else the row), while a superseded
 * partial-failure is cancelled on the ROW with its build session already finished
 * `ready` — so gating on `effectiveStatus` alone still blanks that one. The
 * dashboard decides "this was a cancel" from `deploymentStatus` (the row), so
 * reading the row here is what keeps the two from disagreeing.
 *
 * `warningMessage` keeps its original, narrower gate: it stays keyed to
 * `effectiveStatus` so a superseded partial-failure still reports which services
 * failed. That row is the one case where both strings are non-empty, and both are
 * true — the supersede reason and the partial outcome are different facts.
 */
export function terminalMessages(input: {
  effectiveStatus: string;
  /** `deployment.status` — the persisted row, which is what the dashboard reads. */
  rowStatus: string;
  errorMessage: string | null | undefined;
  warning: string | null | undefined;
}): { failureMessage: string; warningMessage: string } {
  const { effectiveStatus, rowStatus, errorMessage, warning } = input;
  const carriesFailure =
    effectiveStatus === "failed" || effectiveStatus === "cancelled" || rowStatus === "cancelled";
  const settledCleanly = effectiveStatus !== "failed" && effectiveStatus !== "cancelled";
  return {
    failureMessage: carriesFailure ? errorMessage || "" : "",
    warningMessage: settledCleanly ? warning || "" : "",
  };
}
