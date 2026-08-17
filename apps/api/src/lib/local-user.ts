/**
 * Local user — auto-provisioned admin for self-hosted / desktop mode.
 *
 * In zero-auth mode the API trusts 127.0.0.1 traffic (no Better Auth
 * cookie required). Controllers still reference `userId` as a FK, so a
 * real user row must exist. This module lazily provisions one on first
 * access and caches it in-process to avoid a DB roundtrip per request.
 *
 * All user + personal-org creation flows through `provisionUser`, the
 * same helper Better Auth's signup hook + the cloud-mirror path use.
 */

import { randomUUID } from "node:crypto";
import { repos } from "@repo/db";
import { provisionUser } from "./provision-user";

export const LOCAL_EMAIL = "local@openship.local";

/** Reset the in-process cache. Use after mutating the local user row
 *  (e.g. the zero-auth → local-auth upgrade flow renames the user). */
export function invalidateLocalUserCache(): void {
  cached = null;
}

export interface LocalUser {
  id: string;
  name: string;
  email: string;
  emailVerified: boolean;
  role: string;
  autoProvisioned: boolean;
}

let cached: LocalUser | null = null;

export async function ensureLocalUser(): Promise<LocalUser> {
  if (cached) return cached;

  // Desktop used to create a second, empty personal workspace whenever the
  // original synthetic user had been renamed by an account/cloud flow. That
  // made two Electron profiles backed by the same database appear to contain
  // different projects. A desktop control plane has one operator: adopt the
  // existing founding admin before provisioning a new synthetic identity.
  const existing =
    (await repos.user.findProjectWorkspaceOwner()) ??
    (await repos.user.findFoundingAdmin()) ??
    (await repos.user.findByEmail(LOCAL_EMAIL));
  const id = existing?.id ?? randomUUID();

  // provisionUser is idempotent: it upserts the user row AND the
  // personal organization (`org_${id}`) AND the owner-role member
  // binding, all in a single transaction. After this returns, the
  // zero-auth synthetic user shows up in the Team Members tab as
  // owner of `${name}'s workspace` — no separate insertion needed.
  await provisionUser({
    id,
    name: existing?.name ?? "Local User",
    email: existing?.email ?? LOCAL_EMAIL,
    emailVerified: true,
    role: "admin",
    autoProvisioned: existing?.autoProvisioned ?? true,
  });

  const row = await repos.user.findById(id);
  if (!row) throw new Error("Failed to provision local user");

  cached = {
    id: row.id,
    name: row.name,
    email: row.email,
    emailVerified: row.emailVerified,
    role: row.role,
    autoProvisioned: row.autoProvisioned,
  };

  return cached;
}
