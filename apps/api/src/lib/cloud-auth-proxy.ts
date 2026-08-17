/**
 * Local session mint for desktop / bootstrap login.
 *
 * Cloud exchange, handoff, and desktop Cloud nonce/poll/claim were removed
 * with the SaaS edition. Operator only mints local sessions.
 */

import { randomUUID, randomBytes } from "node:crypto";
import { db, schema } from "@repo/db";

/**
 * Mint a session row directly via Drizzle. Bypasses Better Auth's
 * `session.create.before` hook because the caller has already done
 * the equivalent work (user provisioning, org resolution).
 *
 * Two `purpose` values exist:
 *   - `"local-cookie"` — the row backing the browser cookie session
 *     created by desktop / upgrade-to-auth flows.
 *     `id` is a UUID, no prefix. `activeOrganizationId` defaults to
 *     the user's deterministic personal org `org_<userId>`.
 *   - `"linked-instance"` — the bearer-only row created for a remote
 *     local instance. `id` is prefixed `sess_link_`.
 */
export async function mintSession(opts: {
  purpose: "local-cookie" | "linked-instance";
  userId: string;
  activeOrganizationId?: string;
  ipAddress?: string | null;
  userAgent?: string | null;
  ttlSeconds?: number;
}): Promise<{ id: string; token: string; expiresAt: Date }> {
  const id =
    opts.purpose === "linked-instance"
      ? `sess_link_${randomBytes(12).toString("hex")}`
      : randomUUID();
  const token = randomBytes(32).toString("hex");
  const now = new Date();
  const expiresAt = new Date(
    now.getTime() + (opts.ttlSeconds ?? 60 * 60 * 24 * 30) * 1000,
  );
  const defaultUserAgent =
    opts.purpose === "linked-instance" ? "openship-local-link" : null;

  await db.insert(schema.session).values({
    id,
    token,
    userId: opts.userId,
    expiresAt,
    ipAddress: opts.ipAddress ?? null,
    userAgent: opts.userAgent ?? defaultUserAgent,
    activeOrganizationId:
      opts.activeOrganizationId ?? `org_${opts.userId}`,
    createdAt: now,
    updatedAt: now,
  });

  return { id, token, expiresAt };
}
