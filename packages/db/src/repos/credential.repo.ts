import { and, eq, isNull, sql } from "drizzle-orm";
import { generateId } from "@repo/core";
import type { Database } from "../client";
import { credential } from "../schema";

// ─── Types ───────────────────────────────────────────────────────────────────

export type Credential = typeof credential.$inferSelect;
export type NewCredential = typeof credential.$inferInsert;

// ─── Repository ──────────────────────────────────────────────────────────────

/**
 * Storage for third-party credentials. Knows nothing about providers — the field split,
 * validation and verification all live above this layer, so a new provider never reaches
 * here (see `CREDENTIAL_PROVIDERS` in @repo/core).
 *
 * Every read is org-scoped by construction: there is deliberately no `findById(id)`
 * without an organization, because the one thing this table must never do is hand one
 * tenant's secret to another.
 */
export function createCredentialRepo(db: Database) {
  return {
    /** Every credential for an org, newest first. */
    async listByOrg(organizationId: string): Promise<Credential[]> {
      return db.query.credential.findMany({
        where: eq(credential.organizationId, organizationId),
        orderBy: (c, { desc }) => desc(c.createdAt),
      });
    },

    /** One credential, scoped to its org — the only way to read a single row. */
    async findById(organizationId: string, id: string): Promise<Credential | undefined> {
      return db.query.credential.findFirst({
        where: and(eq(credential.organizationId, organizationId), eq(credential.id, id)),
      });
    },

    /**
     * The ACTIVE credential for a provider + resource, which is what a consumer asks for.
     *
     * `selector` must arrive already normalized (`normalizeCredentialSelector`) — matching
     * is exact, so a raw `https://GHCR.IO/` would find nothing. A null selector matches
     * only rows stored with NULL, never "any": an org-wide Cloudflare token must not be
     * returned as though it were a credential for some specific registry.
     *
     * Newest wins when an org somehow holds two for the same resource (possible across a
     * rename), so the answer is at least deterministic rather than storage-order.
     */
    async findActive(
      organizationId: string,
      provider: string,
      selector: string | null,
    ): Promise<Credential | undefined> {
      return db.query.credential.findFirst({
        where: and(
          eq(credential.organizationId, organizationId),
          eq(credential.provider, provider),
          eq(credential.status, "active"),
          selector === null ? isNull(credential.selector) : eq(credential.selector, selector),
        ),
        orderBy: (c, { desc }) => desc(c.createdAt),
      });
    },

    /** Active credentials for a provider, whatever they are scoped to. */
    async listActiveByProvider(
      organizationId: string,
      provider: string,
    ): Promise<Credential[]> {
      return db.query.credential.findMany({
        where: and(
          eq(credential.organizationId, organizationId),
          eq(credential.provider, provider),
          eq(credential.status, "active"),
        ),
        orderBy: (c, { desc }) => desc(c.createdAt),
      });
    },

    async create(
      data: Omit<NewCredential, "id" | "createdAt" | "updatedAt">,
    ): Promise<Credential> {
      const row = { id: generateId("cred"), ...data };
      await db.insert(credential).values(row);
      const created = await db.query.credential.findFirst({
        where: eq(credential.id, row.id),
      });
      if (!created) throw new Error("credential insert did not persist");
      return created;
    },

    /**
     * Patch a credential in place.
     *
     * `secretsEnc` is OMITTED from the patch type on purpose... it is not: a rotation must
     * be able to replace it. What callers must not do is pass `secretsEnc: undefined`
     * meaning "keep" — Drizzle would ignore the key, which is the behaviour we want, but
     * relying on that is easy to get wrong, so the service builds the patch explicitly.
     */
    async update(
      organizationId: string,
      id: string,
      patch: Partial<
        Pick<
          NewCredential,
          "name" | "selector" | "publicFields" | "secretsEnc" | "status" | "lastVerifiedAt" | "lastError"
        >
      >,
    ): Promise<Credential | undefined> {
      await db
        .update(credential)
        .set({ ...patch, updatedAt: new Date() })
        .where(and(eq(credential.organizationId, organizationId), eq(credential.id, id)));
      return db.query.credential.findFirst({
        where: and(eq(credential.organizationId, organizationId), eq(credential.id, id)),
      });
    },

    /**
     * Record the outcome of a verify or a real use.
     *
     * The `invalid` half is the point: a credential revoked upstream otherwise fails every
     * deploy or domain provision forever with nothing in the UI to explain it. `reason`
     * must already be redacted by the caller — this layer does not inspect it.
     */
    async markVerified(organizationId: string, id: string): Promise<void> {
      await db
        .update(credential)
        .set({ status: "active", lastVerifiedAt: new Date(), lastError: null, updatedAt: new Date() })
        .where(and(eq(credential.organizationId, organizationId), eq(credential.id, id)));
    },

    async markInvalid(organizationId: string, id: string, reason: string): Promise<void> {
      await db
        .update(credential)
        .set({ status: "invalid", lastError: reason.slice(0, 500), updatedAt: new Date() })
        .where(and(eq(credential.organizationId, organizationId), eq(credential.id, id)));
    },

    async remove(organizationId: string, id: string): Promise<void> {
      await db
        .delete(credential)
        .where(and(eq(credential.organizationId, organizationId), eq(credential.id, id)));
    },

    /**
     * Does another row already claim this (provider, selector, name)?
     *
     * Mirrors the unique index — including its `COALESCE(selector, '')`, because a NULL
     * selector compares as distinct in SQL and a plain `=` check would report "free" for a
     * name that the index will then reject with a 500.
     */
    async nameTaken(
      organizationId: string,
      provider: string,
      selector: string | null,
      name: string,
      exceptId?: string,
    ): Promise<boolean> {
      const rows = await db.query.credential.findMany({
        where: and(
          eq(credential.organizationId, organizationId),
          eq(credential.provider, provider),
          eq(credential.name, name),
          sql`COALESCE(${credential.selector}, '') = COALESCE(${selector ?? null}, '')`,
        ),
        columns: { id: true },
      });
      return rows.some((r) => r.id !== exceptId);
    },
  };
}
