import type { RoleContainerRef } from "@repo/core";
import { reportCaughtError as observeCaughtError, diagnostics as errorDiagnostics } from "@repo/core/diagnostics";
import { ilike, type SQL, eq, and, asc, desc, gt, gte, lte, inArray, isNotNull, isNull, ne, or, sql } from "drizzle-orm";
import { generateId, AppError, redactUrlCredentials, summarizeDeploymentHistory, DEPLOYMENT_HISTORY_STATUSES, type DeploymentHistoryQuery, type ResourceValues } from "@repo/core";
import { isDeepStrictEqual } from "node:util";
import type { Database, DatabaseTransaction } from "../connection";
import { createConfigurationSecrets, type ConfigurationEncryption } from "../configuration-secrets";
import { deployment, buildSession, project, service, cloudBuildActivity, cloudWorkspace, pullRequestPreview } from "../schema";
import { actionDeployment, actionProject, actionRun, actionWorkflow } from "../schema/actions";
import { settleAutomaticDeploymentDeliveries } from "./automatic-deployment-deliveries";
import { detailOf } from "./storable-detail";
import { reserveCloudBuildActivity, type CloudBuildResources } from "./cloud-build-activity.repo";
import { queueDeploymentChecks } from "./deployment-check.repo";
import { assertProjectConfigurationWritable, withProjectConfigurationWrite, withProjectWorkAdmission } from "./project-work-admission";

// ─── Types ───────────────────────────────────────────────────────────────────

export type Deployment = typeof deployment.$inferSelect;
export type NewDeployment = typeof deployment.$inferInsert;
export type BuildSession = typeof buildSession.$inferSelect;
export type NewBuildSession = typeof buildSession.$inferInsert;

export interface AutomaticBuildCancellation {
  organizationId: string;
  projectId: string;
  requestId: string;
  owner: string;
}

function pendingRoleHandoverCondition() {
  return and(
    isNotNull(deployment.roleHandover),
    sql`coalesce(${deployment.roleHandover}->>'phase', '') <> 'complete'`,
  );
}

export interface DeploymentRoleChanges {
  expectedActiveDeploymentId: string;
  expectedProjectUpdatedAt: Date;
  roles: import("@repo/core").StackRole[];
}

export interface DeploymentResourceChanges {
  expectedActiveDeploymentId: string;
  expectedProjectUpdatedAt: Date;
  /** Verify every sibling covered by the restart preview; write only edits. */
  services: Array<{ serviceId: string; expectedResources: unknown; expectedUpdatedAt: Date; resources?: ResourceValues }>;
}

/** A terminal outcome does not end the worker's durable execution lease. */
export function liveBuildExecutionCondition() {
  // Keep inner columns explicit: relational queries alias interpolated columns
  // to the outer deployment table.
  return sql`exists (
    select 1 from "build_session" as "active_build_session"
    where "active_build_session"."deployment_id" = ${deployment.id}
      and "active_build_session"."project_id" = ${deployment.projectId}
      and "active_build_session"."started_at" is not null
      and "active_build_session"."finished_at" is null
  )`;
}

// ─── Repository ──────────────────────────────────────────────────────────────

export function createDeploymentRepo(db: Database, encryption: ConfigurationEncryption) {
  const codec = createConfigurationSecrets(encryption);

  const cloudBuildRequestedAt = () => sql`case
    when jsonb_typeof(${deployment.meta}->'cloudBuildRequestedAt') = 'number'
      then (${deployment.meta}->>'cloudBuildRequestedAt')::numeric
    else extract(epoch from ${deployment.createdAt}) end`;
  const cloudBuildQueueCondition = (workspaceId?: string) => and(
    eq(deployment.status, "queued"), isNull(project.deletedAt), eq(project.deletionInProgress, false),
    isNotNull(project.workspaceId), sql`${deployment.meta}->>'cloudBuildRequested' = 'true'`,
    // Missing/finished sessions cannot be claimed and must not block FIFO.
    sql`exists (select 1 from ${buildSession}
      where ${buildSession.deploymentId} = ${deployment.id}
        and ${buildSession.projectId} = ${deployment.projectId}
        and ${buildSession.startedAt} is null and ${buildSession.finishedAt} is null)`,
    workspaceId ? eq(project.workspaceId, workspaceId) : undefined,
  );

  // deployment.error_message is copied from raw process output (git clone
  // failures included), which can echo a clone URL with its credential in the
  // userinfo. Redact at the write so no caller can forget it.
  function withRedactedError<T extends Partial<NewDeployment> | undefined>(extra: T): T {
    if (!extra || typeof extra.errorMessage !== "string") return extra;
    return { ...extra, errorMessage: redactUrlCredentials(extra.errorMessage) };
  }

  /** Both cancellation and activation revalidate the same current approval. */
  async function assertAutomaticApproval(
    tx: DatabaseTransaction,
    request: typeof actionDeployment.$inferSelect | undefined,
    target: typeof project.$inferSelect | undefined,
    expected: { owner?: string; revision?: string | null; branch: string },
  ) {
    if (
      !request ||
      !expected.owner ||
      request.leaseOwner !== expected.owner ||
      !request.leaseUntil ||
      request.leaseUntil <= new Date() ||
      request.status !== "deploying" ||
      request.revision !== expected.revision ||
      request.ref !== `refs/heads/${expected.branch}` ||
      !target?.autoDeploy ||
      target.disabledAt ||
      (target.gitBranch && target.gitBranch !== expected.branch)
    )
      throw new AppError(
        "The automatic deployment request changed. Review the project's Actions tab.",
        409,
        "ACTIONS_DEPLOYMENT_CHANGED",
      );
    const requirements = await tx
      .select({
        id: actionWorkflow.id,
        version: actionWorkflow.updatedAt,
        enabled: actionWorkflow.enabled,
        owner: actionWorkflow.owner,
        repo: actionWorkflow.repo,
      })
      .from(actionProject)
      .innerJoin(actionWorkflow, eq(actionWorkflow.id, actionProject.workflowId))
      .where(
        and(
          eq(actionProject.projectId, request.projectId),
          eq(actionProject.organizationId, request.organizationId),
          eq(actionProject.required, true),
        ),
      )
      .for("share");
    const plainPush = request.intent.kind === "push";
    if (
      (plainPush &&
        request.intent.repository !== `${target.gitOwner}/${target.gitRepo}`.toLowerCase()) ||
      (!plainPush && !requirements.length) ||
      requirements.length !== Object.keys(request.requirements).length ||
      requirements.some(
        (row) =>
          !row.enabled ||
          row.version.toISOString() !== request.requirements[row.id] ||
          row.owner !== target.gitOwner?.toLowerCase() ||
          row.repo !== target.gitRepo?.toLowerCase(),
      )
    )
      throw new AppError(
        "Required workflow configuration changed before deployment",
        409,
        "ACTIONS_DEPLOYMENT_CHANGED",
      );
    if (!requirements.length) return;
    const runs = await tx
      .selectDistinctOn([actionRun.workflowId])
      .from(actionRun)
      .where(
        and(
          eq(actionRun.organizationId, request.organizationId),
          inArray(
            actionRun.workflowId,
            requirements.map((row) => row.id),
          ),
          eq(actionRun.revision, request.revision),
          eq(actionRun.ref, request.ref),
          eq(actionRun.untrusted, false),
          eq(actionRun.eventName, "push"),
        ),
      )
      .orderBy(
        asc(actionRun.workflowId),
        desc(actionRun.createdAt),
        desc(actionRun.attempt),
        desc(actionRun.id),
      );
    if (
      runs.length !== requirements.length ||
      runs.some(
        (run) =>
          run.status !== "success" ||
          run.configuration.workflowVersion !== request.requirements[run.workflowId],
      )
    )
      throw new AppError(
        "Required checks have not passed for this commit",
        409,
        "ACTIONS_CHECKS_PENDING",
      );
  }

  // Pin the outcome and its clock in the same transaction. The cancel handler
  // and the worker can both finish the session later, but neither may replace
  // this duration with cleanup time or a missing build result (zero). The worker
  // lease, finishedAt, remains open until its outer finally acknowledges it.
  async function recordCancellation(
    where: SQL,
    extra?: Partial<NewDeployment>,
    automatic?: AutomaticBuildCancellation,
  ): Promise<boolean> {
    const now = new Date();
    const cancel = async (tx: DatabaseTransaction) => {
      if (automatic) {
        const [request] = await tx
          .select()
          .from(actionDeployment)
          .where(
            and(
              eq(actionDeployment.id, automatic.requestId),
              eq(actionDeployment.projectId, automatic.projectId),
              eq(actionDeployment.organizationId, automatic.organizationId),
              eq(actionDeployment.leaseOwner, automatic.owner),
              gt(actionDeployment.leaseUntil, now),
              eq(actionDeployment.status, "deploying"),
              isNull(actionDeployment.deploymentId),
            ),
          )
          .for("update");
        const [target] = await tx.select().from(project).where(eq(project.id, automatic.projectId));
        if (!request || !target?.autoDeploy || !target.autoDeployCancelBuilds || target.disabledAt)
          return false;
        try {
          await assertAutomaticApproval(tx, request, target, {
            owner: automatic.owner,
            revision: request.revision,
            branch: request.ref.replace(/^refs\/heads\//, ""),
          });
        } catch (error) {
          if (
            error instanceof AppError &&
            ["ACTIONS_DEPLOYMENT_CHANGED", "ACTIONS_CHECKS_PENDING"].includes(error.code ?? "")
          )
            return false;
          throw error;
        }
        where = and(
          where,
          eq(deployment.projectId, target.id),
          eq(deployment.organizationId, automatic.organizationId),
          eq(deployment.branch, request.ref.replace(/^refs\/heads\//, "")),
          inArray(deployment.trigger, ["webhook", "actions"]),
          inArray(deployment.status, ["queued", "building"]),
          ne(deployment.commitSha, request.revision),
        )!;
      }
      const rows = await tx
        .update(deployment)
        .set(
          codec.sealDeployment({ ...withRedactedError(extra), status: "cancelled", updatedAt: now }),
        )
        .where(and(where, sql`coalesce(${deployment.roleHandover}->>'phase', '') <> 'committing'`))
        .returning();
      if (rows.length === 0) return false;
      await tx
        .update(buildSession)
        .set({
          status: "cancelled",
          // Preserve a measured duration if this is a completed partial release
          // being superseded. Bound legacy stuck sessions to the integer column.
          durationMs: sql`coalesce(${buildSession.durationMs}, case
            when ${buildSession.startedAt} is null then 0
            else least(2147483647, greatest(0, floor(extract(epoch from
              (${now.toISOString()}::timestamp - ${buildSession.startedAt})) * 1000)))
            end)`,
        })
        .where(eq(buildSession.deploymentId, rows[0].id));
      return true;
    };
    return automatic
      ? ((await withProjectWorkAdmission(
          db,
          automatic.projectId,
          automatic.organizationId,
          cancel,
        )) ?? false)
      : db.transaction(cancel);
  }

  async function listHistory(scope: SQL, opts: DeploymentHistoryQuery = {}) {
    const page = opts.page ?? 1;
    const perPage = opts.perPage ?? 20;
    const conditions = [scope];
    if (opts.environment) conditions.push(eq(deployment.environment, opts.environment));
    const now = new Date();
    if (opts.days) {
      const since = new Date(now);
      since.setUTCHours(0, 0, 0, 0);
      since.setUTCDate(since.getUTCDate() - opts.days + 1);
      conditions.push(gte(deployment.createdAt, since), lte(deployment.createdAt, now));
    }
    const query = opts.search?.trim();
    if (query) {
      // A literal search: '%' and '_' in a commit message are not wildcards.
      const pattern = `%${query.replace(/[\\%_]/g, "\\$&")}%`;
      conditions.push(or(
        ilike(deployment.commitMessage, pattern),
        ilike(deployment.commitSha, pattern),
        ilike(sql<string>`${deployment.meta}->>'gitOwner'`, pattern),
        sql`exists (select 1 from "project" where "project"."id" = ${deployment.projectId} and "project"."name" ilike ${pattern})`,
      )!);
    }
    // Outcome facets cover the entire selected window/search, independent of
    // pagination and the status drill-down. No deployment payloads are loaded.
    let summary;
    if (opts.days) {
      const date = sql<string>`to_char(${deployment.createdAt}, 'YYYY-MM-DD')`;
      const measuredBuild = sql`${deployment.status} = 'ready' and ${deployment.buildDurationMs} > 0`;
      const buckets = await db.select({
        date, projectId: deployment.projectId, status: deployment.status,
        count: sql<number>`count(*)`,
        buildMs: sql<number>`coalesce(sum(${deployment.buildDurationMs}) filter (where ${measuredBuild}), 0)`,
        builds: sql<number>`count(*) filter (where ${measuredBuild})`,
      }).from(deployment).where(and(...conditions)).groupBy(date, deployment.projectId, deployment.status);
      summary = summarizeDeploymentHistory(buckets, opts.days, now);
    }
    if (opts.status) conditions.push(inArray(deployment.status, [...DEPLOYMENT_HISTORY_STATUSES[opts.status]]));
    const where = and(...conditions);
    const rows = (await db.query.deployment.findMany({
      where,
      orderBy: [desc(deployment.createdAt), desc(deployment.id)],
      limit: perPage,
      offset: (page - 1) * perPage,
    })).map(codec.openDeployment);
    const [{ value: total }] = await db.select({ value: sql<number>`count(*)` }).from(deployment).where(where);
    return { rows, total: Number(total), page, perPage, ...(summary ? { summary } : {}) };
  }

  return {
    // ── Deployments ────────────────────────────────────────────────────

    async findById(id: string) {
      return codec.openDeployment(await db.query.deployment.findFirst({
        where: eq(deployment.id, id),
      }));
    },

    async findCapacityAdjustment(projectId: string, organizationId: string, key: string) {
      return codec.openDeployment(await db.query.deployment.findFirst({
        where: and(eq(deployment.projectId, projectId), eq(deployment.organizationId, organizationId),
          sql`${deployment.meta} -> 'capacityAdjustment' ->> 'key' = ${key}`),
        orderBy: [desc(deployment.createdAt)],
      }));
    },

    /** Persist the first submission clock, not the draft creation clock. */
    async requestCloudBuild(deploymentId: string, organizationId: string): Promise<void> {
      await db.update(deployment).set({
        meta: sql`coalesce(${deployment.meta}, '{}'::jsonb) || jsonb_build_object(
          'cloudBuildRequested', true,
          'cloudBuildRequestedAt', case
            when ${deployment.meta}->>'cloudBuildRequested' = 'true'
              then coalesce(${deployment.meta}->'cloudBuildRequestedAt',
                to_jsonb(extract(epoch from ${deployment.createdAt})))
            else to_jsonb(extract(epoch from clock_timestamp())) end)`,
      }).where(and(eq(deployment.id, deploymentId), eq(deployment.organizationId, organizationId), eq(deployment.status, "queued")));
    },

    /** Legacy leases only. Activity-backed capacity is counted by listReservations.
     * Released activity slots must never reappear as legacy execution leases. */
    async countActiveCloudBuilds(workspaceId: string, organizationId: string): Promise<number> {
      const [row] = await db.select({ count: sql<number>`count(*)::int` }).from(buildSession)
        .innerJoin(project, eq(project.id, buildSession.projectId))
        .where(and(eq(project.workspaceId, workspaceId), eq(project.organizationId, organizationId),
          isNotNull(buildSession.startedAt), isNull(buildSession.finishedAt),
          sql`not exists (select 1 from ${cloudBuildActivity}
            where ${cloudBuildActivity.deploymentId} = ${buildSession.deploymentId})`));
      return row?.count ?? 0;
    },

    /** Recovery candidates, not proof of abandonment. The recovery caller must
     * acquire execution ownership and confirm command cleanup before closing a
     * lease. Includes terminal outcomes and deleting projects deliberately. */
    async listUnfinishedCloudBuildExecutions(limit = 100) {
      return db.select({
        deploymentId: deployment.id, buildSessionId: buildSession.id,
        projectId: project.id, organizationId: project.organizationId,
        workspaceId: sql<string>`${project.workspaceId}`,
      }).from(buildSession)
        .innerJoin(project, eq(project.id, buildSession.projectId))
        .innerJoin(deployment, and(eq(deployment.id, buildSession.deploymentId),
          eq(deployment.projectId, project.id), eq(deployment.organizationId, project.organizationId)))
        .where(and(isNotNull(project.workspaceId), isNotNull(buildSession.startedAt), isNull(buildSession.finishedAt)))
        .orderBy(asc(buildSession.startedAt), asc(buildSession.id)).limit(Math.min(100, Math.max(0, limit)));
    },

    /** FIFO within a workspace; global scans interleave workspace queues before
     * applying the strict limit so one full workspace cannot hide all others.
     * Offset pages are deterministic for an unchanged queue. Collect pages before
     * dispatching: claims/removals shift offsets. A new sweep starts at zero. */
    async listRequestedCloudBuilds(workspaceId?: string, limit = 200, offset = 0) {
      const requestedAt = cloudBuildRequestedAt();
      const rows = await db.select({ deployment }).from(deployment)
        .innerJoin(project, and(eq(project.id, deployment.projectId), eq(project.organizationId, deployment.organizationId)))
        .where(cloudBuildQueueCondition(workspaceId))
        .orderBy(...(workspaceId ? [] : [sql`row_number() over (
          partition by ${project.organizationId}, ${project.workspaceId}
          order by ${requestedAt}, ${deployment.id})`]), asc(requestedAt), asc(deployment.id)).limit(limit).offset(offset);
      return rows.map(row => codec.openDeployment(row.deployment));
    },

    /** Persist the latest wait explanation without replacing other metadata.
     * A worker claim/cancellation winning first makes this a harmless no-op. */
    async setCloudBuildQueueWait(deploymentId: string, organizationId: string, info: {
      reason: "concurrency" | "resources" | "server";
      limit: number | null;
      message: string;
    }): Promise<boolean> {
      const [row] = await db.update(deployment).set({
        meta: sql`coalesce(${deployment.meta}, '{}'::jsonb) ||
          jsonb_build_object('cloudBuildQueueReason', ${info.reason}::text,
            'cloudBuildQueue', ${JSON.stringify(info)}::jsonb)`,
      }).where(and(eq(deployment.id, deploymentId), eq(deployment.organizationId, organizationId),
        eq(deployment.status, "queued"))).returning();
      return !!row;
    },

    /** One-based FIFO position within this deployment's workspace, or null if
     * it is no longer eligible. Shares listing's clock, ties and eligibility;
     * never returns another customer's deployment or project information. */
    async getCloudBuildQueuePosition(deploymentId: string, organizationId: string): Promise<number | null> {
      const queue = db.select({
        id: deployment.id,
        position: sql<number>`row_number() over (
          partition by ${project.workspaceId}
          order by ${cloudBuildRequestedAt()}, ${deployment.id})`.mapWith(Number).as("position"),
      }).from(deployment)
        .innerJoin(project, and(eq(project.id, deployment.projectId), eq(project.organizationId, deployment.organizationId)))
        .where(and(cloudBuildQueueCondition(), eq(deployment.organizationId, organizationId)))
        .as("cloud_build_queue");
      const [row] = await db.select({ position: queue.position }).from(queue).where(eq(queue.id, deploymentId));
      return row?.position ?? null;
    },

    /** Fail a permanently rejected queue head, never a claimed worker. The
     * session lock follows claimBuildExecution's lock order; both records change
     * atomically, and a stale caller cannot overwrite cancellation or success. */
    async failUnclaimedCloudBuild(input: {
      deploymentId: string;
      buildSessionId: string;
      projectId: string;
      organizationId: string;
      errorMessage: string;
      errorCode?: string;
    }): Promise<boolean> {
      return db.transaction(async (tx) => {
        const [session] = await tx.select({ id: buildSession.id }).from(buildSession)
          .where(and(eq(buildSession.id, input.buildSessionId), eq(buildSession.deploymentId, input.deploymentId),
            eq(buildSession.projectId, input.projectId), isNull(buildSession.startedAt), isNull(buildSession.finishedAt)))
          .for("update");
        if (!session) return false;
        const now = new Date();
        const [row] = await tx.update(deployment).set({
          status: "failed", errorMessage: redactUrlCredentials(input.errorMessage),
          errorCode: input.errorCode ?? "CLOUD_BUILD_QUEUE_REJECTED", updatedAt: now,
        }).where(and(eq(deployment.id, input.deploymentId), eq(deployment.projectId, input.projectId),
          eq(deployment.organizationId, input.organizationId), eq(deployment.status, "queued"),
          sql`${deployment.meta}->>'cloudBuildRequested' = 'true'`,
          sql`not (${liveBuildExecutionCondition()})`,
        )).returning();
        if (!row) return false;
        await tx.update(buildSession).set({ status: "failed", finishedAt: now, durationMs: 0 })
          .where(eq(buildSession.id, session.id));
        return true;
      });
    },

    /** All deployments in a given status (e.g. "reconciling") — drives the
     *  reconcile sweep. Bounded to avoid pulling an unbounded history. */
    async listByStatus(status: string, limit = 200) {
      const rows = await db
        .select()
        .from(deployment)
        .where(eq(deployment.status, status))
        .orderBy(desc(deployment.createdAt))
        .limit(limit);
      return rows.map(codec.openDeployment);
    },

    async listByProject(projectId: string, opts?: DeploymentHistoryQuery) {
      return listHistory(eq(deployment.projectId, projectId), opts);
    },

    /** Exact active-work query for the project teardown safety gate.
     *
     * Status alone is not a worker-completion acknowledgement. In particular,
     * cancelling during the deploy phase pins the deployment row at
     * `cancelled`, while the async pipeline can still be provisioning on the
     * host. A claimed build session therefore remains blocking until the
     * pipeline's outermost `finally` stamps `finishedAt`.
     *
     * Filtering in SQL avoids an old queued row being pushed off a history page
     * by newer terminal/imported deployments. The partial unique index caps the
     * status side at one; the EXISTS side covers its still-running cancelled
     * worker without trusting that terminal-looking status. */
    async listInFlightByProject(projectId: string): Promise<Deployment[]> {
      return (await db.query.deployment.findMany({
        where: and(
          eq(deployment.projectId, projectId),
          or(
            inArray(deployment.status, ["queued", "building", "deploying"]),
            liveBuildExecutionCondition(),
          ),
        ),
      })).map(codec.openDeployment);
    },

    /** Deployments whose containers may still run outside the active release.
     *
     * The in-flight set above, plus `reconciling`, plus a cancelled deployment
     * that kept its provisioned containers (`meta.cancellation.keepProvisioned`)
     * even after its execution finished. Nothing retires those containers except
     * deleting that deployment or its project. Unpaged, so the project move guard
     * cannot miss one beyond a history page. */
    async listUnsettledByProject(projectId: string): Promise<Deployment[]> {
      return (
        await db.query.deployment.findMany({
          where: and(
            eq(deployment.projectId, projectId),
            or(
              inArray(deployment.status, ["queued", "building", "deploying", "reconciling"]),
              liveBuildExecutionCondition(),
              and(
                eq(deployment.status, "cancelled"),
                sql`${deployment.meta} -> 'cancellation' ->> 'keepProvisioned' = 'true'`,
              ),
            ),
          ),
        })
      ).map(codec.openDeployment);
    },

    async hasLiveBuildExecution(deploymentId: string, projectId: string): Promise<boolean> {
      const [row] = await db
        .select({ id: buildSession.id })
        .from(buildSession)
        .where(
          and(
            eq(buildSession.deploymentId, deploymentId),
            eq(buildSession.projectId, projectId),
            isNotNull(buildSession.startedAt),
            isNull(buildSession.finishedAt),
          ),
        )
        .limit(1);
      return Boolean(row);
    },

    // listByUser removed — use listByOrganization. deployment.user_id
    // is gone; access is org-only.

    /** Org-scoped list — every deployment for the active org. */
    async listByOrganization(organizationId: string, opts?: DeploymentHistoryQuery) {
      return listHistory(eq(deployment.organizationId, organizationId), { ...opts, perPage: opts?.perPage ?? 50 });
    },

    /** Options for the global history's project filter. Independent of the
     * current page/filter; also supplies row metadata without one query per row. */
    async listHistoryProjects(organizationId: string) {
      return db.selectDistinct({
        id: project.id, name: project.name,
        activeDeploymentId: project.activeDeploymentId, favicon: project.favicon,
      }).from(project).innerJoin(deployment, eq(deployment.projectId, project.id))
        .where(and(eq(project.organizationId, organizationId), eq(deployment.organizationId, organizationId)))
        .orderBy(project.name, project.id);
    },

    /**
     * Deployment counts grouped by status across every non-deleted project
     * in an organization. One aggregate query — powers the dashboard home
     * stats without walking projects one by one. Joins through `project`
     * (rather than using deployment.organizationId directly) so deployments
     * of soft-deleted projects stay out of the counts, matching what the
     * org-scoped project listings show.
     */
    async countByStatusForOrganization(organizationId: string, projectIds?: readonly string[]): Promise<Record<string, number>> {
      const rows = await db
        .select({
          status: deployment.status,
          count: sql<number>`count(*)::int`,
        })
        .from(deployment)
        .innerJoin(project, eq(deployment.projectId, project.id))
        .where(and(eq(project.organizationId, organizationId), isNull(project.deletedAt), projectIds ? inArray(project.id, [...projectIds]) : undefined))
        .groupBy(deployment.status);

      const out: Record<string, number> = {};
      for (const r of rows) out[r.status] = Number(r.count);
      return out;
    },

    /**
     * Insert a deployment only while its project is live and not being deleted.
     *
     * The project row lock is the work-start/deletion barrier: it serializes this
     * read+insert with `project.claimDeletion()`'s UPDATE. If creation wins, the
     * teardown's in-lock active-work recheck sees the queued row; if deletion wins,
     * this waits and then refuses the insert. A plain pre-read is not sufficient —
     * an enqueue racing the delete could otherwise provision after the manifest
     * snapshot and FK cascade.
     *
     * `ON CONFLICT DO NOTHING` additionally honors the one-active-per-project
     * partial unique index. In either refusal case this returns `undefined`.
     */
    async create(
      data: Omit<NewDeployment, "id"> & { id?: string },
      resourceChanges?: DeploymentResourceChanges,
      actionLeaseOwner?: string,
      roleChanges?: DeploymentRoleChanges,
      previewAdmission?: { id: string; token: string },
    ): Promise<Deployment | undefined> {
      // `id` is normally generated; re-import (live re-attach) passes the ORIGINAL
      // deployment id so the still-running containers (labelled `openship.deployment=<id>`)
      // stay attached and the Services-tab live query matches them.
      const { id: providedId, ...rest } = data;
      const id = providedId ?? generateId("dep");
      return withProjectWorkAdmission(db, rest.projectId, rest.organizationId, async (tx) => {
        const [pending] = await tx
          .select({ id: deployment.id })
          .from(deployment)
          .where(and(eq(deployment.projectId, rest.projectId), pendingRoleHandoverCondition()))
          .limit(1);
        if (pending)
          throw new AppError(
            "The previous role handover still needs recovery. Retry when the server is reachable, or review the cancelled deployment's kept containers.",
            409,
            "ROLE_HANDOVER_RECOVERY_PENDING",
          );
        if (previewAdmission) {
          const [intent] = await tx.select().from(pullRequestPreview).where(and(
            eq(pullRequestPreview.id, previewAdmission.id), eq(pullRequestPreview.leaseToken, previewAdmission.token),
            eq(pullRequestPreview.projectId, rest.projectId), eq(pullRequestPreview.organizationId, rest.organizationId),
            sql`${pullRequestPreview.leaseExpiresAt} > now()`,
          )).for("update");
          const [source] = intent ? await tx.select().from(project).where(and(eq(project.id, intent.sourceProjectId), eq(project.organizationId, rest.organizationId))).for("share") : [];
          if (!source?.previewSettings?.enabled || source.deletedAt || source.deletionInProgress)
            throw new AppError("Preview admission expired or previews were disabled", 409);
          if (intent!.headSha === rest.commitSha && intent!.deploymentId)
            throw new AppError("This preview commit already has a deployment", 409);
        }
        if (rest.trigger === "webhook" && !rest.actionRequestId) {
          const [target] = await tx.select().from(project).where(eq(project.id, rest.projectId));
          const [required] = await tx.select({ id: actionProject.workflowId }).from(actionProject)
            .where(and(eq(actionProject.projectId, rest.projectId), eq(actionProject.required, true))).limit(1);
          if (target?.autoDeploy && required)
            throw new AppError("Deployment automation changed. Refresh the project's Actions tab.", 409, "ACTIONS_DEPLOYMENT_CHANGED");
        }
        if (rest.actionRequestId) {
          const [receipt] = await tx.select().from(actionDeployment).where(and(
            eq(actionDeployment.id, rest.actionRequestId), eq(actionDeployment.projectId, rest.projectId),
            eq(actionDeployment.organizationId, rest.organizationId),
          )).for("update");
          const [target] = await tx.select().from(project).where(eq(project.id, rest.projectId));
          await assertAutomaticApproval(tx, receipt, target, {
            owner: actionLeaseOwner, revision: rest.commitSha, branch: rest.branch,
          });
        }
        // A terminal-looking deployment can still have a worker unwinding after
        // cancellation. The partial unique status index no longer covers that
        // row, so refuse its replacement until the worker's outermost finally
        // closes the build-session lease. This check shares the project row lock
        // above with deletion and every competing create.
        const [liveWorker] = await tx
          .select({ id: buildSession.id })
          .from(buildSession)
          .where(
            and(
              eq(buildSession.projectId, rest.projectId),
              isNotNull(buildSession.startedAt),
              isNull(buildSession.finishedAt),
            ),
          )
          .limit(1);
        if (liveWorker) return undefined;

        const [inserted] = await tx
          .insert(deployment)
          .values(codec.sealDeployment({ id, ...rest }))
          .onConflictDoNothing()
          .returning();
        if (inserted && previewAdmission) {
          await tx.insert(buildSession).values({ id: generateId("bs"), deploymentId: inserted.id, projectId: inserted.projectId, status: "queued" });
          await tx.update(pullRequestPreview).set({ headSha: inserted.commitSha, deploymentId: inserted.id, status: "deploying", error: null, updatedAt: new Date() })
            .where(eq(pullRequestPreview.id, previewAdmission.id));
        }
        if (inserted) await queueDeploymentChecks(tx, codec.openDeployment(inserted));
        if (inserted?.actionRequestId) await tx.update(actionDeployment).set({
          // Keep the admission retryable until kickoff is acknowledged. A crash
          // between this commit and queue submission must resume this same row.
          status: "deploying", deploymentId: inserted.id, error: null, updatedAt: new Date(),
        }).where(and(eq(actionDeployment.id, inserted.actionRequestId), eq(actionDeployment.organizationId, inserted.organizationId)));
        // A deliberate deployment also supersedes pending automatic approvals.
        // It must not be replaced later by a previously queued green commit.
        if (inserted && !inserted.actionRequestId) {
          const retired = await tx.update(actionDeployment).set({
          status: "superseded", error: "A newer deployment was started for this project.", updatedAt: new Date(),
        }).where(and(eq(actionDeployment.projectId, inserted.projectId), eq(actionDeployment.organizationId, inserted.organizationId),
          isNull(actionDeployment.deploymentId), inArray(actionDeployment.status, ["waiting", "blocked", "deploying"]))
          ).returning();
          await settleAutomaticDeploymentDeliveries(tx, inserted.organizationId, inserted.projectId,
            retired.map(row => row.id), "skipped", inserted.id);
        }
        if (inserted && roleChanges) {
          const [owner] = await tx.select().from(project).where(eq(project.id, rest.projectId));
          if (owner?.activeDeploymentId !== roleChanges.expectedActiveDeploymentId ||
              owner.updatedAt.getTime() !== roleChanges.expectedProjectUpdatedAt.getTime()) {
            throw new AppError("The active release or project changed. Reload the role settings.", 409, "ROLE_CONFIGURATION_CHANGED");
          }
          await tx.update(project).set({ roles: roleChanges.roles, updatedAt: new Date() }).where(eq(project.id, rest.projectId));
          await tx.insert(buildSession).values({ id: generateId("bld"), deploymentId: id,
            projectId: rest.projectId, status: "queued" });
        }
        if (inserted && resourceChanges) {
          const [owner] = await tx.select().from(project).where(eq(project.id, rest.projectId));
          if (owner?.activeDeploymentId !== resourceChanges.expectedActiveDeploymentId ||
              owner.updatedAt.getTime() !== resourceChanges.expectedProjectUpdatedAt.getTime()) {
            throw new AppError("The active deployment changed. Review the resource adjustment again.", 409, "CLOUD_CAPACITY_CHANGED");
          }
          // Advanced settings are encrypted as one JSON value. Open the locked
          // row and reseal only that field; JSONB path updates bypass the codec.
          const siblings = await tx.select().from(service).where(eq(service.projectId, rest.projectId))
            .orderBy(asc(service.id)).for("update");
          const expected = new Map(resourceChanges.services.map(change => [change.serviceId, change]));
          if (expected.size !== resourceChanges.services.length || siblings.length !== expected.size ||
              siblings.some(row => !expected.has(row.id))) {
            throw new AppError("The project's services changed. Review the adjustment again.", 409, "CLOUD_CAPACITY_CHANGED");
          }
          for (const row of siblings) {
            const change = expected.get(row.id)!;
            const current = codec.openService(row);
            if (!current || current.updatedAt.getTime() !== change.expectedUpdatedAt.getTime() ||
                !isDeepStrictEqual(current.advanced?.resources ?? null, change.expectedResources ?? null)) {
              throw new AppError("Service resources changed. Review the adjustment again.", 409, "CLOUD_CAPACITY_CHANGED");
            }
            if (change.resources) await tx.update(service).set(codec.sealService({
              advanced: { ...current.advanced, resources: change.resources },
              updatedAt: new Date(),
            })).where(eq(service.id, current.id));
          }
          // The saved overrides, deployment intent and queue entry commit
          // together. A failed admission cannot leave settings half-saved.
          await tx.insert(buildSession).values({ id: generateId("bld"), deploymentId: id,
            projectId: rest.projectId, status: "queued" });
        }
        return codec.openDeployment(inserted as Deployment | undefined);
      });
    },

    /**
     * Atomically admit the queued row into executable work.
     *
     * Deployment creation and kickoff are separate operations because the build
     * session is created between them. Project deletion can claim the project in
     * that gap. This second admission point closes it: it locks the same project
     * row as deletion, then claims the build session and queued deployment in one
     * transaction. Only the caller that changes `startedAt` from NULL may launch
     * the async pipeline.
     *
     * `startedAt != NULL && finishedAt == NULL` is the durable execution lease.
     * The worker clears it only by acknowledging completion from its outermost
     * finally block; changing the deployment status is deliberately insufficient.
     */
    async claimBuildExecution(input: {
      deploymentId: string;
      buildSessionId: string;
      projectId: string;
      organizationId: string;
      cloudBuildReservation?: { workspaceId: string; resources: CloudBuildResources | null; exclusivePreparation?: boolean };
    }): Promise<"claimed" | "project_unavailable" | "state_changed"> {
      const claimed = await db.transaction(async (tx) => {
        // Keep shared admission's workspace -> project -> session lock order.
        // reserveCloudBuildActivity reuses this workspace lock after viability
        // is known; failures roll back both the reservation and worker claim.
        if (input.cloudBuildReservation) {
          const [workspace] = await tx.select({ id: cloudWorkspace.id }).from(cloudWorkspace)
            .where(and(eq(cloudWorkspace.id, input.cloudBuildReservation.workspaceId),
              eq(cloudWorkspace.organizationId, input.organizationId))).for("update");
          // An absent row cannot be locked; do not acquire the project and then
          // discover a newly-created workspace in the reservation helper.
          if (!workspace) throw new AppError("Cloud build reservation requires an available local workspace",
            409, "CLOUD_BUILD_ACTIVITY_LOCAL_ONLY");
        }
        // Same project deletion barrier as withProjectWorkAdmission, after the
        // optional workspace lock rather than acquiring it in reverse order.
        const [owner] = await tx.select({ id: project.id }).from(project)
          .where(and(eq(project.id, input.projectId), eq(project.organizationId, input.organizationId),
            eq(project.deletionInProgress, false), isNull(project.deletedAt))).for("update");
        if (!owner) return undefined;
        // Lock the session before inspecting it so two idempotent kickoff
        // callers cannot both observe an unclaimed row.
        const [available] = await tx
          .select({ id: buildSession.id })
          .from(buildSession)
          .where(
            and(
              eq(buildSession.id, input.buildSessionId),
              eq(buildSession.deploymentId, input.deploymentId),
              eq(buildSession.projectId, input.projectId),
              isNull(buildSession.startedAt),
              isNull(buildSession.finishedAt),
            ),
          )
          .for("update");
        if (!available) return false;

        const [work] = await tx
          .update(deployment)
          .set({ status: "building", updatedAt: new Date() })
          .where(
            and(
              eq(deployment.id, input.deploymentId),
              eq(deployment.projectId, input.projectId),
              eq(deployment.organizationId, input.organizationId),
              inArray(deployment.status, ["queued", "building"]),
            ),
          )
          .returning();
        if (!work) return false;

        if (input.cloudBuildReservation) {
          await reserveCloudBuildActivity(tx, {
            deploymentId: input.deploymentId, projectId: input.projectId,
            organizationId: input.organizationId, workspaceId: input.cloudBuildReservation.workspaceId,
          }, input.cloudBuildReservation.resources, input.buildSessionId, input.cloudBuildReservation.exclusivePreparation);
        }

        await tx
          .update(buildSession)
          .set({ status: "building", startedAt: new Date() })
          .where(eq(buildSession.id, input.buildSessionId));
        return true;
      });
      if (claimed === undefined) return "project_unavailable";
      return claimed ? "claimed" : "state_changed";
    },

    /** Caller MUST hold this deployment's execution ownership until its old
     * worker is unregistered. On true, skip execution-completion acknowledgement:
     * this is waiting work again, not a finished worker. No host work may have
     * started. Preserve submission/FIFO and logs; only delete an untouched
     * reservation, never an activated activity or a completion tombstone. */
    async deferUnactivatedCloudBuild(input: {
      deploymentId: string;
      buildSessionId: string;
      projectId: string;
      workspaceId: string;
      organizationId: string;
    }): Promise<boolean> {
      return db.transaction(async (tx) => {
        // Same ordering as claim: workspace -> project -> session -> deployment
        // -> activity. In particular activation cannot race the reset/delete.
        const [workspace] = await tx.select({ id: cloudWorkspace.id }).from(cloudWorkspace)
          .where(and(eq(cloudWorkspace.id, input.workspaceId), eq(cloudWorkspace.organizationId, input.organizationId),
            isNull(cloudWorkspace.remote))).for("update");
        if (!workspace) return false;
        const [owner] = await tx.select({ id: project.id }).from(project)
          .where(and(eq(project.id, input.projectId), eq(project.organizationId, input.organizationId),
            eq(project.workspaceId, input.workspaceId), isNull(project.deletedAt), eq(project.deletionInProgress, false)))
          .for("update");
        if (!owner) return false;
        const [session] = await tx.select({ id: buildSession.id }).from(buildSession)
          .where(and(eq(buildSession.id, input.buildSessionId), eq(buildSession.deploymentId, input.deploymentId),
            eq(buildSession.projectId, input.projectId), eq(buildSession.status, "building"),
            isNotNull(buildSession.startedAt), isNull(buildSession.finishedAt))).for("update");
        if (!session) return false;
        const [work] = await tx.select({ id: deployment.id }).from(deployment)
          .where(and(eq(deployment.id, input.deploymentId), eq(deployment.projectId, input.projectId),
            eq(deployment.organizationId, input.organizationId), eq(deployment.status, "building"),
            sql`${deployment.meta}->>'cloudBuildRequested' = 'true'`)).for("update");
        if (!work) return false;
        const untouched = and(eq(cloudBuildActivity.deploymentId, input.deploymentId),
          eq(cloudBuildActivity.buildSessionId, input.buildSessionId), eq(cloudBuildActivity.projectId, input.projectId),
          eq(cloudBuildActivity.workspaceId, input.workspaceId), eq(cloudBuildActivity.organizationId, input.organizationId),
          isNull(cloudBuildActivity.ownerToken), isNull(cloudBuildActivity.startedAt), isNull(cloudBuildActivity.finishedAt),
          isNull(cloudBuildActivity.slotReleasedAt), isNull(cloudBuildActivity.providerWorkspaceId),
          sql`${cloudBuildActivity.commands} = '[]'::jsonb`);
        const [activity] = await tx.select({ id: cloudBuildActivity.deploymentId }).from(cloudBuildActivity)
          .where(untouched).for("update");
        if (!activity) return false;
        await tx.delete(cloudBuildActivity).where(untouched);
        await tx.update(buildSession).set({ status: "queued", startedAt: null }).where(eq(buildSession.id, session.id));
        await tx.update(deployment).set({
          status: "queued", updatedAt: new Date(),
          meta: sql`coalesce(${deployment.meta}, '{}'::jsonb) ||
            '{"cloudBuildQueueReason":"server","cloudBuildQueue":{"reason":"server","limit":null,"message":"Waiting for the managed server to become available."}}'::jsonb`,
        }).where(eq(deployment.id, work.id));
        return true;
      });
    },

    /** Cancel a queued deployment only while no worker has acquired its lease. */
    async cancelUnclaimedBuild(input: {
      deploymentId: string;
      buildSessionId: string;
      projectId: string;
    }): Promise<boolean> {
      return db.transaction(async (tx) => {
        const now = new Date();
        const [session] = await tx
          .update(buildSession)
          .set({ status: "cancelled", finishedAt: now })
          .where(
            and(
              eq(buildSession.id, input.buildSessionId),
              eq(buildSession.deploymentId, input.deploymentId),
              eq(buildSession.projectId, input.projectId),
              isNull(buildSession.startedAt),
              isNull(buildSession.finishedAt),
            ),
          )
          .returning();
        if (!session) return false;
        const [cancelled] = await tx
          .update(deployment)
          .set({ status: "cancelled", updatedAt: now })
          .where(
            and(
              eq(deployment.id, input.deploymentId),
              eq(deployment.projectId, input.projectId),
              eq(deployment.status, "queued"),
            ),
          )
          .returning();
        if (!cancelled) {
          // Throwing rolls the session update back; another state writer won.
          throw new Error("Deployment changed while cancelling an unclaimed build");
        }
        return true;
      });
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
      return codec.openDeployment(await db.query.deployment.findFirst({
        where: and(
          eq(deployment.projectId, projectId),
          eq(deployment.commitSha, commitSha),
          inArray(deployment.status, ["queued", "building", "deploying"]),
        ),
        orderBy: [desc(deployment.createdAt)],
      }));
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
      return codec.openDeployment(await db.query.deployment.findFirst({
        where: and(
          eq(deployment.projectId, projectId),
          eq(deployment.releaseVersion, releaseVersion),
          inArray(deployment.status, ["queued", "building", "deploying"]),
        ),
        orderBy: [desc(deployment.createdAt)],
      }));
    },

    /**
     * Returns false when the row was left alone because it is already
     * `cancelled`.
     *
     * A cancel is the user's last word on a deployment, but the build/deploy work
     * it interrupted keeps running for a while — cancellation is cooperative, and
     * the deploy phase doesn't check for it at all. Without this guard that
     * in-flight work reaches its own lifecycle hook and writes `ready` (or a
     * failure) over the cancellation, so the deploy the user stopped goes green.
     * Guarded HERE because every status write funnels through this one method:
     * a caller cannot forget it, and a new caller inherits it.
     *
     * `cancelled` is the only terminal state pinned this way. The others are
     * legitimately re-written (`reconciling` settles later; a partial failure is
     * superseded), and those paths don't route through here.
     */
    async updateStatus(
      id: string,
      status: string,
      extra?: Partial<NewDeployment>,
    ): Promise<boolean> {
      if (status === "cancelled") {
        return recordCancellation(and(eq(deployment.id, id), ne(deployment.status, "cancelled"))!, extra);
      }
      const rows = await db
        .update(deployment)
        .set(codec.sealDeployment({ status, ...withRedactedError(extra), updatedAt: new Date() }))
        .where(and(eq(deployment.id, id), ne(deployment.status, "cancelled")))
        .returning();
      return rows.length > 0;
    },

    /** Append a dismissal without replacing concurrent metadata or deployment status. */
    async skipPortCheck(id: string, target: number | string): Promise<void> {
      const skipped = sql`case when jsonb_typeof(${deployment.meta}->'portCheckSkipped') = 'array'
        then ${deployment.meta}->'portCheckSkipped' else '[]'::jsonb end`;
      const addition = sql`${JSON.stringify([target])}::jsonb`;
      await db
        .update(deployment)
        .set({
          meta: sql`jsonb_set(coalesce(${deployment.meta}, '{}'::jsonb), '{portCheckSkipped}', ${skipped} || ${addition})`,
          updatedAt: new Date(),
        })
        .where(and(eq(deployment.id, id), sql`not (${skipped} @> ${addition})`));
    },

    /**
     * Atomically make cancellation the terminal outcome only while the work is
     * actually in flight. A read followed by updateStatus is not sufficient:
     * the worker can become ready between those calls, and a late cancel would
     * then overwrite a successful live release and clean up its resources.
     * Conversely, once this transition wins, updateStatus's cancelled guard
     * prevents the worker from publishing ready/failure over the user's cancel.
     */
    async cancelInFlight(id: string, extra?: Partial<NewDeployment>): Promise<boolean> {
      return recordCancellation(
        and(eq(deployment.id, id), inArray(deployment.status, ["queued", "building", "deploying"]))!,
        extra,
      );
    },

    /** A leased newer request may cancel only an automatic build, before activation. */
    async cancelObsoleteAutomaticBuild(
      id: string,
      request: AutomaticBuildCancellation,
    ): Promise<boolean> {
      return recordCancellation(eq(deployment.id, id), undefined, request);
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
      const now = new Date();
      const swept = await db
        .update(deployment)
        .set({ status: "cancelled", errorMessage: reason, updatedAt: now })
        .where(
          and(
            inArray(deployment.status, ["queued", "building", "deploying"]),
            sql`coalesce(${deployment.roleHandover}->>'phase', '') <> 'committing'`,
          ),
        )
        .returning();

      if (swept.length > 0) {
        await db
          .update(buildSession)
          .set({ status: "cancelled", finishedAt: now })
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

      // A process restart is itself proof that no old in-process pipeline is
      // still executing. Close any durable lease left after the deployment row
      // had already reached a terminal status (for example: crash after
      // onSuccess, before the outermost worker finally). Preserve that recorded
      // outcome and only acknowledge execution completion here.
      await db
        .update(buildSession)
        .set({ finishedAt: now })
        .where(and(sql`${buildSession.startedAt} IS NOT NULL`, isNull(buildSession.finishedAt)));
      return swept.length;
    },

    async setContainerId(id: string, containerId: string, url?: string) {
      await db
        .update(deployment)
        .set({ containerId, url, updatedAt: new Date() })
        .where(eq(deployment.id, id));
    },

    async setRoleContainers(
      id: string,
      roleContainers: RoleContainerRef[] | null,
    ) {
      await db
        .update(deployment)
        .set({ roleContainers, updatedAt: new Date() })
        .where(eq(deployment.id, id));
    },

    /** Runtime journal updates never replace immutable config or concurrent metadata. */
    async setRoleHandover(input: {
      id: string;
      projectId: string;
      organizationId: string;
      value: Record<string, unknown>;
      roleContainers?: RoleContainerRef[];
      committing?: boolean;
      expectedRevision: number | null;
    }) {
      const [written] = await db
        .update(deployment)
        .set({
          roleHandover: input.value,
          ...(input.roleContainers ? { roleContainers: input.roleContainers } : {}),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(deployment.id, input.id),
            eq(deployment.projectId, input.projectId),
            eq(deployment.organizationId, input.organizationId),
            input.committing ? ne(deployment.status, "cancelled") : undefined,
            input.expectedRevision === null
              ? isNull(deployment.roleHandover)
              : sql`${deployment.roleHandover}->>'revision' = ${String(input.expectedRevision)}`,
          ),
        )
        .returning();
      if (!written)
        throw new AppError(
          "The deployment changed before its role handover was recorded",
          409,
          "ROLE_HANDOVER_STATE_CHANGED",
        );
    },

    async listPendingRoleHandovers(projectId?: string) {
      const rows = await db
        .select()
        .from(deployment)
        .where(
          and(
            projectId ? eq(deployment.projectId, projectId) : undefined,
            pendingRoleHandoverCondition(),
          ),
        )
        .orderBy(asc(deployment.createdAt));
      return rows.map((row) => codec.openDeployment(row)!);
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
      return codec.openDeployment(await db.query.deployment.findFirst({
        where: eq(deployment.projectId, projectId),
        orderBy: [desc(deployment.createdAt), desc(deployment.id)],
      }));
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
      const rows = (await db.query.deployment.findMany({
        where: inArray(deployment.projectId, projectIds),
        orderBy: [desc(deployment.createdAt)],
      })).map(codec.openDeployment);
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
    async statsByProjects(projectIds: string[]): Promise<{ total: number; success: number }> {
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
      const rows = await db.select().from(deployment).where(inArray(deployment.id, ids));
      const out = new Map<string, Deployment>();
      for (const row of rows) out.set(row.id, codec.openDeployment(row));
      return out;
    },

    /** Find the most recent successful deployment for rollback */
    async findLatestReady(projectId: string, environment: string) {
      return codec.openDeployment(await db.query.deployment.findFirst({
        where: and(
          eq(deployment.projectId, projectId),
          eq(deployment.environment, environment),
          eq(deployment.status, "ready"),
        ),
        orderBy: [desc(deployment.createdAt)],
      }));
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
      return codec.openDeployment(await db.query.deployment.findFirst({
        where: and(
          eq(deployment.projectId, projectId),
          eq(deployment.branch, branch),
          inArray(deployment.status, ["ready", "partial_failure"]),
        ),
        orderBy: [desc(deployment.createdAt)],
      }));
    },

    // ── Rollback / retention ───────────────────────────────────────────
    //
    // Owned by the RollbackOrchestrator. These methods are policy-free
    // — they only do the DB work. Decisions (when to archive, when to
    // purge, pin limits) live in the orchestrator.

    /** Successful/unverified releases plus artifacts still awaiting cleanup. Partial
     * releases are valid rollback targets too; omitting them leaks their badge
     * and files forever once they stop being active. */
    async listForRetention(projectId: string) {
      return (await db.query.deployment.findMany({
        where: and(
          eq(deployment.projectId, projectId),
          or(
            inArray(deployment.status, ["ready", "partial_failure", "reconciling"]),
            isNotNull(deployment.artifactRetainedAt),
            eq(deployment.pinned, true),
          ),
        ),
        orderBy: [desc(deployment.createdAt), desc(deployment.id)],
      })).map(codec.openDeployment);
    },

    /** Worker-only receipt. Merge without replacing a concurrent cancellation,
     * provider execution receipt, or encrypted deployment configuration. */
    async recordCompletedBuildArtifacts(id: string, organizationId: string, receipt: unknown): Promise<boolean> {
      const rows = await db.update(deployment).set({
        meta: sql`coalesce(${deployment.meta}, '{}'::jsonb) || jsonb_build_object('completedBuildArtifacts', ${JSON.stringify(receipt)}::jsonb)`,
        artifactRetainedAt: new Date(),
        updatedAt: new Date(),
      }).where(and(eq(deployment.id, id), eq(deployment.organizationId, organizationId),
        inArray(deployment.status, ["building", "deploying"]))).returning();
      return rows.length === 1;
    },

    /** Set the timestamp marking "this deployment's artifact is archived
     *  and rollback-restorable". Pass null to mark it purged. */
    async setArtifactRetainedAt(id: string, at: Date | null) {
      await db
        .update(deployment)
        .set({ artifactRetainedAt: at, updatedAt: new Date() })
        .where(eq(deployment.id, id));
    },

    /** Toggle the user-tagged pin. The endpoint enforces the per-project cap;
     * this write also participates in promotion's configuration fence. */
    async setPinned(id: string, pinned: boolean) {
      const predicate = inArray(project.id, db.select({ id: deployment.projectId }).from(deployment).where(eq(deployment.id, id)));
      await withProjectConfigurationWrite(db, predicate, async (tx) => tx
        .update(deployment)
        .set({ pinned, updatedAt: new Date() })
        .where(eq(deployment.id, id)));
    },

    /** Count pinned ready deployments for a project. Used by the pin
     *  endpoint to enforce MAX_PINNED_PER_PROJECT. */
    async countPinned(projectId: string): Promise<number> {
      const [{ value }] = await db
        .select({ value: sql<number>`count(*)` })
        .from(deployment)
        .where(and(eq(deployment.projectId, projectId), eq(deployment.pinned, true)));
      return Number(value);
    },

    /** List ready deployments for a project, newest first. Used by the
     *  orchestrator's prune step to decide what falls outside the
     *  rollbackWindow. */
    async listReadyOrderedDesc(projectId: string, environment?: string) {
      const conditions = [eq(deployment.projectId, projectId), eq(deployment.status, "ready")];
      if (environment) {
        conditions.push(eq(deployment.environment, environment));
      }
      return (await db.query.deployment.findMany({
        where: and(...conditions),
        orderBy: [desc(deployment.createdAt)],
      })).map(codec.openDeployment);
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
    async sumBuildMillisForOrg(organizationId: string, from: Date, to: Date, workspaceId?: string | null): Promise<number> {
      const [row] = await db
        .select({ total: sql<number>`coalesce(sum(${buildSession.durationMs}), 0)` })
        .from(buildSession)
        .innerJoin(deployment, eq(buildSession.deploymentId, deployment.id))
        .where(
          and(
            eq(deployment.organizationId, organizationId),
            gte(buildSession.startedAt, from),
            lte(buildSession.startedAt, to),
            deploymentWorkspaceScope(workspaceId),
          ),
        );
      return Number(row?.total ?? 0);
    },

    async updateBuildSession(id: string, data: Partial<NewBuildSession>) {
      await db.update(buildSession).set(data).where(eq(buildSession.id, id));
    },

    /**
     * Terminal outcome write for a build session. `status` / `durationMs` are
     * the RECORD; `logs` is observability. `finishedAt` is intentionally NOT
     * written here: it is the durable worker-completion acknowledgement and is
     * stamped only after the pipeline's outermost finally has completed.
     *
     * jsonb refuses a
     * payload containing a NUL or an unpaired surrogate, and raw build output
     * carries both — so a hostile payload sheds itself (replaced by a marker
     * naming the DB error, then dropped) rather than costing us the status
     * write. `logs` undefined means "don't touch the column": that caller has
     * no payload to shed, so its error propagates untouched.
     */
    async finishBuildSession(id: string, status: string, durationMs: number | null, logs?: unknown[]) {
      const OMIT = Symbol("omit");
      // `logs` is spread in only when there is a payload — the column is left
      // untouched by ABSENCE from the SET clause, not by an undefined value.
      const write = (payload: unknown[] | null | typeof OMIT) =>
        db
          .update(buildSession)
          .set({
            // Cancellation pins both fields atomically with the deployment
            // outcome. Late worker writes can still append their cleanup logs.
            status: sql`case when ${buildSession.status} = 'cancelled'
              then ${buildSession.status} else ${status} end`,
            durationMs: sql`case when ${buildSession.status} = 'cancelled'
              then ${buildSession.durationMs} else ${durationMs} end`,
            ...(payload === OMIT ? {} : { logs: payload as never }),
          })
          .where(eq(buildSession.id, id));

      if (logs === undefined) {
        await write(OMIT);
        return;
      }

      try {
        await write(logs);
        return;
      } catch (err) {
        // `detailOf` strips the bytes the driver error may itself carry — the
        // rejected payload's NUL/surrogate is often echoed in the message, so a
        // marker built from the RAW error would be just as unstorable as the
        // logs it replaces, and the salvage write below would fail too.
        const detail = detailOf(err);
        errorDiagnostics.error("db/repos/deployment.repo",
          `[db] build_session ${id}: log payload rejected (${detail}) — keeping status "${status}" without it`, err,
        );
        try {
          await write([
            {
              timestamp: new Date().toISOString(),
              message: `Build logs could not be stored: ${detail}`,
              level: "error",
            },
          ]);
          return;
        } catch (diagnosticFailure) {
          observeCaughtError(diagnosticFailure, "db/repos/deployment.repo");
          // Even the marker didn't land — the status still has to.
        }
        await write(null);
      }
    },

    /** Acknowledge that a claimed async pipeline has actually returned. */
    async acknowledgeBuildExecutionFinished(id: string): Promise<void> {
      await db
        .update(buildSession)
        .set({ finishedAt: new Date() })
        .where(
          and(
            eq(buildSession.id, id),
            sql`${buildSession.startedAt} IS NOT NULL`,
            isNull(buildSession.finishedAt),
          ),
        );
    },

    /**
     * Close a cancelled session that never acquired the execution lease. The
     * startedAt predicate makes this safe against a kickoff that won the race;
     * that worker must acknowledge itself from its own finally instead.
     */
    async acknowledgeUnstartedBuildSession(id: string): Promise<void> {
      await db
        .update(buildSession)
        .set({ finishedAt: new Date() })
        .where(
          and(
            eq(buildSession.id, id),
            isNull(buildSession.startedAt),
            isNull(buildSession.finishedAt),
          ),
        );
    },

    async deleteDeployment(id: string): Promise<boolean> {
      return db.transaction(async (tx) => {
        await assertProjectConfigurationWritable(tx, inArray(project.id,
          tx.select({ id: deployment.projectId }).from(deployment).where(eq(deployment.id, id))));
        const [row] = await tx
          .select({ id: deployment.id, projectId: deployment.projectId })
          .from(deployment)
          .where(eq(deployment.id, id))
          .for("update");
        if (!row) return true;

        // Do not erase the only durable proof that an async pipeline is still
        // mutating runtime state. Locking the session makes this decision atomic
        // with the worker's final acknowledgement.
        const [liveWorker] = await tx
          .select({ id: buildSession.id })
          .from(buildSession)
          .where(
            and(
              eq(buildSession.deploymentId, id),
              eq(buildSession.projectId, row.projectId),
              isNotNull(buildSession.startedAt),
              isNull(buildSession.finishedAt),
            ),
          )
          .for("update")
          .limit(1);
        if (liveWorker) return false;

        await tx.delete(buildSession).where(eq(buildSession.deploymentId, id));
        await tx.delete(deployment).where(eq(deployment.id, id));
        return true;
      });
    },

    async deleteByProjectId(projectId: string) {
      await db.delete(buildSession).where(eq(buildSession.projectId, projectId));
      await db.delete(deployment).where(eq(deployment.projectId, projectId));
    },
  };
}
import { deploymentWorkspaceScope } from "./workspace-scope";
