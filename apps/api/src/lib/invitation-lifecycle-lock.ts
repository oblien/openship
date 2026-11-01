/**
 * One serialization boundary for every mutation that consumes or revokes an
 * invitation. Better Auth performs accept/cancel/reject as multiple queries;
 * without this boundary, two concurrent endpoints can both observe `pending`
 * before either writes its terminal state.
 */

import { reportCaughtError as observeCaughtError } from "@repo/core/diagnostics";
import type { Context, Next } from "hono";
import { isValidInvitationId } from "@repo/core";
import { withInvitationLifecycleLock } from "@repo/platform/engine/lib/invitation-lifecycle-lock";
export { withInvitationLifecycleLock } from "@repo/platform/engine/lib/invitation-lifecycle-lock";

/**
 * Wrap Better Auth's accept/reject/cancel handlers. Invalid request bodies are
 * left to Better Auth's own schema/error response; only valid bearer ids enter
 * the lifecycle lock.
 */
export async function invitationLifecycleMiddleware(c: Context, next: Next) {
  const body = (await c.req.raw
    .clone()
    .json()
    .catch((diagnosticFailure) => { observeCaughtError(diagnosticFailure, "api/lib/invitation-lifecycle-lock"); return null; })) as { invitationId?: unknown } | null;
  const invitationId = typeof body?.invitationId === "string" ? body.invitationId.trim() : "";
  if (!isValidInvitationId(invitationId)) return next();
  await withInvitationLifecycleLock(invitationId, next);
}
