import { reportCaughtError as observeCaughtError } from "@repo/core/diagnostics";
import {
  eq,
  and,
  or,
  ne,
  lt,
  lte,
  gte,
  asc,
  inArray,
  isNull,
  isNotNull,
  notExists,
  notLike,
  sql,
} from "drizzle-orm";
import { ConflictError, generateId, DOMAIN_RETRY_DELAYS_MS } from "@repo/core";
import type { Database } from "../client";
import { domain, orphanedResource, project, service, ingressConnection, ingressHostname } from "../schema";
import { assertProjectConfigurationWritable, withProjectConfigurationWrite } from "./project-work-admission";

// ─── Types ───────────────────────────────────────────────────────────────────

export type Domain = typeof domain.$inferSelect;
export type NewDomain = typeof domain.$inferInsert;
type RepoTransaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

// ─── Repository ──────────────────────────────────────────────────────────────

export function createDomainRepo(db: Database) {
  const ownerPredicate = (id: string) => inArray(project.id,
    db.select({ id: domain.projectId }).from(domain).where(eq(domain.id, id)));
  // Filter before LIMIT so recent failures cannot starve older, eligible rows.
  // The same persisted counter/timestamp drives the next-check time in clients.
  function retryDue(now = new Date()) {
    return or(
      eq(domain.verifyAttempts, 0),
      isNull(domain.lastCheckedAt),
      ...DOMAIN_RETRY_DELAYS_MS.map((delay, index) =>
        and(
          index === DOMAIN_RETRY_DELAYS_MS.length - 1
            ? gte(domain.verifyAttempts, index + 1)
            : eq(domain.verifyAttempts, index + 1),
          lte(domain.lastCheckedAt, new Date(now.getTime() - delay)),
        ),
      ),
    );
  }

  function liveVerificationOwner(organizationId?: string) {
    return and(
      inArray(
        domain.projectId,
        db
          .select({ id: project.id })
          .from(project)
          .where(
            and(
              isNull(project.deletedAt),
              isNull(project.disabledAt),
              eq(project.deletionInProgress, false),
              isNotNull(project.activeDeploymentId),
              organizationId ? eq(project.organizationId, organizationId) : undefined,
            ),
          ),
      ),
      or(
        isNull(domain.serviceId),
        inArray(
          domain.serviceId,
          db
            .select({ id: service.id })
            .from(service)
            .where(and(eq(service.enabled, true), eq(service.exposed, true))),
        ),
      ),
    );
  }

  /** The topology and domain row own the same hostname and must disappear together. */
  async function removeInTransaction(tx: RepoTransaction, id: string) {
    const [row] = await tx.select({ projectId: domain.projectId, hostname: domain.hostname })
      .from(domain).where(eq(domain.id, id));
    if (row?.projectId) {
      await assertProjectConfigurationWritable(tx, eq(project.id, row.projectId));
      const [owner] = await tx.select({ compositeRoutes: project.compositeRoutes })
        .from(project).where(eq(project.id, row.projectId)).for("update");
      const routes = owner?.compositeRoutes ?? [];
      const remaining = routes.filter((route) => route.hostname.toLowerCase() !== row.hostname.toLowerCase());
      if (remaining.length !== routes.length) await tx.update(project)
        .set({ compositeRoutes: remaining, updatedAt: new Date() }).where(eq(project.id, row.projectId));
    }
    await tx.delete(domain).where(eq(domain.id, id));
  }

  /**
   * A project has at most ONE primary domain: promoting one demotes the rest.
   *
   * Every path that writes `isPrimary: true` comes through this helper. The
   * project-row lock serializes competing promotions across API replicas, while
   * the partial unique index is the final guard against writes outside this
   * repository. Demotion and promotion share one transaction, so a failed
   * promotion cannot commit after clearing the previous primary.
   */
  async function promotePrimaryInTransaction(
    tx: RepoTransaction,
    projectId: string,
    domainId: string,
    patch: Partial<NewDomain> = {},
  ): Promise<boolean> {
    await assertProjectConfigurationWritable(tx, or(eq(project.id, projectId), ownerPredicate(domainId))!);

    const [target] = await tx
      .select({ projectId: domain.projectId })
      .from(domain)
      .where(eq(domain.id, domainId))
      .for("update");
    const targetProjectId = patch.projectId === undefined ? target?.projectId : patch.projectId;
    if (!target || targetProjectId !== projectId) return false;

    const now = new Date();
    await tx
      .update(domain)
      .set({ isPrimary: false, updatedAt: now })
      .where(
        and(eq(domain.projectId, projectId), eq(domain.isPrimary, true), ne(domain.id, domainId)),
      );
    await tx
      .update(domain)
      .set({ ...patch, isPrimary: true, updatedAt: now })
      .where(eq(domain.id, domainId));
    return true;
  }

  async function promotePrimary(
    projectId: string,
    domainId: string,
    patch: Partial<NewDomain> = {},
  ): Promise<boolean> {
    return db.transaction((tx) => promotePrimaryInTransaction(tx, projectId, domainId, patch));
  }

  /**
   * Insert a row and return it as the DB actually stored it.
   *
   * `{ ...values } as Domain` was a lie for every column the caller didn't pass:
   * `sslStatus`, `sslChallenge`, `status`, `verified`, `verifyAttempts`,
   * `externalIngress`, `manualSsl` and `ownerType` are NOT-NULL columns with DB
   * DEFAULTS, so the returned object satisfied the type while carrying `undefined`
   * them. Readers that compare against the default then quietly take the wrong
   * branch — the deploy's first-issuance gate asks `row.sslStatus === "none"`, got
   * `undefined === "none"` → false, and skipped the certificate for every
   * domain minted at deploy time.
   *
   * One extra SELECT on a path that runs once per new domain, and it cannot drift
   * as the schema's defaults change.
   */
  async function insertAndRead(row: NewDomain & { id: string }): Promise<Domain> {
    await db.transaction(async (tx) => {
      if (row.projectId) await assertProjectConfigurationWritable(tx, eq(project.id, row.projectId));
      let connection: typeof ingressConnection.$inferSelect | undefined;
      if (row.projectId && row.domainType === "custom") {
        const [binding] = await tx.select({ connection: ingressConnection })
          .from(ingressConnection)
          .innerJoin(project, and(
            eq(project.serverId, ingressConnection.serverId),
            eq(project.organizationId, ingressConnection.organizationId),
          ))
          .where(and(
            eq(project.id, row.projectId),
            eq(ingressConnection.defaultForDomains, true),
            ne(ingressConnection.status, "removing"),
          )).limit(1);
        connection = binding?.connection;
        if (connection) {
          if (row.hostname.startsWith("*."))
            throw new ConflictError("Use an exact hostname with the managed Cloudflare Tunnel, or disable the server's automatic domain connection first.");
          row.externalIngress = true;
        }
      }
      await tx.insert(domain).values(row);
      if (connection) await tx.insert(ingressHostname).values({
        id: generateId("igh"), connectionId: connection.id, domainId: row.id,
        hostname: row.hostname, accessPolicyId: connection.defaultAccessPolicyId,
      });
      // A force-deleted project's route orphan owns the hostname until its
      // physical vhost and managed registration are actually reclaimed. Check
      // AFTER the unique domain insert: if this insert waited for the old
      // project's cascade delete, READ COMMITTED now sees the orphan persisted
      // immediately before it. Rolling back keeps GC from deleting a reused host.
      const [pendingCleanup] = await tx
        .select({ id: orphanedResource.id })
        .from(orphanedResource)
        .where(
          and(
            eq(orphanedResource.resourceType, "route"),
            eq(orphanedResource.ref, row.hostname.toLowerCase()),
            // Teardown checkpoints can survive a failed final project delete.
            // GC defers those while the project is live: they must not prevent
            // that SAME owner from restoring its domain row. Keep the checkpoint
            // for eventual cleanup, and keep reserving the host against all other
            // projects (including project-less domains and soft-deleted owners).
            row.projectId
              ? notExists(
                  tx
                    .select({ id: project.id })
                    .from(project)
                    .where(
                      and(
                        eq(project.id, row.projectId),
                        eq(project.id, orphanedResource.projectId),
                        isNull(project.deletedAt),
                        eq(project.deletionInProgress, false),
                      ),
                    ),
                )
              : undefined,
          ),
        )
        .limit(1);
      if (pendingCleanup) {
        throw new ConflictError(
          `Hostname ${row.hostname} is still being cleaned up from a deleted project`,
        );
      }
    });
    // NON-THROWING on purpose. The INSERT has already landed, so a rejecting
    // read-back (connection blip, statement timeout, pool exhaustion) must not
    // turn a SUCCESSFUL create into a create failure — the caller would then
    // treat the hostname as unclaimable and skip routing it while the row exists.
    // `findOrCreate`'s own catch can't save it either: that only re-reads on a
    // unique violation. Degrade to the insert values (the pre-existing return
    // shape) instead, which is strictly better than throwing.
    const created = await db.query.domain
      .findFirst({ where: eq(domain.id, row.id) })
      .catch((diagnosticFailure) => { observeCaughtError(diagnosticFailure, "db/repos/domain.repo"); return undefined; });
    return created ?? ({ ...row, createdAt: new Date(), updatedAt: new Date() } as Domain);
  }

  const repository = {
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
    async listByProject(projectId: string, opts?: { limit?: number; offset?: number }) {
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
        where: and(eq(domain.projectId, projectId), eq(domain.hostname, hostname.toLowerCase())),
      });
    },

    /**
     * Ids of domains in an org whose hostname matches a search term.
     *
     * Joined through project because `domain` has no organizationId of its own.
     * Feeds the audit feed's search: a domain row stores `dom_…`, so "example.com"
     * only finds it once the hostname is resolved to ids.
     */
    async searchIdsByHostname(
      organizationId: string,
      term: string,
      limit = 200,
    ): Promise<string[]> {
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

    /**
     * Hostnames of the org's Cloud-managed (free) subdomains.
     *
     * Returns hostnames, not a count, because the CALLER owns the predicate: what
     * makes a hostname "ours" is `isCloudManagedHostname` (a `.opsh.io` suffix
     * test) which lives in the API next to the rest of the routing truth. A count
     * computed here would have to re-implement it in SQL and drift.
     *
     * Deliberately NOT filtered on `domain_type = 'free'`: that column is derived
     * against `HOST_DOMAIN || CLOUD_DOMAIN`, so on a box with
     * `HOST_DOMAIN=example.com` the operator's own `api.example.com` is stored as
     * "free" while costing Cloud nothing. Counting it would bill an operator for
     * their own DNS.
     *
     * Joined through `project` (domain has no organizationId) which also excludes
     * webhook- and mail-owned rows — those carry a NULL projectId and are always
     * custom hostnames. Soft-deleted projects are excluded: their rows are
     * unreachable, and a slot that can't be used must not be charged for.
     */
    async listHostnamesForOrg(organizationId: string, workspaceId?: string | null): Promise<string[]> {
      const rows = await db
        .select({ hostname: domain.hostname })
        .from(domain)
        .innerJoin(project, eq(domain.projectId, project.id))
        .where(and(eq(project.organizationId, organizationId), sql`${project.deletedAt} IS NULL`, projectWorkspaceScope(workspaceId)));
      return rows.map((r) => r.hostname);
    },

    /**
     * Every domain in the org WITH the project that holds it.
     *
     * The counterpart to `listHostnamesForOrg`, which returns bare strings and so
     * can only ever produce a number. A number is not actionable: a user at their
     * free-subdomain limit was told "you're using 10" with no way to discover
     * where — a subdomain created by a CLI deploy months ago, in a project they'd
     * forgotten, was invisible (there is no org-wide domains page and
     * `GET /api/domains` requires a projectId).
     *
     * Same join and filters as the counting query, so the list and the count can
     * never disagree about what occupies a slot.
     */
    async listForOrgWithProject(organizationId: string, workspaceId?: string | null): Promise<
      {
        id: string;
        hostname: string;
        domainType: string | null;
        isPrimary: boolean;
        projectId: string | null;
        projectName: string;
        projectSlug: string;
        serviceId: string | null;
        createdAt: Date;
      }[]
    > {
      return db
        .select({
          id: domain.id,
          hostname: domain.hostname,
          domainType: domain.domainType,
          isPrimary: domain.isPrimary,
          projectId: domain.projectId,
          projectName: project.name,
          projectSlug: project.slug,
          serviceId: domain.serviceId,
          createdAt: domain.createdAt,
        })
        .from(domain)
        .innerJoin(project, eq(domain.projectId, project.id))
        .where(and(eq(project.organizationId, organizationId), sql`${project.deletedAt} IS NULL`, projectWorkspaceScope(workspaceId)))
        .orderBy(asc(project.name), asc(domain.hostname));
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
      if (data.externalIngress === false || data.hostname !== undefined) {
        const [binding] = await db.select().from(ingressHostname)
          .where(eq(ingressHostname.domainId, id)).limit(1);
        if (binding && (data.externalIngress === false || data.hostname?.toLowerCase() !== binding.hostname))
          throw new ConflictError("Disconnect this hostname from Cloudflare Tunnel and wait for cleanup before changing its ingress mode or hostname.");
      }
      if (data.isPrimary === true) {
        const row = await db.query.domain.findFirst({ where: eq(domain.id, id) });
        const targetProjectId = data.projectId === undefined ? row?.projectId : data.projectId;
        if (targetProjectId && (await promotePrimary(targetProjectId, id, data))) return;
      }
      const predicate = or(ownerPredicate(id), data.projectId ? eq(project.id, data.projectId) : undefined)!;
      await withProjectConfigurationWrite(db, predicate, async (tx) => tx
        .update(domain)
        .set({ ...data, updatedAt: new Date() })
        .where(eq(domain.id, id)));
    },

    /** Return the primary domain for a project (or first domain, or null). */
    async getPrimaryByProject(projectId: string): Promise<Domain | null> {
      const rows = await db.query.domain.findMany({
        where: eq(domain.projectId, projectId),
      });
      const openable = rows.filter((d) => !d.hostname.startsWith("*."));
      return openable.find((d) => d.isPrimary) ?? openable[0] ?? null;
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
        if (!row.projectId || row.hostname.startsWith("*.")) continue;
        const existing = out.get(row.projectId);
        if (!existing || (row.isPrimary && !existing.isPrimary)) {
          out.set(row.projectId, row);
        }
      }
      return out;
    },

    async create(data: Omit<NewDomain, "id"> & { verificationToken?: string }) {
      const id = generateId("dom");
      const wantsPrimary = data.isPrimary === true && !!data.projectId;
      const created = await insertAndRead({
        id,
        ...data,
        // Insert as secondary so the unique invariant remains true until the
        // serialized promotion transaction can switch ownership.
        ...(wantsPrimary ? { isPrimary: false } : {}),
        hostname: data.hostname.toLowerCase(),
        verificationToken: data.verificationToken ?? id,
      });
      if (wantsPrimary && (await promotePrimary(data.projectId!, id))) {
        return { ...created, isPrimary: true };
      }
      return created;
    },

    /**
     * Return an existing domain by hostname, or create it if missing, together
     * with authoritative creation provenance.
     *
     * Callers that compensate/roll back a create must use this method instead
     * of comparing against an earlier list query. That comparison has a TOCTOU
     * window: another request can insert the hostname after the list and before
     * this insert, causing the loser of the race to delete a row it did not
     * create.
     */
    async findOrCreateWithStatus(
      data: Omit<NewDomain, "id"> & { verificationToken?: string },
    ): Promise<{ domain: Domain; created: boolean }> {
      const hostname = data.hostname.toLowerCase();
      const existing = await db.query.domain.findFirst({
        where: eq(domain.hostname, hostname),
      });
      if (existing) {
        // Promote to primary if caller wants it and it isn't already
        if (
          data.isPrimary &&
          !existing.isPrimary &&
          existing.projectId === (data.projectId ?? null)
        ) {
          // projectId is nullable (webhook-owned rows have no project) — those
          // just get the flag, there are no siblings to demote.
          if (existing.projectId) await promotePrimary(existing.projectId, existing.id);
          else {
            await db
              .update(domain)
              .set({ isPrimary: true, updatedAt: new Date() })
              .where(eq(domain.id, existing.id));
          }
          return { domain: { ...existing, isPrimary: true }, created: false };
        }
        return { domain: existing, created: false };
      }

      const id = generateId("dom");
      const wantsPrimary = data.isPrimary === true && !!data.projectId;
      const row = {
        id,
        ...data,
        ...(wantsPrimary ? { isPrimary: false } : {}),
        hostname,
        verificationToken: data.verificationToken ?? id,
      };
      try {
        const created = await insertAndRead(row);
        if (wantsPrimary && row.projectId && (await promotePrimary(row.projectId, id))) {
          return { domain: { ...created, isPrimary: true }, created: true };
        }
        return { domain: created, created: true };
      } catch (err: any) {
        // Handle race: another deploy inserted between our check and insert
        if (err?.message?.includes("unique") || err?.code === "23505") {
          const raced = await db.query.domain.findFirst({
            where: eq(domain.hostname, hostname),
          });
          if (raced) {
            if (
              data.isPrimary &&
              !raced.isPrimary &&
              raced.projectId === (data.projectId ?? null)
            ) {
              if (raced.projectId) await promotePrimary(raced.projectId, raced.id);
              else {
                await db
                  .update(domain)
                  .set({ isPrimary: true, updatedAt: new Date() })
                  .where(eq(domain.id, raced.id));
              }
              return { domain: { ...raced, isPrimary: true }, created: false };
            }
            return { domain: raced, created: false };
          }
        }
        throw err;
      }
    },

    /** Return an existing domain by hostname, or create it if missing. */
    async findOrCreate(data: Omit<NewDomain, "id"> & { verificationToken?: string }) {
      const result = await repository.findOrCreateWithStatus(data);
      return result.domain;
    },

    async markVerified(id: string) {
      await withProjectConfigurationWrite(db, ownerPredicate(id), async (tx) => tx
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
        .where(eq(domain.id, id)));
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
        await assertProjectConfigurationWritable(tx, or(ownerPredicate(id), promote ? eq(project.id, promote.projectId) : undefined)!);
        const now = new Date();
        const patch: Partial<NewDomain> = {
          verified: true,
          verifiedAt: now,
          status: "active",
          verifyAttempts: 0,
          lastVerifyError: null,
          lastCheckedAt: now,
          ...ssl,
        };
        if (promote) {
          const promoted = await promotePrimaryInTransaction(tx, promote.projectId, id, patch);
          if (promoted) return;
        }
        await tx
          .update(domain)
          .set({ ...patch, updatedAt: now })
          .where(eq(domain.id, id));
      });
    },

    /** A completed failed check is failed, even while its next retry is scheduled.
     * One SQL update prevents lost counters; a stale check cannot undo success. */
    async recordVerifyFailure(id: string, error: string): Promise<number> {
      const [row] = await withProjectConfigurationWrite(db, ownerPredicate(id), async (tx) => tx
        .update(domain)
        .set({
          verifyAttempts: sql`${domain.verifyAttempts} + 1`,
          lastVerifyError: error,
          lastCheckedAt: new Date(),
          status: "failed",
          updatedAt: new Date(),
        })
        .where(and(eq(domain.id, id), eq(domain.verified, false), ne(domain.status, "removing")))
        .returning());
      return row?.verifyAttempts ?? 0;
    },

    /** An unavailable observation preserves all certificate/DNS states. A failed
     * operation preserves a working certificate; a proven invalid/missing
     * certificate replaces it. All three share atomic retry bookkeeping. */
    async recordSslFailure(id: string, error: string, kind: "operation" | "unknown" | "invalid" = "operation") {
      await withProjectConfigurationWrite(db, ownerPredicate(id), async (tx) => tx
        .update(domain)
        .set({
          verifyAttempts: sql`${domain.verifyAttempts} + 1`,
          lastVerifyError: error,
          lastCheckedAt: new Date(),
          status: kind === "unknown" ? sql`${domain.status}`
            : sql`case when ${domain.verified} then 'active' else 'failed' end`,
          sslStatus: kind === "unknown" ? sql`${domain.sslStatus}`
            : kind === "invalid" ? "error"
              : sql`case when ${domain.sslStatus} in ('active', 'external') then ${domain.sslStatus} else 'error' end`,
          updatedAt: new Date(),
        })
        .where(and(eq(domain.id, id), ne(domain.status, "removing"))));
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
      if (data.sslStatus === "error") {
        await this.recordSslFailure(
          id,
          data.lastVerifyError ?? "No usable HTTPS certificate was found on the server.",
          "invalid",
        );
        return;
      }
      if (data.sslStatus === "active" || data.sslStatus === "external" || data.sslStatus === "provisioning") {
        const now = new Date();
        // A certificate read alone does not prove cloud DNS ownership. Clear
        // TLS failures/pending attempts for verified rows; the verification transaction clears
        // unverified rows when the ownership check itself succeeds.
        await withProjectConfigurationWrite(db, ownerPredicate(id), async (tx) => tx
          .update(domain)
          .set({
            ...data,
            status: sql`case when ${domain.verified} then 'active' else ${domain.status} end`,
            verifyAttempts: sql`case when ${domain.verified} then 0 else ${domain.verifyAttempts} end`,
            lastVerifyError: sql`case when ${domain.verified} then null else ${domain.lastVerifyError} end`,
            lastCheckedAt: sql`case when ${domain.verified} then ${now.toISOString()}::timestamp else ${domain.lastCheckedAt} end`,
            updatedAt: now,
          })
          .where(and(eq(domain.id, id), ne(domain.status, "removing"))));
        return;
      }
      await this.update(id, data);
    },

    async updateStatus(id: string, status: string) {
      await this.update(id, { status });
    },

    async remove(id: string) {
      await db.transaction((tx) => removeInTransaction(tx, id));
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
        await assertProjectConfigurationWritable(tx, or(ownerPredicate(id), inArray(project.id,
          tx.select({ id: service.projectId }).from(service).where(eq(service.id, servicePatch.serviceId))))!);
        await removeInTransaction(tx, id);
        await tx
          .update(service)
          .set({ ...servicePatch.routing, updatedAt: new Date() })
          .where(eq(service.id, servicePatch.serviceId));
      });
    },

    /** Hard-delete every domain row tied to a project. Frees managed slugs immediately on project teardown. */
    async deleteByProjectId(projectId: string) {
      await withProjectConfigurationWrite(db, eq(project.id, projectId), async (tx) => tx.delete(domain).where(eq(domain.projectId, projectId)));
    },

    /** Hard-delete every domain row tied to a service. Clears derived routing rows on service teardown. */
    async deleteByServiceId(serviceId: string) {
      const predicate = inArray(project.id, db.select({ id: service.projectId }).from(service).where(eq(service.id, serviceId)));
      await withProjectConfigurationWrite(db, predicate, async (tx) => tx.delete(domain).where(eq(domain.serviceId, serviceId)));
    },

    /** Retry failed renewals while their existing certificate is due too.
     * Rows without an expiry (first issuance) and externally managed TLS are
     * excluded. A transient renewal error must not strand an expiring cert. */
    async findExpiringSsl(beforeDate: Date) {
      return db.query.domain.findMany({
        where: and(inArray(domain.sslStatus, ["active", "error"]), lt(domain.sslExpiresAt, beforeDate), ne(domain.sslDnsMode, "manual")),
      });
    },

    /** Read-only health checks also revisit certificates the provider calls
     * active. Scope, age and live ownership precede LIMIT for fair batching. */
    async findDueCloudSslChecks(beforeDate: Date, limit = 25, domainId?: string) {
      return db.select().from(domain).where(and(
        domainId ? eq(domain.id, domainId) : undefined,
        eq(domain.verified, true), eq(domain.domainType, "custom"),
        eq(domain.externalIngress, false), eq(domain.manualSsl, false),
        ne(domain.status, "removing"), notLike(domain.hostname, "%*%"),
        or(isNull(domain.lastCheckedAt), lte(domain.lastCheckedAt, beforeDate)),
        retryDue(), liveVerificationOwner(),
        inArray(domain.projectId, db.select({ id: project.id }).from(project)
          .where(isNotNull(project.workspaceId))),
      )).orderBy(sql`coalesce(${domain.lastCheckedAt}, ${domain.createdAt})`, asc(domain.id)).limit(limit);
    },

    /**
     * Custom domains that are DNS-VERIFIED but still have no usable certificate.
     *
     * The gap this closes: `findPendingVerification` only returns `verified: false`
     * rows, and the renewal sweep only looks at certs that already exist (it needs an
     * expiry to compare). A domain whose first issuance failed is verified with
     * `sslStatus: "provisioning"` — too verified for one job, no cert for the other —
     * so nothing retried it and the operator had to click Verify + Redeploy by hand.
     */
    async findPendingSsl(
      limit = 50,
      organizationId?: string,
      domainId?: string,
    ): Promise<Domain[]> {
      const conds = [
        domainId ? eq(domain.id, domainId) : undefined,
        eq(domain.verified, true),
        eq(domain.domainType, "custom"),
        or(
          inArray(domain.sslStatus, ["provisioning", "none", "pending", "error", "expired"]),
          and(eq(domain.sslStatus, "active"), lte(domain.sslExpiresAt, new Date())),
        ),
        ne(domain.status, "removing"),
        // Externally-terminated TLS is not ours to issue; certbot never will.
        eq(domain.externalIngress, false),
        eq(domain.manualSsl, false),
        ne(domain.sslDnsMode, "manual"),
        retryDue(),
        liveVerificationOwner(organizationId),
      ];
      return db
        .select()
        .from(domain)
        .where(and(...conds))
        .orderBy(sql`coalesce(${domain.lastCheckedAt}, ${domain.createdAt})`, asc(domain.id))
        .limit(limit);
    },

    /** Unverified custom domains, including failed checks, after the first-check
     * grace period and persisted backoff. Scope and eligibility precede LIMIT. */
    async findPendingVerification(
      beforeDate: Date,
      limit = 100,
      organizationId?: string,
      domainId?: string,
    ): Promise<Domain[]> {
      const conds = [
        domainId ? eq(domain.id, domainId) : undefined,
        eq(domain.verified, false),
        inArray(domain.status, ["pending", "failed"]),
        eq(domain.domainType, "custom"),
        ne(domain.sslDnsMode, "manual"),
        lte(domain.createdAt, beforeDate),
        retryDue(),
        liveVerificationOwner(organizationId),
      ];
      return db
        .select()
        .from(domain)
        .where(and(...conds))
        .orderBy(sql`coalesce(${domain.lastCheckedAt}, ${domain.createdAt})`, asc(domain.id))
        .limit(limit);
    },

    /** Set primary domain for a project (unsets previous primary). */
    async setPrimary(projectId: string, domainId: string) {
      await promotePrimary(projectId, domainId);
    },
  };

  return repository;
}
import { projectWorkspaceScope } from "./workspace-scope";
