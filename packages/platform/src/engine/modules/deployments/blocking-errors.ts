/**
 * Which failure causes are BLOCKERS rather than dead ends.
 *
 * A blocker is a deploy that failed for a reason we can name precisely and the
 * operator can clear — a port held by another process, say. Nothing deployed and
 * the build artifact is gone (onFailure cleans up either way), so this is not a
 * softer kind of success. The difference is that we can tell the operator what
 * is in the way and hand them the next step, so the project reads "Action
 * Required" with a resolution instead of a red dead end they have to read logs
 * to understand.
 *
 * ONE set, consulted by:
 *   - `onFailure` (deployment-lifecycle) to pick the persisted status
 *   - the pending-actions aggregator to decide what to offer
 * so "is this a blocker" cannot be answered two different ways.
 *
 * Adding a code here is the whole opt-in — but only add one whose resolution a
 * user can actually carry out. A code that just means "the deploy broke" belongs
 * in `errorCode` for diagnosis (which every failure now records) and NOT here,
 * because promoting it would promise a way forward that doesn't exist.
 */

/**
 * Codes that promote a failure to `action_required`.
 *
 * `PORT_IN_USE` — raised by `ensurePortAvailable` when the operator cancels or
 * the kill didn't take, and by the systemd/nohup supervisors on EADDRINUSE.
 * Carries `{port, pid, command, isManagedDeployment}`; resolution is to free the
 * port and redeploy.
 */
export const BLOCKING_ERROR_CODES: ReadonlySet<string> = new Set(["PORT_IN_USE"]);

/** Does this failure cause have a resolution we can offer? */
export function isBlockingErrorCode(code: string | null | undefined): boolean {
  return code != null && BLOCKING_ERROR_CODES.has(code);
}

/**
 * The status to PERSIST for a failed deploy. The SSE session is always told
 * `failed` regardless (see onFailure) — `action_required` is DB-only, exactly
 * like `partial_failure`, so the build stream still terminates.
 */
export function failureStatusFor(code: string | null | undefined): "failed" | "action_required" {
  return isBlockingErrorCode(code) ? "action_required" : "failed";
}
