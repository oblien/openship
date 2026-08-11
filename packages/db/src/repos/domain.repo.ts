import { eq, and, ne, lt, inArray, sql } from "drizzle-orm";
import { generateId } from "@repo/core";
import type { Database } from "../client";
import { domain, project, service } from "../schema";

// ─── Types ───────────────────────────────────────────────────────────────────

export type Domain = typeof domain.$inferSelect;
export type NewDomain = typeof domain.$inferInsert;

// ─── Repository ──────────────────────────────────────────────────────────────

export function createDomainRepo(db: Database) {
  /**
   * A project has exactly ONE primary domain: promoting one demotes the rest.
   *
   * The single implementation behind both `setPrimary` (explicit switch) and
   * `findOrCreate` (a write that asks for `isPrimary`). `findOrCreate` used to
   * only SET the flag, so adding a second primary — the CLI attaching a real
   * custom domain after a free `*.opsh.io` had been registered — left two rows
   * flagged, and readers took whichever came back first: the Domains tab showed a
   * stale, never-verified subdomain as the project's address while the box was
   * served on the custom one.
   */
  async function promotePrimary(projectId: string, domainId: string) {
    await db
      .update(domain)
      .set({ isPrimary: false, updatedAt: new Date() })
      .where(
        and(eq(domain.projectId, projectId), eq(domain.isPrimary, true), ne(domain.id, domainId)),
      );
    await db
      .update(domain)
      .set({ isPrimary: true, updatedAt: new Date() })
      .where(eq(domain.id, domainId));
  }

  return {
    async findById(id: string) {
      return db.query.domain.findFirst({
        where: eq(domain.id, id),
      });
    },

    async findByHostname(hostname: string) {
      return db.query.domain.findFirst({
        where: eq(domain.hostname, hostname.toLowerCase()),
      });
    },

    /**
     * Every hostname Openship tracks, instance-wide.
     *
     * Deliberately NOT org-scoped: the only caller is the edge-orphan sweep,
     * which asks "does the box serve a vhost nobody has a record of". One edge
     * fronts every org on the box, so scoping this to one org would report
     * another org's live domains as orphans. Hostnames only (no rows), used
     * purely as a set-membership check.
     */
    async listAllHostnames(): Promise<string[]> {
      const rows = await db.query.domain.findMany({ columns: { hostname: true } });
      return rows.map((r) => r.hostname);
    },

    /**
     * Return every domain row for a project.
     *
     * Most callers (routing-domain resolution, build pipeline, project
     * teardown) genuinely need every domain — they iterate every row
     * to install certs, register routes, or clean up state. Pagination
     * would break those flows.
     *
     * For dashboard reads that only need a bounded preview, pass
     * `limit`/`offset` and a deterministic order. The default (no
     * args) keeps the every-row contract for the internal callers.
     */
    async listByProject(
      projectId: string,
      opts?: { limit?: number; offset?: number },
    ) {
      return db.query.domain.findMany({
        where: eq(domain.projectId, projectId),
        ...(opts?.limit !== undefined ? { limit: opts.limit } : {}),
        ...(opts?.offset !== undefined ? { offset: opts.offset } : {}),
      });
    },

    /**
     * Every domain row for a set of projects, in ONE round trip.
     *
     * The batch shape `getPrimariesByProjects` uses, but returning ALL rows grouped
     * by project instead of one primary each: the Issues feed needs every hostname's
     * verification and cert state, not the project's address. Projects with no
     * domains are simply absent from the map, so callers should default to `[]`.
     */
    async listByProjects(projectIds: string[]): Promise<Map<string, Domain[]>> {
      const out = new Map<string, Domain[]>();
      if (projectIds.length === 0) return out;
      const rows = await db.query.domain.findMany({
        where: inArray(domain.projectId, projectIds),
      });
      for (const row of rows) {
        if (!row.projectId) continue; // webhook-owned domains have no project
        const list = out.get(row.projectId);
        if (list) list.push(row);
        else out.set(row.projectId, [row]);
      }
      return out;
    },

    /**
     * Single-row lookup for `(projectId, hostname)`. Use this instead
     * of `listByProject(...).find(d => d.hostname === h)` — controllers
     * that match a single hostname don't need to fan-out a full list.
     */
    async findByHostnameForProject(projectId: string, hostname: string) {
      return db.query.domain.findFirst({
        where: and(
          eq(domain.projectId, projectId),
          eq(domain.hostname, hostname.toLowerCase()),
        ),
      });
    },

    /**
     * Ids of domains in an org whose hostname matches a search term.
     *
     * Joined through project because `domain` has no organizationId of its own.
     * Feeds the audit feed's search: a domain row stores `dom_…`, so "example.com"
     * only finds it once the hostname is resolved to ids.
     */
    async searchIdsByHostname(organizationId: string, term: string, limit = 200): Promise<string[]> {
      const rows = await db
        .select({ id: domain.id })
        .from(domain)
        .innerJoin(project, eq(domain.projectId, project.id))
        .where(
          and(
            eq(project.organizationId, organizationId),
            sql`${domain.hostname} ILIKE ${`%${term}%`}`,
          ),
        )
        .limit(limit);
      return rows.map((r) => r.id);
    },

    async listByIds(ids: string[]) {
      if (ids.length === 0) return [];

      const rows = await db.query.domain.findMany({
        where: inArray(domain.id, ids),
      });
      const order = new Map(ids.map((id, index) => [id, index]));
      return rows.sort((left, right) => (order.get(left.id) ?? 0) - (order.get(right.id) ?? 0));
    },

    async update(id: string, data: Partial<NewDomain>) {
      await db
        .update(domain)
        .set({ ...data, updatedAt: new Date() })
        .where(eq(domain.id, id));
    },

    /** Return the primary domain for a project (or first domain, or null). */
    async getPrimaryByProject(projectId: string): Promise<Domain | null> {
      const rows = await db.query.domain.findMany({
        where: eq(domain.projectId, projectId),
      });
      return rows.find((d) => d.isPrimary) ?? rows[0] ?? null;
    },

    /**
     * Batch variant of getPrimaryByProject — one SQL round trip for N
     * projects. Used by getHome to eliminate the N+1.
     */
    async getPrimariesByProjects(projectIds: string[]): Promise<Map<string, Domain>> {
      if (projectIds.length === 0) return new Map();
      const rows = await db.query.domain.findMany({
        where: inArray(domain.projectId, projectIds),
      });
      // Prefer isPrimary=true; fall back to first row encountered per project.
      const out = new Map<string, Domain>();
      for (const row of rows) {
        if (!row.projectId) continue; // webhook-owned domains have no project
        const existing = out.get(row.projectId);
        if (!existing || (row.isPrimary && !existing.isPrimary)) {
          out.set(row.projectId, row);
        }
      }
      return out;
    },

    async create(data: Omit<NewDomain, "id"> & { verificationToken?: string }) {
      const id = generateId("dom");
      const row = {
        id,
        ...data,
        hostname: data.hostname.toLowerCase(),
        verificationToken: data.verificationToken ?? id,
      };
      await db.insert(domain).values(row);
      return { ...row, createdAt: new Date(), updatedAt: new Date() } as Domain;
    },

    /**
     * Return an existing domain by hostname, or create it if missing.
     * Safe against unique-constraint races (concurrent deploys).
     */
    async findOrCreate(data: Omit<NewDomain, "id"> & { verificationToken?: string }) {
      const hostname = data.hostname.toLowerCase();
      const existing = await db.query.domain.findFirst({
        where: eq(domain.hostname, hostname),
      });
      if (existing) {
        // Promote to primary if caller wants it and it isn't already
        if (data.isPrimary && !existing.isPrimary) {
          // projectId is nullable (webhook-owned rows have no project) — those
          // just get the flag, there are no siblings to demote.
          if (existing.projectId) await promotePrimary(existing.projectId, existing.id);
          else {
            await db.update(domain)
              .set({ isPrimary: true, updatedAt: new Date() })
              .where(eq(domain.id, existing.id));
          }
          return { ...existing, isPrimary: true };
        }
        return existing;
      }

      const id = generateId("dom");
      const row = {
        id,
        ...data,
        hostname,
        verificationToken: data.verificationToken ?? id,
      };
      try {
        await db.insert(domain).values(row);
        if (row.isPrimary && row.projectId) await promotePrimary(row.projectId, id);
        return { ...row, createdAt: new Date(), updatedAt: new Date() } as Domain;
      } catch (err: any) {
        // Handle race: another deploy inserted between our check and insert
        if (err?.message?.includes("unique") || err?.code === "23505") {
          const raced = await db.query.domain.findFirst({
            where: eq(domain.hostname, hostname),
          });
          if (raced) return raced;
        }
        throw err;
      }
    },

    async markVerified(id: string) {
      await db
        .update(domain)
        .set({
          verified: true,
          verifiedAt: new Date(),
          status: "active",
          // Reset the verify state machine on success.
          verifyAttempts: 0,
          lastVerifyError: null,
          lastCheckedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(domain.id, id));
    },

    /**
     * Flip a row to verified + SSL active (+ promote to primary) in ONE
     * transaction.
     *
     * These three writes describe a single outcome — "this domain is live on TLS" —
     * and the callers ran them as separate awaits, so a failure between them left a
     * row that read `verified` with no active SSL, or verified-and-active but not
     * primary. The infra work (the cert on disk) has already succeeded by the time
     * this runs, so a half-applied row is pure drift: the box serves the domain
     * while Openship shows it pending.
     *
     * `promote` demotes the project's other primaries first, and is skipped when
     * the caller has decided this row shouldn't take primary.
     */
    async markVerifiedActive(
      id: string,
      data: {
        sslStatus: string;
        sslIssuer?: string;
        sslExpiresAt?: Date;
        manualSsl?: boolean;
        promote?: { projectId: string };
      },
    ) {
      const { promote, ...ssl } = data;
      await db.transaction(async (tx) => {
        const now = new Date();
        await tx
          .update(domain)
          .set({
            verified: true,
            verifiedAt: now,
            status: "active",
            verifyAttempts: 0,
            lastVerifyError: null,
            lastCheckedAt: now,
            ...ssl,
            updatedAt: now,
          })
          .where(eq(domain.id, id));
        if (promote) {
          await tx
            .update(domain)
            .set({ isPrimary: false, updatedAt: now })
            .where(
              and(
                eq(domain.projectId, promote.projectId),
                eq(domain.isPrimary, true),
                ne(domain.id, id),
              ),
            );
          await tx.update(domain).set({ isPrimary: true, updatedAt: now }).where(eq(domain.id, id));
        }
      });
    },

    /**
     * Record a failed verification attempt: bump the counter, stamp the time +
     * reason, and flip status to `failed` only once attempts cross `failAfter`
     * (so a still-propagating domain stays `pending`, a misconfigured one
     * eventually reads `failed`). Returns the new attempt count.
     */
    async recordVerifyFailure(
      id: string,
      error: string,
      failAfter = 8,
    ): Promise<number> {
      const row = await db.query.domain.findFirst({ where: eq(domain.id, id) });
      const attempts = (row?.verifyAttempts ?? 0) + 1;
      await db
        .update(domain)
        .set({
          verifyAttempts: attempts,
          lastVerifyError: error,
          lastCheckedAt: new Date(),
          ...(attempts >= failAfter ? { status: "failed" } : {}),
          updatedAt: new Date(),
        })
        .where(eq(domain.id, id));
      return attempts;
    },

    /** `manualSsl` is declared because callers pass it (via spread, which slips
     *  past excess-property checking) — the flag decides whether the SSL scheduler
     *  will renew this row, so it must be visible in the type. */
    async updateSsl(
      id: string,
      data: {
        sslStatus: string;
        sslIssuer?: string;
        sslExpiresAt?: Date;
        manualSsl?: boolean;
        // Set when a deploy-time issuance fails on a still-unverified domain — the
        // reason shown behind the Action-Required dot. Column already exists.
        lastVerifyError?: string | null;
      },
    ) {
      await this.update(id, data);
    },

    async updateStatus(id: string, status: string) {
      await this.update(id, { status });
    },

    async remove(id: string) {
      await db.delete(domain).where(eq(domain.id, id));
    },

    /**
     * Delete a domain row AND patch the owning service's routing columns in ONE
     * transaction, because the two writes describe one outcome: "this service no
     * longer serves this hostname".
     *
     * As separate awaits, a failure after the delete left the service still
     * configured for a hostname whose row is gone — and that stale
     * `*.opsh.io` slug then made preflight demand an Openship Cloud connection
     * for every later action on the project, with nothing left to retry against.
     */
    async removeWithServiceRouting(
      id: string,
      servicePatch: { serviceId: string; routing: Record<string, unknown> },
    ) {
      await db.transaction(async (tx) => {
        await tx.delete(domain).where(eq(domain.id, id));
        await tx
          .update(service)
          .set({ ...servicePatch.routing, updatedAt: new Date() })
          .where(eq(service.id, servicePatch.serviceId));
      });
    },

    /** Hard-delete every domain row tied to a project. Frees managed slugs immediately on project teardown. */
    async deleteByProjectId(projectId: string) {
      await db.delete(domain).where(eq(domain.projectId, projectId));
    },

    /** Hard-delete every domain row tied to a service. Clears derived routing rows on service teardown. */
    async deleteByServiceId(serviceId: string) {
      await db.delete(domain).where(eq(domain.serviceId, serviceId));
    },

    /** Find all domains needing SSL renewal */
    async findExpiringSsl(beforeDate: Date) {
      return db.query.domain.findMany({
        where: and(
          eq(domain.sslStatus, "active"),
          lt(domain.sslExpiresAt, beforeDate),
        ),
      });
    },

    /**
     * Find custom domains stuck in pending state (verified=false +
     * status=pending) created before `beforeDate`. Used by the pending-
     * verifier cron to re-check DNS for rows whose user added the domain
     * but never clicked Verify (or whose DNS hasn't propagated yet).
     *
     * `beforeDate` is the "added at least N minutes ago" cutoff — we
     * skip just-added rows so the cron doesn't race with the UI's
     * immediate Verify click. Free-managed rows are excluded; they
     * don't go through DNS verification (we own the suffix).
     */
    /**
     * Custom domains that are DNS-VERIFIED but still have no usable certificate.
     *
     * The gap this closes: `findPendingVerification` only returns `verified: false`
     * rows, and the renewal sweep only looks at certs that already exist (it needs an
     * expiry to compare). A domain whose first issuance failed is verified with
     * `sslStatus: "provisioning"` — too verified for one job, no cert for the other —
     * so nothing retried it and the operator had to click Verify + Redeploy by hand.
     */
    async findPendingSsl(limit = 50, organizationId?: string): Promise<Domain[]> {
      const conds = [
        eq(domain.verified, true),
        eq(domain.domainType, "custom"),
        inArray(domain.sslStatus, ["provisioning", "none", "pending"]),
        // Externally-terminated TLS is not ours to issue; certbot never will.
        eq(domain.externalIngress, false),
      ];
      if (organizationId) {
        conds.push(
          inArray(
            domain.projectId,
            db
              .select({ id: project.id })
              .from(project)
              .where(eq(project.organizationId, organizationId)),
          ),
        );
      }
      return db.select().from(domain).where(and(...conds)).limit(limit);
    },

    async findPendingVerification(
      beforeDate: Date,
      limit = 100,
      organizationId?: string,
    ): Promise<Domain[]> {
      const conds = [
        eq(domain.verified, false),
        eq(domain.status, "pending"),
        eq(domain.domainType, "custom"),
        lt(domain.createdAt, beforeDate),
      ];
      // Org scope (HTTP /verify-pending): only this org's pending domains, so a
      // tenant can neither enumerate nor trigger verification/SSL on another
      // tenant's domains, and the row cap applies to their OWN backlog. `domain`
      // has no organizationId column, so filter via its project. Omitted →
      // instance-wide (the system `domains:verify-pending` cron only).
      if (organizationId) {
        conds.push(
          inArray(
            domain.projectId,
            db
              .select({ id: project.id })
              .from(project)
              .where(eq(project.organizationId, organizationId)),
          ),
        );
      }
      const rows = await db.query.domain.findMany({ where: and(...conds) });
      return rows.slice(0, limit);
    },

    /** Set primary domain for a project (unsets previous primary). */
    async setPrimary(projectId: string, domainId: string) {
      await promotePrimary(projectId, domainId);
    },
  };
}
