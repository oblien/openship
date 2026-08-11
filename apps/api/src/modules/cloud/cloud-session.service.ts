/**
 * Cloud session service - cloud-side session revocation + audit emit.
 *
 * Extracted from cloud-saas.controller so the DELETE-session + audit
 * sequence (and its idempotent "no session id → ok" branch) is unit-
 * testable independent of the HTTP layer.
 */

import { db, schema, repos, eq } from "@repo/db";
import { safeErrorMessage } from "@repo/core";

export async function revokeCloudSession(input: {
  sessionId: string | undefined;
  userId: string | undefined;
  clientIp: string | null;
  userAgent: string | null;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const { sessionId, userId, clientIp, userAgent } = input;

  if (!sessionId) {
    return { ok: true };
  }

  try {
    await db.delete(schema.session).where(eq(schema.session.id, sessionId));
  } catch (err) {
    console.error(
      "[cloud disconnect] failed to delete session row:",
      safeErrorMessage(err),
    );
    return { ok: false, error: "Failed to revoke session" };
  }

  // SaaS users each have a personal org (`org_<userId>`) provisioned at
  // signup. Audit against that so a security reviewer can reconstruct
  // "who disconnected which device when".
  if (userId) {
    await repos.auditEvent
      .create({
        organizationId: `org_${userId}`,
        actorUserId: userId,
        eventType: "cloud.disconnect",
        resourceType: "cloud",
        resourceId: sessionId,
        ipAddress: clientIp,
        userAgent: userAgent,
        before: null,
        after: null,
      })
      .catch((err) =>
        console.warn(
          "[cloud disconnect] audit emit failed:",
          safeErrorMessage(err),
        ),
      );
  }

  return { ok: true };
}
