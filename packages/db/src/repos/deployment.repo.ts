import { eq, and, desc, gte, lte, inArray, isNull, ne, sql } from "drizzle-orm";
import { generateId } from "@repo/core";
import type { Database } from "../client";
import { deployment, buildSession, project } from "../schema";

// ─── Types ───────────────────────────────────────────────────────────────────

export type Deployment = typeof deployment.$inferSelect;
export type NewDeployment = typeof deployment.$inferInsert;
export type BuildSession = typeof buildSession.$inferSelect;
export type NewBuildSession = typeof buildSession.$inferInsert;

// ─── Repository ──────────────────────────────────────────────────────────────

export function createDeploymentRepo(db: Database) {
  return {
    // ── Deployments ────────────────────────────────────────────────────

    async findById(id: string) {
      return db.query.deployment.findFirst({
        where: eq(deployment.id, id),
      });
    },

    /** All deployments in a given status (e.g. "reconciling") — drives the
     *  reconcile sweep. Bounded to avoid pulling an unbounded history. */
    async listByStatus(status: string, limit = 200) {
      return db
        .select()
        .from(deployment)
        .where(eq(deployment.status, status))
        .orderBy(desc(deployment.createdAt))
        .limit(limit);
    },

    async listByProject(
      projectId: string,
      opts?: { page?: number; perPage?: number; environment?: string },
    ) {
      const page = opts?.page ?? 1;
      const perPage = opts?.perPage ?? 20;
      const offset = (page - 1) * perPage;

      const conditions = [eq(deployment.projectId, projectId)];
      if (opts?.environment) {
        conditions.push(eq(deployment.environment, opts.environment));
      }

      const rows = await db.query.deployment.findMany({
        where: and(...conditions),
        orderBy: [desc(deployment.createdAt)],
        limit: perPage,
        offset,
      });

      const [{ value: total }] = await db
        .select({ value: sql<number>`count(*)` })
        .from(deployment)
        .where(and(...conditions));

      return { rows, total: Number(total), page, perPage };
    },

    // listByUser removed — use listByOrganization. deployment.user_id
    // is gone; access is org-only.

    /** Org-scoped list — every deployment for the active org. */
    async listByOrganization(
      organizationId: string,
      opts?: { page?: number; perPage?: number },
    ) {
      const page = opts?.page ?? 1;
      const perPage = opts?.perPage ?? 50;
      const offset = (page - 1) * perPage;

      const rows = await db.query.deployment.findMany({
        where: eq(deployment.organizationId, organizationId),
        orderBy: [desc(deployment.createdAt)],
        limit: perPage,
        offset,
      });

      const [{ value: total }] = await db
        .select({ value: sql<number>`count(*)` })
        .from(deployment)
        .where(eq(deployment.organizationId, organizationId));

      return { rows, total: Number(total), page, perPage };
    },

    /**
     * Deployment counts grouped by status across every non-deleted project
     * in an organization. One aggregate query — powers the dashboard home
     * stats without walking projects one by one. Joins through `project`
     * (rather than using deployment.organizationId directly) so deployments
     * of soft-deleted projects stay out of the counts, matching what the
     * org-scoped project listings show.
     */
    async countByStatusForOrganization(
      organizationId: string,
    ): Promise<Record<string, number>> {
      const rows = await db
        .select({
          status: deployment.status,
          count: sql<number>`count(*)::int`,
        })
        .from(deployment)
        .innerJoin(project, eq(deployment.projectId, project.id))
        .where(and(eq(project.organizationId, organizationId), isNull(project.deletedAt)))
        .groupBy(deployment.status);

      const out: Record<string, number> = {};
      for (const r of rows) out[r.status] = Number(r.count);
      return out;
    },

    /**
     * Insert a deployment, atomically honoring the one-active-per-project
     * partial unique index (`uq_deployment_one_active_per_project`). A bare
     * `ON CONFLICT DO NOTHING` (no target) covers that partial index: if another
     * deployment for this project is already queued/building/deploying, the
     * insert is skipped and `.returning()` yields nothing, so this returns
     * `undefined`. The DB decides the race — the caller surfaces "already in
     * progress" without inspecting error codes/messages.
     */
    async create(data: Omit<NewDeployment, "id"> & { id?: string }): Promise<Deployment | undefined> {
      // `id` is normally generated; re-import (live re-attach) passes the ORIGINAL
      // deployment id so the still-running containers (labelled `openship.deployment=<id>`)
      // stay attached and the Services-tab live query matches them.
      const { id: providedId, ...rest } = data;
      const id = providedId ?? generateId("dep");
      const [inserted] = await db
        .insert(deployment)
        .values({ id, ...rest })
        .onConflictDoNothing()
        .returning();
      return inserted as Deployment | undefined;
    },

    /**
     * Next per-project version, counting SHIPPED releases only (a version is
     * a shipped commit, not a build attempt). Assigned in onSuccess; failed and
     * in-flight deploys never consume a number. `partial_failure` counts too —
     * it is a shipped-with-asterisk release that keeps its number, so a later
     * fully-ready deploy can't be assigned a duplicate. Safe against races
     * because the one-in-flight-per-project unique index serializes deploys, so
     * at most one reaches success at a time per project.
     */
    async getNextReadyVersion(projectId: string): Promise<number> {
      const [row] = await db
        .select({ max: sql<number>`COALESCE(MAX(${deployment.version}), 0)` })
        .from(deployment)
        .where(
          and(
            eq(deployment.projectId, projectId),
            inArray(deployment.status, ["ready", "partial_failure"]),
          ),
        );
      return Number(row?.max ?? 0) + 1;
    },

    /**
     * The version already assigned to a SHIPPED deploy of this exact commit,
     * if any. Versions are per-commit: redeploying the same commit reuses its
     * number rather than burning a new one. `partial_failure` counts as shipped
     * (consistent with getNextReadyVersion).
     */
    async findReadyVersionByCommit(
      projectId: string,
      commitSha: string | null | undefined,
    ): Promise<number | null> {
      if (!commitSha) return null;
      const [row] = await db
        .select({ version: deployment.version })
        .from(deployment)
        .where(
          and(
            eq(deployment.projectId, projectId),
            eq(deployment.commitSha, commitSha),
            inArray(deployment.status, ["ready", "partial_failure"]),
            sql`${deployment.version} IS NOT NULL`,
          ),
        )
        .orderBy(desc(deployment.version))
        .limit(1);
      return row?.version ?? null;
    },

    /**
     * The most recent in-flight (queued/building/deploying) deployment for a
     * given commit, if any. Used to suppress the "new commit available" banner
     * while that commit is already being deployed.
     */
    async findInProgressByCommit(projectId: string, commitSha: string | null | undefined) {
      if (!commitSha) return undefined;
      return db.query.deployment.findFirst({
        where: and(
          eq(deployment.projectId, projectId),
          eq(deployment.commitSha, commitSha),
          inArray(deployment.status, ["queued", "building", "deploying"]),
        ),
        orderBy: [desc(deployment.createdAt)],
      });
    },

    /**
     * The most recent in-flight (queued/building/deploying) deployment for a
     * given release version — the release-source analog of
     * findInProgressByCommit. Suppresses the "new version available" banner
     * while that version is already being deployed, and dedupes the release
     * webhook against an in-flight deploy of the same tag.
     */
    async findInProgressByReleaseVersion(
      projectId: string,
      releaseVersion: string | null | undefined,
    ) {
      if (!releaseVersion) return undefined;
      return db.query.deployment.findFirst({
        where: and(
          eq(deployment.projectId, projectId),
          eq(deployment.releaseVersion, releaseVersion),
          inArray(deployment.status, ["queued", "building", "deploying"]),
        ),
        orderBy: [desc(deployment.createdAt)],
      });
    },

    async updateStatus(id: string, status: string, extra?: Partial<NewDeployment>) {
      await db
        .update(deployment)
        .set({ status, ...extra, updatedAt: new Date() })
        .where(eq(deployment.id, id));
    },

    /**
     * Flip meta.composeDeployment.decision "pending" → "superseded" for every
     * OTHER deployment of the project — a newer release makes a held keep/reject
     * moot. Atomic via jsonb_set; status left as-is (historical).
     */
    /**
     * A newer deployment supersedes any prior partial-failure that's still
     * awaiting a keep/reject decision. Such a deployment is no longer the live
     * one, so we FINALIZE it: mark `decision: "superseded"` (clears the
     * "Action Required" banner/modal — build-status derives `decisionPending`
     * from `decision === "pending"`) AND set `status: "cancelled"` so it reads
     * as a settled, not-live deployment in the list instead of lingering as
     * `partial_failure`. The compose partial detail stays in meta. Status only
     * — no container teardown; the new deploy's reconcile replaces them.
     */
    async supersedePendingDecisions(projectId: string, exceptDeploymentId: string): Promise<void> {
      await db
        .update(deployment)
        .set({
          status: "cancelled",
          errorMessage: "Superseded by a newer deployment while awaiting a keep/reject decision.",
          meta: sql`jsonb_set(${deployment.meta}, '{composeDeployment,decision}', '"superseded"'::jsonb)`,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(deployment.projectId, projectId),
            ne(deployment.id, exceptDeploymentId),
            sql`${deployment.meta}->'composeDeployment'->>'decision' = 'pending'`,
          ),
        );
    },

    /** Mark every `reconciling` deployment for a project (other than `exceptId`)
     *  as failed — a newer deploy supersedes them. Status only; no runtime
     *  teardown. Returns the number of rows affected is not needed by callers. */
    async supersedeReconciling(projectId: string, exceptId: string) {
      await db
        .update(deployment)
        .set({
          status: "failed",
          errorMessage: "Superseded by a newer deployment before verification completed.",
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(deployment.projectId, projectId),
            eq(deployment.status, "reconciling"),
            ne(deployment.id, exceptId),
          ),
        );
    },

    /**
     * Boot sweep: a deploy runs as an in-process background task driven by the
     * in-memory build session. A restart kills that session, so any deployment
     * still `queued`/`building`/`deploying` at boot is ORPHANED — nothing will
     * ever advance it, and the UI hangs on "Building" forever. Flip those (and
     * finalize their build_session, which the detail view reads for status) to a
     * terminal `cancelled` so the operator can just redeploy.
     *
     * `reconciling` is deliberately EXCLUDED — a connection-loss deploy may be
     * running fine on the host; the reconcile scheduler settles it separately.
     * Returns the number of deployments swept.
     */
    async sweepStaleInFlight(reason: string): Promise<number> {
      const swept = await db
        .update(deployment)
        .set({ status: "cancelled", errorMessage: reason, updatedAt: new Date() })
        .where(inArray(deployment.status, ["queued", "building", "deploying"]))
        .returning();

      if (swept.length > 0) {
        await db
          .update(buildSession)
          .set({ status: "cancelled", finishedAt: new Date() })
          .where(
            and(
              inArray(
                buildSession.deploymentId,
                swept.map((row) => row.id),
              ),
              isNull(buildSession.finishedAt),
            ),
          );
      }
      return swept.length;
    },

    async setContainerId(id: string, containerId: string, url?: string) {
      await db
        .update(deployment)
        .set({ containerId, url, updatedAt: new Date() })
        .where(eq(deployment.id, id));
    },

    /**
     * Persist the smart-deploy changed-files snapshot onto an existing
     * deployment row. Called by the GitHub webhook after the deployment
     * is created — the path set + truncation flag are forensic data,
     * not deploy-gating, so they're written post-hoc.
     */
    async setChangedPaths(
      id: string,
      changedPaths: string[] | null,
      changedPathsTruncated: boolean,
    ) {
      await db
        .update(deployment)
        .set({ changedPaths, changedPathsTruncated, updatedAt: new Date() })
        .where(eq(deployment.id, id));
    },

    /** Find the most recent deployment for a project (any status) */
    async findLatestByProject(projectId: string) {
      return db.query.deployment.findFirst({
        where: eq(deployment.projectId, projectId),
        orderBy: [desc(deployment.createdAt)],
      });
    },

    /**
     * Batch variant of findLatestByProject — one SQL round trip for
     * N projects. Used by getHome to eliminate the N+1.
     *
     * Strategy: fetch all rows for the project set, then pick the
     * newest per project in JS. Simpler than DISTINCT ON across
     * drivers (pg, pglite) and correct because the project filter
     * keeps the set small.
     */
    async findLatestByProjects(projectIds: string[]): Promise<Map<string, Deployment>> {
      if (projectIds.length === 0) return new Map();
      const rows = await db.query.deployment.findMany({
        where: inArray(deployment.projectId, projectIds),
        orderBy: [desc(deployment.createdAt)],
      });
      const out = new Map<string, Deployment>();
      for (const row of rows) {
        if (!out.has(row.projectId)) out.set(row.projectId, row);
      }
      return out;
    },

    /**
     * Home-dashboard counts for a set of projects: total deployments and how
     * many shipped. "Shipped" mirrors getNextReadyVersion — `ready` and
     * `partial_failure` (a shipped-with-asterisk release) both count as success.
     */
    async statsByProjects(
      projectIds: string[],
    ): Promise<{ total: number; success: number }> {
      if (projectIds.length === 0) return { total: 0, success: 0 };
      const [row] = await db
        .select({
          total: sql<number>`count(*)`,
          success: sql<number>`count(*) filter (where ${deployment.status} in ('ready', 'partial_failure'))`,
        })
        .from(deployment)
        .where(inArray(deployment.projectId, projectIds));
      return { total: Number(row?.total ?? 0), success: Number(row?.success ?? 0) };
    },

    /** Bulk lookup by id — used by enrichProject batching. */
    async findManyById(ids: string[]): Promise<Map<string, Deployment>> {
      if (ids.length === 0) return new Map();
      const rows = await db
        .select()
        .from(deployment)
        .where(inArray(deployment.id, ids));
      const out = new Map<string, Deployment>();
      for (const row of rows) out.set(row.id, row);
      return out;
    },

    /** Find the most recent successful deployment for rollback */
    async findLatestReady(projectId: string, environment: string) {
      return db.query.deployment.findFirst({
        where: and(
          eq(deployment.projectId, projectId),
          eq(deployment.environment, environment),
          eq(deployment.status, "ready"),
        ),
        orderBy: [desc(deployment.createdAt)],
      });
    },

    /**
     * Find the most recent successful deployment for a specific
     * branch on a project. Used by the smart-deploy create path to
     * populate `commit_sha_before` and by the git-strategy rollback
     * to locate the previous good commit. `"ready"` and
     * `"partial_failure"` both count as success — a partial-failure
     * deploy is still an active, restorable target for the services
     * that did come up.
     */
    async getLatestSuccessfulForBranch(projectId: string, branch: string) {
      return db.query.deployment.findFirst({
        where: and(
          eq(deployment.projectId, projectId),
          eq(deployment.branch, branch),
          inArray(deployment.status, ["ready", "partial_failure"]),
        ),
        orderBy: [desc(deployment.createdAt)],
      });
    },

    // ── Rollback / retention ───────────────────────────────────────────
    //
    // Owned by the RollbackOrchestrator. These methods are policy-free
    // — they only do the DB work. Decisions (when to archive, when to
    // purge, pin limits) live in the orchestrator.

    /** Set the timestamp marking "this deployment's artifact is archived
     *  and rollback-restorable". Pass null to mark it purged. */
    async setArtifactRetainedAt(id: string, at: Date | null) {
      await db
        .update(deployment)
        .set({ artifactRetainedAt: at, updatedAt: new Date() })
        .where(eq(deployment.id, id));
    },

    /** Toggle the user-tagged pin. The endpoint enforces the per-project
     *  pin cap before calling this; this method is unguarded. */
    async setPinned(id: string, pinned: boolean) {
      await db
        .update(deployment)
        .set({ pinned, updatedAt: new Date() })
        .where(eq(deployment.id, id));
    },

    /** Count pinned ready deployments for a project. Used by the pin
     *  endpoint to enforce maxPinnedDeployments. */
    async countPinned(projectId: string): Promise<number> {
      const [{ value }] = await db
        .select({ value: sql<number>`count(*)` })
        .from(deployment)
        .where(
          and(
            eq(deployment.projectId, projectId),
            eq(deployment.pinned, true),
          ),
        );
      return Number(value);
    },

    /** List ready deployments for a project, newest first. Used by the
     *  orchestrator's prune step to decide what falls outside the
     *  rollbackWindow. */
    async listReadyOrderedDesc(projectId: string, environment?: string) {
      const conditions = [
        eq(deployment.projectId, projectId),
        eq(deployment.status, "ready"),
      ];
      if (environment) {
        conditions.push(eq(deployment.environment, environment));
      }
      return db.query.deployment.findMany({
        where: and(...conditions),
        orderBy: [desc(deployment.createdAt)],
      });
    },

    // ── Build sessions ─────────────────────────────────────────────────

    async createBuildSession(data: Omit<NewBuildSession, "id">) {
      const id = generateId("bld");
      const row = { id, ...data };
      await db.insert(buildSession).values(row);
      return { ...row, createdAt: new Date() } as BuildSession;
    },

    async findBuildSession(id: string) {
      return db.query.buildSession.findFirst({
        where: eq(buildSession.id, id),
      });
    },

    async findBuildSessionByDeploymentId(deploymentId: string) {
      return db.query.buildSession.findFirst({
        where: eq(buildSession.deploymentId, deploymentId),
        orderBy: [desc(buildSession.createdAt)],
      });
    },

    /**
     * Total build time (ms) an org consumed in a window — sum of build-session
     * `durationMs` for the org's deployments started in [from, to]. Openship's
     * own metric (Oblien does not meter build separately). Bounded by period.
     */
    async sumBuildMillisForOrg(organizationId: string, from: Date, to: Date): Promise<number> {
      const [row] = await db
        .select({ total: sql<number>`coalesce(sum(${buildSession.durationMs}), 0)` })
        .from(buildSession)
        .innerJoin(deployment, eq(buildSession.deploymentId, deployment.id))
        .where(
          and(
            eq(deployment.organizationId, organizationId),
            gte(buildSession.startedAt, from),
            lte(buildSession.startedAt, to),
          ),
        );
      return Number(row?.total ?? 0);
    },

    async updateBuildSession(id: string, data: Partial<NewBuildSession>) {
      await db
        .update(buildSession)
        .set(data)
        .where(eq(buildSession.id, id));
    },

    async finishBuildSession(id: string, status: string, durationMs: number, logs?: unknown[]) {
      await db
        .update(buildSession)
        .set({
          status,
          durationMs,
          logs: logs as never,
          finishedAt: new Date(),
        })
        .where(eq(buildSession.id, id));
    },

    async deleteDeployment(id: string) {
      await db.delete(buildSession).where(eq(buildSession.deploymentId, id));
      await db.delete(deployment).where(eq(deployment.id, id));
    },

    async deleteByProjectId(projectId: string) {
      await db.delete(buildSession).where(eq(buildSession.projectId, projectId));
      await db.delete(deployment).where(eq(deployment.projectId, projectId));
    },
  };
}
