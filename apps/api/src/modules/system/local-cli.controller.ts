import type { Context } from "hono";
import { repos } from "@repo/db";
import { env } from "@repo/platform/engine/config/env";
import { isSaasDeployment } from "@repo/platform/engine/lib/organization-lifecycle";
import { mintSession } from "../../lib/cloud-auth-proxy";
import { resolveActiveOrganizationId } from "../../middleware/active-organization";

/**
 * Exchange the installation's private operator credential for an ordinary,
 * temporary admin session. internalAuth authenticates the request before this
 * handler; a TCP loopback peer alone never authorizes it (including desktop).
 * The CLI holds this session only for the command and signs it out afterwards.
 * All resource requests still use the existing session and permission stack.
 */
export async function createLocalCliSession(c: Context) {
  if (isSaasDeployment) return c.json({ error: "Not available in cloud mode" }, 404);
  if (!env.INTERNAL_TOKEN || !c.req.header("X-Internal-Token")) {
    return c.json({ error: "The installation's operator credential is required" }, 401);
  }
  if (c.req.header("Origin") || c.req.header("Sec-Fetch-Site")) {
    return c.json({ error: "Local CLI authentication is not available to browsers" }, 403);
  }

  // Same deterministic owner as setup/recovery. Never accept a caller-supplied
  // identity, promote a member, or create an admin just to authenticate.
  const admin = await repos.user.findFoundingAdmin();
  if (!admin || admin.role !== "admin") {
    return c.json(
      { error: "No local administrator is available. Complete Openship setup first." },
      409,
    );
  }
  const organizationId = await resolveActiveOrganizationId(admin.id, null);
  if (!organizationId) {
    return c.json({ error: "The local administrator has no accessible workspace" }, 409);
  }
  // The CLI normally signs out in finally. Reuse session cleanup for commands
  // terminated by the OS before they could do so; expired rows confer no access.
  await repos.session.purgeExpired();
  const session = await mintSession({
    purpose: "local-cli",
    userId: admin.id,
    activeOrganizationId: organizationId,
    userAgent: "openship-cli/local",
    // Bounds abandoned sessions if the process is killed before sign-out.
    ttlSeconds: 24 * 60 * 60,
  });
  c.header("Cache-Control", "no-store");
  return c.json({ token: session.token, expiresAt: session.expiresAt.toISOString() });
}
