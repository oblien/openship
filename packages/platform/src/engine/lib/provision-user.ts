/**
 * Single bootstrap point for every user identity in Openship.
 *
 * Every authenticated user MUST end up with:
 *   1. A row in the `user` table (Better Auth's identity record).
 *   2. A personal organization (`org_${userId}`) — so the org-scoping
 *      middleware always has an active org to resolve, even before the
 *      user joins any team.
 *   3. An owner-role `member` row binding them to that personal org.
 *
 * Three flows hit this code path:
 *   - Better Auth signup (email/password + OAuth) via the
 *     `databaseHooks.user.create.after` hook — Better Auth has already
 *     inserted the user, so the user upsert is a no-op and only the org
 *     bootstrap does work.
 *   - Cloud auth mirror (cloud-auth-proxy.mirrorCloudUser) — the user
 *     authenticated against Openship Cloud; we provision a local mirror.
 *   - Desktop zero-auth (local-user.ensureLocalUser) — the API trusts
 *     127.0.0.1 traffic and provisions an admin user lazily on first hit.
 *
 * Atomic: every row goes in via a single `db.transaction(...)`. A
 * process crash mid-flow leaves no half-state.
 *
 * Idempotent: `ON CONFLICT DO NOTHING` on the user PK, the org PK, and
 * the `(organization_id, user_id)` unique index on member. Re-running
 * for an existing user is a clean no-op.
 *
 * Race-safe: concurrent invocations for the same user converge on a
 * single row at each table — no double-membership, no orphan org.
 */

import { db, schema, type Database } from "@repo/db";
import { generateId } from "@repo/core";

const { user, organization, member, account } = schema;

export type ProvisionTransaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

export interface ProvisionUserInput {
  id: string;
  name: string | null | undefined;
  email: string;
  emailVerified?: boolean;
  role?: "admin" | "user";
  autoProvisioned?: boolean;
  image?: string | null;
}

export interface ProvisionCredentialInput {
  /** Better Auth's credential password hash, never the plaintext password. */
  passwordHash: string;
  /** Optional deterministic id for migrations/tests; generated in normal use. */
  accountId?: string;
}

/** Insert the identity invariant using an existing transaction. */
export async function provisionUserInTransaction(
  tx: ProvisionTransaction,
  input: ProvisionUserInput,
): Promise<string> {
  const personalOrgId = `org_${input.id}`;
  const displayName = input.name?.trim() || input.email.split("@")[0];
  const slugSeed = input.email
    .split("@")[0]
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const slug = `ws-${slugSeed}-${input.id.slice(0, 8)}`;

  await tx
    .insert(user)
    .values({
      id: input.id,
      name: displayName,
      email: input.email,
      emailVerified: input.emailVerified ?? false,
      role: input.role ?? "user",
      autoProvisioned: input.autoProvisioned ?? false,
      image: input.image ?? null,
    })
    .onConflictDoNothing({ target: user.id });

  await tx
    .insert(organization)
    .values({
      id: personalOrgId,
      name: `${displayName}'s workspace`,
      slug,
    })
    .onConflictDoNothing({ target: organization.id });

  await tx
    .insert(member)
    .values({
      id: generateId("mem"),
      organizationId: personalOrgId,
      userId: input.id,
      role: "owner",
    })
    .onConflictDoNothing();

  return personalOrgId;
}

/**
 * Ensure the user row + personal org + owner membership all exist.
 * Returns the personal org id (deterministic: `org_${userId}`).
 *
 * Call from any code path that creates or first-touches a user identity.
 */
export async function provisionUser(input: ProvisionUserInput): Promise<string> {
  return db.transaction((rawTx) => provisionUserInTransaction(rawTx as ProvisionTransaction, input));
}

/**
 * Create an invited password user as one database commit.
 *
 * This is intentionally separate from Better Auth's public signup handler: a
 * self-hosted invitation is the authorization, and public signup is disabled.
 * The user, personal workspace, owner membership, and credential either all
 * commit or all roll back. A process/database failure can no longer leave an
 * accountless user that permanently turns a retry into a 409.
 */
export async function provisionUserWithCredential(
  input: ProvisionUserInput,
  credential: ProvisionCredentialInput,
): Promise<string> {
  return db.transaction(async (rawTx) => {
    return provisionUserWithCredentialInTransaction(
      rawTx as ProvisionTransaction,
      input,
      credential,
    );
  });
}

/** Transaction-aware variant used when another authorization row must be
 * locked and validated in the same commit as the new identity. */
export async function provisionUserWithCredentialInTransaction(
  tx: ProvisionTransaction,
  input: ProvisionUserInput,
  credential: ProvisionCredentialInput,
): Promise<string> {
  const personalOrgId = await provisionUserInTransaction(tx, input);
  await tx.insert(account).values({
    id: credential.accountId ?? generateId("acc"),
    accountId: input.id,
    providerId: "credential",
    userId: input.id,
    password: credential.passwordHash,
  });
  return personalOrgId;
}
