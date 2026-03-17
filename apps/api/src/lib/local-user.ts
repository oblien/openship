/**
 * Local user — auto-provisioned DB user for self-hosted/desktop mode.
 *
 * In local mode the API trusts all requests (it only listens on 127.0.0.1).
 * However, controllers reference `userId` as a FK, so a real user row must
 * exist. This module lazily creates one on first access and caches it.
 *
 * The user is an admin with `autoProvisioned = true`.
 */

import { randomUUID } from "node:crypto";
import { repos } from "@repo/db";

const LOCAL_EMAIL = "local@openship.local";

/** Shape expected by Hono context consumers (`c.get("user")`) */
export interface LocalUser {
  id: string;
  name: string;
  email: string;
  emailVerified: boolean;
  role: string;
  autoProvisioned: boolean;
}

/** Cached user — avoids a DB hit on every request after the first. */
let cached: LocalUser | null = null;

/**
 * Ensure a local user row exists in the database and return it.
 *
 * - First call: looks up `local@openship.local`, creates if missing.
 * - Subsequent calls: returns the in-memory cache (zero DB cost).
 */
export async function ensureLocalUser(): Promise<LocalUser> {
  if (cached) return cached;

  let row = await repos.user.findByEmail(LOCAL_EMAIL);

  if (!row) {
    // Insert directly — no password/session needed in local mode.
    const id = randomUUID();
    const { db, schema } = await import("@repo/db");
    await db.insert(schema.user).values({
      id,
      name: "Local User",
      email: LOCAL_EMAIL,
      emailVerified: true,
      role: "admin",
      autoProvisioned: true,
    });
    row = await repos.user.findById(id);
  }

  cached = {
    id: row!.id,
    name: row!.name,
    email: row!.email,
    emailVerified: row!.emailVerified,
    role: row!.role,
    autoProvisioned: row!.autoProvisioned,
  };

  return cached;
}
