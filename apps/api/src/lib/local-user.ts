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
import { db, eq, repos, schema, type DatabaseTransaction } from "@repo/db";
import { provisionUser } from "@repo/platform/engine/lib/provision-user";

export const LOCAL_EMAIL = "local@openship.local";

/** A wipe keeps installation authority but replaces its users. Rebind only a
 * missing identity on an ordinary active instance to the imported synthetic
 * administrator. Handoffs choose their identity through their own protocol. */
export async function rebindLocalUserAfterInstanceRestore(tx: DatabaseTransaction): Promise<void> {
  const [controller] = await tx
    .select()
    .from(schema.instanceController)
    .where(eq(schema.instanceController.id, "local"));
  if (!controller?.desktopUserId || controller.role !== "active" || controller.handoffId) return;
  const [current] = await tx
    .select()
    .from(schema.user)
    .where(eq(schema.user.id, controller.desktopUserId));
  if (current) return;
  const [imported] = await tx.select().from(schema.user).where(eq(schema.user.email, LOCAL_EMAIL));
  if (imported?.role !== "admin" || !imported.autoProvisioned) return;
  await tx
    .update(schema.instanceController)
    .set({ desktopUserId: imported.id })
    .where(eq(schema.instanceController.id, "local"));
}

/** Reset the in-process cache. Use after mutating the local user row
 *  (e.g. the zero-auth → local-auth upgrade flow renames the user). */
export function invalidateLocalUserCache(): void {
  cacheGeneration += 1;
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
let cacheGeneration = 0;

export async function ensureLocalUser(): Promise<LocalUser> {
  if (cached) return cached;
  const generation = cacheGeneration;

  // Desktop's active identity belongs to this installation. A handoff keeps
  // the real administrator's id, even when no synthetic Local User exists in
  // the incoming database. It must not create an unrelated empty workspace.
  const [controller] = await db.select().from(schema.instanceController).where(eq(schema.instanceController.id, "local"));
  if (controller?.desktopUserId) {
    const owner = await repos.user.findById(controller.desktopUserId);
    if (!owner || owner.role !== "admin") throw new Error("The local instance identity is unavailable. Finish the instance handoff before continuing.");
    if (generation === cacheGeneration) cached = owner as LocalUser;
    return owner as LocalUser;
  }

  const existing = await repos.user.findByEmail(LOCAL_EMAIL);
  const id = existing?.id ?? randomUUID();

  // provisionUser is idempotent: it upserts the user row AND the
  // personal organization (`org_${id}`) AND the owner-role member
  // binding, all in a single transaction. After this returns, the
  // zero-auth synthetic user shows up in the Team Members tab as
  // owner of `${name}'s workspace` — no separate insertion needed.
  await provisionUser({
    id,
    name: "Local User",
    email: LOCAL_EMAIL,
    emailVerified: true,
    role: "admin",
    autoProvisioned: true,
  });

  const row = await repos.user.findById(id);
  if (!row) throw new Error("Failed to provision local user");
  if (controller) await db.update(schema.instanceController).set({ desktopUserId: row.id }).where(eq(schema.instanceController.id, "local"));

  const resolved = {
    id: row.id,
    name: row.name,
    email: row.email,
    emailVerified: row.emailVerified,
    role: row.role,
    autoProvisioned: row.autoProvisioned,
  };

  // A restore can commit while this request is awaiting the DB. Do not allow
  // that older request to put the pre-restore identity back into the cache.
  if (generation === cacheGeneration) cached = resolved;

  return resolved;
}
