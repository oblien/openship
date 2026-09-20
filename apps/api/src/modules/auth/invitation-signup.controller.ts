import type { Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { hashPassword } from "better-auth/crypto";
import { repos } from "@repo/db";
import { isSaasDeployment } from "@repo/platform/engine/lib/auth";
import { resolveInvitationClaim } from "@repo/platform/engine/lib/invitation-claim";
import { createInvitedUserWithCredential } from "@repo/platform/engine/lib/invitation-signup";

export const INVITATION_SIGNUP_BODY_MAX_BYTES = 8 * 1024;

/** Small fixed cap for an unauthenticated JSON credential request. */
export const invitationSignupBodyLimit = bodyLimit({
  maxSize: INVITATION_SIGNUP_BODY_MAX_BYTES,
  onError: (c) =>
    c.json(
      {
        error: "Invitation signup request is too large.",
        code: "PAYLOAD_TOO_LARGE",
      },
      413,
    ),
});

/**
 * Token-bound account creation for a self-hosted invitation.
 *
 * A read-side preflight rejects invalid tokens before expensive password
 * hashing. The write service repeats the same shared claim validation while
 * holding row locks and commits the user, credential, workspace, and membership
 * atomically. The invitation email is authoritative; callers cannot choose it.
 */
export async function inviteSignup(c: Context) {
  c.header("Cache-Control", "no-store");

  // Both CLOUD_MODE and the cloud-saas runtime target are covered. This remains
  // a handler-level guard even though the route also belongs to a local-only
  // router, so a future remount cannot accidentally expose it on SaaS.
  if (isSaasDeployment) return c.notFound();

  const body = (await c.req.json().catch(() => ({}))) as {
    invitationId?: unknown;
    name?: unknown;
    password?: unknown;
  };
  const invitationId = typeof body.invitationId === "string" ? body.invitationId.trim() : "";
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const password = typeof body.password === "string" ? body.password : "";
  if (!invitationId) return c.json({ error: "invitationId is required" }, 400);
  if (!name || name.length > 100) {
    return c.json({ error: "name must be 1-100 characters" }, 400);
  }
  if (password.length < 8 || password.length > 128) {
    return c.json({ error: "password must be 8-128 characters" }, 400);
  }

  // Cheap preflight only. It keeps forged tokens away from the password hasher;
  // the locked transaction below is still the authoritative authorization.
  const claim = await resolveInvitationClaim(invitationId);
  if (!claim?.inviterIsInstanceAdmin) {
    return c.json({ error: "This invitation is invalid or has expired." }, 403);
  }
  if (await repos.user.findByEmail(claim.email)) {
    return c.json(
      { error: "An account with this email already exists — sign in and accept the invite." },
      409,
    );
  }

  const passwordHash = await hashPassword(password);
  const result = await createInvitedUserWithCredential({
    invitationId,
    name,
    passwordHash,
  });

  if (result.status === "invalid") {
    return c.json({ error: "This invitation is invalid or has expired." }, 403);
  }
  if (result.status === "existing") {
    return c.json(
      { error: "An account with this email already exists — sign in and accept the invite." },
      409,
    );
  }
  return c.json({ ok: true, email: result.email });
}
