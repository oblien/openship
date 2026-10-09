import { and, asc, count, desc, eq, gt, inArray, isNull, lt, ne, or, sql } from "drizzle-orm";
import {
  ACTIONS_MAX_JOBS,
  ACTIONS_MAX_LOG_BYTES,
  AppError,
  actionFinished,
  actionRunnerMismatch,
  generateId,
  type ActionJobSpec,
  type ActionWorkerEvent,
} from "@repo/core";
import { isDeepStrictEqual } from "node:util";
import type { Database } from "../client";
import {
  actionDelivery,
  actionEvent,
  actionJob,
  actionRun,
  actionRunner,
  actionWorkflow,
  actionProject,
} from "../schema/actions";
import { organization } from "../schema/organization";
import { createActionProjectRepo } from "./action-project.repo";
import { withProjectWorkAdmission } from "./project-work-admission";

export type ActionRunner = typeof actionRunner.$inferSelect;
export type ActionWorkflow = typeof actionWorkflow.$inferSelect;
export type ActionRun = typeof actionRun.$inferSelect;
export type ActionJob = typeof actionJob.$inferSelect;
export type ActionDelivery = typeof actionDelivery.$inferSelect;
type NewRun = typeof actionRun.$inferInsert;
type NewWorkflow = typeof actionWorkflow.$inferInsert;
type NewRunner = typeof actionRunner.$inferInsert;

/** All public lookups include organizationId. Only the dispatcher scans across owners. */
export function createActionsRepo(db: Database) {
  const runWhere = (org: string, id: string) =>
    and(eq(actionRun.organizationId, org), eq(actionRun.id, id));
  const jobWhere = (org: string, id: string) =>
    and(eq(actionJob.organizationId, org), eq(actionJob.id, id));
  const runnerWhere = (org: string, id: string) =>
    and(eq(actionRunner.organizationId, org), eq(actionRunner.id, id));
  const workflowWhere = (org: string, id: string) =>
    and(eq(actionWorkflow.organizationId, org), eq(actionWorkflow.id, id));
  const deliveryWhere = (org: string, id: string) =>
    and(eq(actionDelivery.organizationId, org), eq(actionDelivery.id, id));
  return {
    ...createActionProjectRepo(db),
    async enqueueDelivery(
      input: Pick<
        ActionDelivery,
        "organizationId" | "workflowId" | "deliveryId" | "eventName" | "payload"
      >,
    ) {
      await db
        .insert(actionDelivery)
        .values({ ...input, id: generateId("adel") })
        .onConflictDoNothing();
    },
    async pendingDeliveries(now = new Date(), limit = 20) {
      return db
        .select()
        .from(actionDelivery)
        .where(
          and(
            isNull(actionDelivery.finishedAt),
            lt(actionDelivery.retryAt, now),
            or(isNull(actionDelivery.leaseUntil), lt(actionDelivery.leaseUntil, now)),
          ),
        )
        .orderBy(asc(actionDelivery.retryAt))
        .limit(limit);
    },
    async claimDelivery(org: string, id: string, owner: string, now = new Date()) {
      return (
        await db
          .update(actionDelivery)
          .set({
            leaseOwner: owner,
            leaseUntil: new Date(now.getTime() + 90_000),
            attempts: sql`${actionDelivery.attempts} + 1`,
          })
          .where(
            and(
              deliveryWhere(org, id),
              isNull(actionDelivery.finishedAt),
              lt(actionDelivery.retryAt, now),
              or(isNull(actionDelivery.leaseUntil), lt(actionDelivery.leaseUntil, now)),
            ),
          )
          .returning()
      )[0];
    },
    async renewDelivery(org: string, id: string, owner: string) {
      return (
        await db
          .update(actionDelivery)
          .set({ leaseUntil: new Date(Date.now() + 90_000) })
          .where(
            and(
              deliveryWhere(org, id),
              eq(actionDelivery.leaseOwner, owner),
              gt(actionDelivery.leaseUntil, new Date()),
              isNull(actionDelivery.finishedAt),
            ),
          )
          .returning()
      )[0];
    },
    async finishDelivery(
      org: string,
      id: string,
      owner: string,
      error: string | null,
      retryAt?: Date,
    ) {
      await db
        .update(actionDelivery)
        .set({
          error,
          retryAt,
          leaseOwner: null,
          leaseUntil: null,
          ...(!retryAt && { finishedAt: new Date(), payload: {} }),
        })
        .where(
          and(
            deliveryWhere(org, id),
            eq(actionDelivery.leaseOwner, owner),
            gt(actionDelivery.leaseUntil, new Date()),
          ),
        );
    },
    async pruneDeliveries(cutoff: Date) {
      await db.delete(actionDelivery).where(lt(actionDelivery.finishedAt, cutoff));
    },
    /** Small batches; never remove active work, retained objects or a retry's parent. */
    async pruneRuns(cutoff: Date) {
      await db.execute(sql`DELETE FROM action_run WHERE id IN (
        SELECT r.id FROM action_run r WHERE r.settled_at < ${cutoff}
        AND NOT EXISTS (SELECT 1 FROM action_storage_object s WHERE s.run_id = r.id)
        AND NOT EXISTS (SELECT 1 FROM action_run retry WHERE retry.original_run_id = r.id)
        AND NOT EXISTS (SELECT 1 FROM action_deployment d WHERE d.organization_id = r.organization_id
          AND d.revision = r.revision AND d.ref = r.ref AND d.requirements ? r.workflow_id
          AND d.status IN ('waiting', 'blocked', 'deploying'))
        ORDER BY r.settled_at LIMIT 100
      )`);
    },
    /** Operator pool reconciliation, never exposed as an unscoped public list. */
    async cloudRunners() {
      return db
        .select()
        .from(actionRunner)
        .where(sql`${actionRunner.cloudPoolId} IS NOT NULL`);
    },
    /** A controller move changes runtime URLs and signing keys. Drain first. */
    async unsettledRunCount() {
      return (
        (await db.select({ value: count() }).from(actionRun).where(isNull(actionRun.settledAt)))[0]
          ?.value ?? 0
      );
    },
    /** Job schedules use the Actions run itself as their execution history. */
    async runsForJob(org: string, key: string, limit = 50) {
      return db
        .select()
        .from(actionRun)
        .where(
          and(
            eq(actionRun.organizationId, org),
            sql`${actionRun.configuration} -> 'sourceJob' ->> 'key' = ${key}`,
          ),
        )
        .orderBy(desc(actionRun.createdAt), desc(actionRun.attempt))
        .limit(limit);
    },
    async listRunners(org: string) {
      return db
        .select()
        .from(actionRunner)
        .where(eq(actionRunner.organizationId, org))
        .orderBy(asc(actionRunner.createdAt));
    },
    async runner(org: string, id: string) {
      return (await db.select().from(actionRunner).where(runnerWhere(org, id)).limit(1))[0];
    },
    async saveRunner(value: NewRunner) {
      const { id, organizationId, createdAt, ...changes } = value;
      return db.transaction(async (tx) => {
        // Admission takes the same organization lock. A slow capability probe
        // must not let an administrator change a runner after a job reserves it.
        await tx
          .select({ id: organization.id })
          .from(organization)
          .where(eq(organization.id, organizationId))
          .for("update");
        const [current] = await tx
          .select()
          .from(actionRunner)
          .where(runnerWhere(organizationId, id))
          .for("update");
        if (
          current &&
          (current.serverId !== (value.serverId ?? null) ||
            current.cloudPoolId !== (value.cloudPoolId ?? null) ||
            current.cloudProfileId !== (value.cloudProfileId ?? null) ||
            !isDeepStrictEqual(current.config, value.config))
        ) {
          const [busy] = await tx
            .select({ id: actionJob.id })
            .from(actionJob)
            .where(
              and(
                eq(actionJob.organizationId, organizationId),
                eq(actionJob.runnerId, id),
                isNull(actionJob.cleanedAt),
              ),
            )
            .limit(1);
          if (busy)
            throw new AppError(
              "Wait for this runner's jobs to finish before changing its configuration",
              409,
              "ACTIONS_RUNNER_BUSY",
            );
        }
        const [saved] = await tx
          .insert(actionRunner)
          .values(value)
          .onConflictDoUpdate({
            target: actionRunner.id,
            set: { ...changes, updatedAt: new Date() },
            setWhere: eq(actionRunner.organizationId, organizationId),
          })
          .returning();
        if (!saved)
          throw new AppError(
            "Actions runner belongs to another organization",
            404,
            "ACTIONS_RUNNER_NOT_FOUND",
          );
        return saved;
      });
    },
    async recordRunnerProbe(
      org: string,
      id: string,
      data: Pick<ActionRunner, "capabilities" | "error" | "checkedAt">,
    ) {
      // A probe cannot replay a stale copy of configuration over a newer edit.
      return (
        await db
          .update(actionRunner)
          .set({ ...data, updatedAt: new Date() })
          .where(runnerWhere(org, id))
          .returning()
      )[0];
    },
    async disableRunner(org: string, id: string) {
      // History retains runner identity. Disabling removes it from scheduling.
      await db
        .update(actionRunner)
        .set({ enabled: false, updatedAt: new Date() })
        .where(runnerWhere(org, id));
    },
    async listWorkflows(org: string, projectId?: string) {
      return db
        .select()
        .from(actionWorkflow)
        .where(
          and(
            eq(actionWorkflow.organizationId, org),
            projectId
              ? sql`EXISTS (SELECT 1 FROM ${actionProject} WHERE ${actionProject.workflowId} = ${actionWorkflow.id} AND ${actionProject.organizationId} = ${org} AND ${actionProject.projectId} = ${projectId})`
              : undefined,
          ),
        )
        .orderBy(desc(actionWorkflow.updatedAt));
    },
    async workflow(org: string, id: string) {
      return (await db.select().from(actionWorkflow).where(workflowWhere(org, id)).limit(1))[0];
    },
    async saveWorkflow(value: NewWorkflow, projectIds?: string[], expectedProjectIds?: string[]) {
      const { id, organizationId, createdAt, nextNumber, ...changes } = value;
      const saved = await withProjectWorkAdmission(
        db,
        projectIds ? [...new Set([...projectIds, ...(expectedProjectIds ?? [])])] : undefined,
        organizationId,
        async (tx) => {
          const currentLinks = await tx
            .select()
            .from(actionProject)
            .where(
              and(
                eq(actionProject.organizationId, organizationId),
                eq(actionProject.workflowId, id),
              ),
            );
          if (
            projectIds &&
            expectedProjectIds &&
            (currentLinks.length !== expectedProjectIds.length ||
              currentLinks.some((link) => !expectedProjectIds.includes(link.projectId)))
          )
            throw new AppError(
              "Linked projects changed. Reload the workflow before saving.",
              409,
              "ACTIONS_PROJECT_LINKS_CHANGED",
            );
          if (
            projectIds &&
            currentLinks.some((link) => link.required && !projectIds.includes(link.projectId))
          )
            throw new AppError(
              "Remove this workflow from the project's required checks before unlinking it",
              409,
              "ACTIONS_WORKFLOW_REQUIRED",
            );
          const [workflow] = await tx
            .insert(actionWorkflow)
            .values(value)
            .onConflictDoUpdate({
              target: actionWorkflow.id,
              set: { ...changes, updatedAt: new Date() },
              setWhere: eq(actionWorkflow.organizationId, organizationId),
            })
            .returning();
          if (!workflow)
            throw new AppError("Workflow not found", 404, "ACTIONS_WORKFLOW_NOT_FOUND");
          if (projectIds) {
            await tx
              .delete(actionProject)
              .where(
                and(
                  eq(actionProject.organizationId, organizationId),
                  eq(actionProject.workflowId, id),
                ),
              );
            if (projectIds.length)
              await tx
                .insert(actionProject)
                .values(
                  projectIds.map((projectId) => ({
                    organizationId,
                    workflowId: id,
                    projectId,
                    required: currentLinks.some(
                      (link) => link.projectId === projectId && link.required,
                    ),
                  })),
                );
          }
          return workflow;
        },
      );
      if (!saved) throw new AppError("A linked project is unavailable", 409, "PROJECT_UNAVAILABLE");
      return saved;
    },
    async workflowError(org: string, id: string, error: string | null) {
      await db.update(actionWorkflow).set({ lastError: error }).where(workflowWhere(org, id));
    },
    async refreshDefinition(
      org: string,
      id: string,
      definition: ActionWorkflow["definition"],
      expectedUpdatedAt: Date,
    ) {
      // A webhook must not overwrite an administrator's concurrent edit.
      await db
        .update(actionWorkflow)
        .set({ definition, lastError: null })
        .where(and(workflowWhere(org, id), eq(actionWorkflow.updatedAt, expectedUpdatedAt)));
    },
    async disableWorkflow(org: string, id: string) {
      await db
        .update(actionWorkflow)
        .set({ enabled: false, updatedAt: new Date() })
        .where(workflowWhere(org, id));
    },
    /** Internal webhook/schedule lookup. The caller reauthorizes each saved delegation. */
    async matchingWorkflows(owner?: string, repo?: string) {
      return db
        .select()
        .from(actionWorkflow)
        .where(
          and(
            eq(actionWorkflow.enabled, true),
            owner ? eq(actionWorkflow.owner, owner.toLowerCase()) : undefined,
            repo ? eq(actionWorkflow.repo, repo.toLowerCase()) : undefined,
          ),
        );
    },
    async runnerBusy(org: string, id: string) {
      return !!(
        await db
          .select({ id: actionJob.id })
          .from(actionJob)
          .where(
            and(
              eq(actionJob.organizationId, org),
              eq(actionJob.runnerId, id),
              isNull(actionJob.cleanedAt),
            ),
          )
          .limit(1)
      )[0];
    },
    async runs(org: string, workflowId?: string, limit = 30, projectId?: string) {
      return db
        .select()
        .from(actionRun)
        .where(
          and(
            eq(actionRun.organizationId, org),
            workflowId ? eq(actionRun.workflowId, workflowId) : undefined,
            projectId
              ? sql`EXISTS (SELECT 1 FROM ${actionProject} WHERE ${actionProject.workflowId} = ${actionRun.workflowId} AND ${actionProject.organizationId} = ${org} AND ${actionProject.projectId} = ${projectId})`
              : undefined,
          ),
        )
        .orderBy(desc(actionRun.createdAt))
        .limit(Math.min(100, Math.max(1, limit)));
    },
    async run(org: string, id: string) {
      return (await db.select().from(actionRun).where(runWhere(org, id)).limit(1))[0];
    },
    async runByKey(org: string, key: string) {
      return (
        await db
          .select()
          .from(actionRun)
          .where(and(eq(actionRun.organizationId, org), eq(actionRun.idempotencyKey, key)))
          .limit(1)
      )[0];
    },
    async createRun(value: Omit<NewRun, "number"> & { number?: number }): Promise<ActionRun> {
      return db.transaction(async (tx) => {
        await tx
          .select({ id: organization.id })
          .from(organization)
          .where(eq(organization.id, value.organizationId))
          .for("update");
        const [workflow] = await tx
          .select()
          .from(actionWorkflow)
          .where(workflowWhere(value.organizationId, value.workflowId))
          .for("update");
        if (!workflow) throw new Error("Actions workflow was removed before the run was accepted");
        const keyWhere = and(
          eq(actionRun.organizationId, value.organizationId),
          eq(actionRun.idempotencyKey, value.idempotencyKey),
        );
        const [prior] = await tx.select().from(actionRun).where(keyWhere);
        if (prior) {
          if (prior.workflowId !== value.workflowId)
            throw new Error("Actions dispatch identity belongs to another workflow");
          return prior;
        }
        if (!workflow.enabled && !value.originalRunId)
          throw new AppError("This workflow is disabled", 409, "ACTIONS_WORKFLOW_DISABLED");
        const [pending] = await tx
          .select({ value: count() })
          .from(actionRun)
          .where(
            and(eq(actionRun.organizationId, value.organizationId), isNull(actionRun.settledAt)),
          );
        if ((pending?.value ?? 0) >= 100)
          throw new AppError(
            "This organization already has 100 active Actions runs. Finish or cancel some runs before starting more.",
            429,
            "ACTIONS_QUEUE_FULL",
          );
        let number = workflow.nextNumber;
        let attempt = 1;
        if (value.originalRunId) {
          const [original] = await tx
            .select()
            .from(actionRun)
            .where(
              and(
                runWhere(value.organizationId, value.originalRunId),
                eq(actionRun.workflowId, workflow.id),
              ),
            );
          if (!original) throw new Error("Original workflow run is unavailable");
          const [latest] = await tx
            .select({ attempt: actionRun.attempt })
            .from(actionRun)
            .where(
              and(
                eq(actionRun.organizationId, value.organizationId),
                or(eq(actionRun.id, original.id), eq(actionRun.originalRunId, original.id)),
              ),
            )
            .orderBy(desc(actionRun.attempt))
            .limit(1);
          number = original.number;
          attempt = (latest?.attempt ?? 1) + 1;
        } else {
          await tx
            .update(actionWorkflow)
            .set({ nextNumber: number + 1 })
            .where(workflowWhere(value.organizationId, value.workflowId));
        }
        const [inserted] = await tx
          .insert(actionRun)
          .values({ ...value, number, attempt })
          .onConflictDoNothing({ target: [actionRun.organizationId, actionRun.idempotencyKey] })
          .returning();
        if (inserted) return inserted;
        const [existing] = await tx.select().from(actionRun).where(keyWhere);
        return existing!;
      });
    },
    async requestCancel(org: string, id: string) {
      await db
        .update(actionRun)
        .set({ cancelRequestedAt: new Date(), status: "cancelling", updatedAt: new Date() })
        .where(and(runWhere(org, id), isNull(actionRun.finishedAt)));
    },
    async approve(org: string, id: string, userId: string) {
      await db
        .update(actionRun)
        .set({
          approvedAt: new Date(),
          approvedBy: userId,
          status: "queued",
          updatedAt: new Date(),
        })
        .where(
          and(
            runWhere(org, id),
            eq(actionRun.untrusted, true),
            isNull(actionRun.approvedAt),
            isNull(actionRun.cancelRequestedAt),
            isNull(actionRun.finishedAt),
          ),
        );
    },
    async pendingRuns(limit = 50) {
      return db
        .select({ id: actionRun.id, organizationId: actionRun.organizationId })
        .from(actionRun)
        .where(
          and(
            isNull(actionRun.settledAt),
            or(isNull(actionRun.leaseUntil), lt(actionRun.leaseUntil, new Date())),
          ),
        )
        .orderBy(asc(actionRun.updatedAt), asc(actionRun.createdAt))
        .limit(limit);
    },
    async claimRun(org: string, id: string, owner: string, ttlMs = 60_000) {
      const now = new Date();
      return (
        await db
          .update(actionRun)
          .set({ leaseOwner: owner, leaseUntil: new Date(now.getTime() + ttlMs) })
          .where(
            and(
              runWhere(org, id),
              isNull(actionRun.settledAt),
              or(
                isNull(actionRun.leaseUntil),
                lt(actionRun.leaseUntil, now),
                eq(actionRun.leaseOwner, owner),
              ),
            ),
          )
          .returning()
      )[0];
    },
    async releaseRun(org: string, id: string, owner: string) {
      await db
        .update(actionRun)
        .set({ leaseOwner: null, leaseUntil: null, updatedAt: new Date() })
        .where(and(runWhere(org, id), eq(actionRun.leaseOwner, owner)));
    },
    async updateRun(
      org: string,
      id: string,
      owner: string,
      data: Partial<Pick<ActionRun, "status" | "error" | "startedAt" | "finishedAt" | "settledAt">>,
    ) {
      return (
        await db
          .update(actionRun)
          .set({ ...data, updatedAt: new Date() })
          .where(
            and(
              runWhere(org, id),
              eq(actionRun.leaseOwner, owner),
              gt(actionRun.leaseUntil, new Date()),
            ),
          )
          .returning()
      )[0];
    },
    async activateRun(org: string, id: string, owner: string): Promise<boolean> {
      return db.transaction(async (tx) => {
        // A brief tenant lock serializes concurrency groups across workflows and replicas.
        await tx
          .select({ id: organization.id })
          .from(organization)
          .where(eq(organization.id, org))
          .for("update");
        const [run] = await tx
          .select()
          .from(actionRun)
          .where(
            and(
              runWhere(org, id),
              eq(actionRun.leaseOwner, owner),
              gt(actionRun.leaseUntil, new Date()),
            ),
          )
          .for("update");
        if (!run || run.cancelRequestedAt || run.finishedAt || (run.untrusted && !run.approvedAt))
          return false;
        if (run.startedAt) return true;
        if (run.concurrencyGroup) {
          const others = await tx
            .select()
            .from(actionRun)
            .where(
              and(
                eq(actionRun.organizationId, org),
                eq(actionRun.concurrencyGroup, run.concurrencyGroup),
                ne(actionRun.id, id),
                or(
                  isNull(actionRun.finishedAt),
                  sql`EXISTS (SELECT 1 FROM ${actionJob} WHERE ${actionJob.runId} = ${actionRun.id} AND ${actionJob.cleanedAt} IS NULL)`,
                ),
              ),
            );
          if (others.some((other) => other.createdAt > run.createdAt)) {
            await tx
              .update(actionRun)
              .set({ cancelRequestedAt: new Date(), status: "cancelling" })
              .where(runWhere(org, id));
            return false;
          }
          const cancelled = others.filter(
            (other) => !other.finishedAt && (!other.startedAt || run.cancelInProgress),
          );
          if (cancelled.length)
            await tx
              .update(actionRun)
              .set({ cancelRequestedAt: new Date(), status: "cancelling" })
              .where(
                inArray(
                  actionRun.id,
                  cancelled.map((r) => r.id),
                ),
              );
          if (others.some((other) => other.startedAt)) return false;
        }
        await tx
          .update(actionRun)
          .set({ status: "running", startedAt: new Date(), updatedAt: new Date() })
          .where(runWhere(org, id));
        return true;
      });
    },
    async jobs(org: string, runId: string) {
      return db
        .select()
        .from(actionJob)
        .where(and(eq(actionJob.organizationId, org), eq(actionJob.runId, runId)))
        .orderBy(asc(actionJob.createdAt), asc(actionJob.matrixIndex));
    },
    async job(org: string, id: string) {
      return (await db.select().from(actionJob).where(jobWhere(org, id)).limit(1))[0];
    },
    async expandJobs(
      org: string,
      runId: string,
      owner: string,
      jobKey: string,
      specs: ActionJobSpec[],
      skip = false,
    ) {
      return db.transaction(async (tx) => {
        const [run] = await tx
          .select()
          .from(actionRun)
          .where(
            and(
              runWhere(org, runId),
              eq(actionRun.leaseOwner, owner),
              gt(actionRun.leaseUntil, new Date()),
            ),
          )
          .for("update");
        if (!run || run.expandedJobs.includes(jobKey)) return;
        const [total] = await tx
          .select({ value: count() })
          .from(actionJob)
          .where(eq(actionJob.runId, runId));
        if (
          (total?.value ?? 0) +
            Math.max(1, specs.length) +
            run.plan.jobs.length -
            run.expandedJobs.length -
            1 >
          ACTIONS_MAX_JOBS
        )
          throw new Error(`Workflow exceeds ${ACTIONS_MAX_JOBS} concrete jobs`);
        const values = specs.length ? specs : [null];
        await tx.insert(actionJob).values(
          values.map((spec, index) => ({
            id: generateId("ajob"),
            organizationId: org,
            runId,
            jobKey,
            matrixIndex: index,
            spec,
            status: (skip || !spec ? "skipped" : "queued") as ActionJob["status"],
            finishedAt: skip || !spec ? new Date() : null,
            cleanedAt: skip || !spec ? new Date() : null,
          })),
        );
        await tx
          .update(actionRun)
          .set({ expandedJobs: [...run.expandedJobs, jobKey] })
          .where(runWhere(org, runId));
      });
    },
    async updateJob(
      org: string,
      id: string,
      owner: string,
      changes: Partial<
        Pick<
          ActionJob,
          | "status"
          | "directory"
          | "workerBinary"
          | "providerWorkspaceId"
          | "providerRequestedAt"
          | "workerStartedAt"
          | "result"
          | "error"
          | "startedAt"
          | "finishedAt"
          | "cleanedAt"
          | "checkRunId"
          | "checkStatus"
          | "checkError"
          | "checkRetryAt"
          | "cancelRequestedAt"
        >
      >,
    ) {
      return (
        await db
          .update(actionJob)
          .set({ ...changes, updatedAt: new Date() })
          .where(
            and(
              jobWhere(org, id),
              sql`EXISTS (SELECT 1 FROM ${actionRun} WHERE ${actionRun.id} = ${actionJob.runId} AND ${actionRun.leaseOwner} = ${owner} AND ${actionRun.leaseUntil} > now())`,
            ),
          )
          .returning()
      )[0];
    },
    async startJob(org: string, id: string, owner: string) {
      return (
        await db
          .update(actionJob)
          .set({
            workerStartedAt: sql`COALESCE(${actionJob.workerStartedAt}, now())`,
            error: null,
            updatedAt: new Date(),
          })
          .where(
            and(
              jobWhere(org, id),
              isNull(actionJob.cancelRequestedAt),
              isNull(actionJob.finishedAt),
              isNull(actionJob.cleanedAt),
              sql`EXISTS (SELECT 1 FROM ${actionRun} WHERE ${actionRun.id} = ${actionJob.runId} AND ${actionRun.leaseOwner} = ${owner} AND ${actionRun.leaseUntil} > now() AND ${actionRun.cancelRequestedAt} IS NULL AND ${actionRun.finishedAt} IS NULL)`,
            ),
          )
          .returning()
      )[0];
    },
    async reserveRunner(
      org: string,
      jobId: string,
      runnerId: string,
      owner: string,
    ): Promise<boolean> {
      return db.transaction(async (tx) => {
        await tx
          .select({ id: organization.id })
          .from(organization)
          .where(eq(organization.id, org))
          .for("update");
        const [job] = await tx.select().from(actionJob).where(jobWhere(org, jobId)).for("update");
        if (!job || actionFinished(job.status) || job.cancelRequestedAt || !job.spec) return false;
        const [run] = await tx
          .select()
          .from(actionRun)
          .where(
            and(
              runWhere(org, job.runId),
              eq(actionRun.leaseOwner, owner),
              gt(actionRun.leaseUntil, new Date()),
            ),
          );
        if (!run || run.cancelRequestedAt) return false;
        if (job.runnerId) return job.runnerId === runnerId;
        const [runner] = await tx
          .select()
          .from(actionRunner)
          .where(and(runnerWhere(org, runnerId), eq(actionRunner.enabled, true)))
          .for("update");
        if (
          !runner ||
          !run.configuration.runnerIds.includes(runnerId) ||
          actionRunnerMismatch(runner.capabilities, runner.config, job.spec)
        )
          return false;
        const [allocated] = await tx
          .select({ value: count() })
          .from(actionJob)
          .innerJoin(actionRunner, eq(actionRunner.id, actionJob.runnerId))
          .where(
            and(
              eq(actionJob.organizationId, org),
              eq(actionRunner.organizationId, org),
              runner.cloudPoolId
                ? eq(actionRunner.cloudPoolId, runner.cloudPoolId)
                : eq(actionJob.runnerId, runnerId),
              isNull(actionJob.cleanedAt),
            ),
          );
        if ((allocated?.value ?? 0) >= runner.config.maxParallel) return false;
        const [siblings] = await tx
          .select({ value: count() })
          .from(actionJob)
          .where(
            and(
              eq(actionJob.runId, run.id),
              eq(actionJob.jobKey, job.jobKey),
              sql`${actionJob.runnerId} IS NOT NULL`,
              isNull(actionJob.cleanedAt),
            ),
          );
        if ((siblings?.value ?? 0) >= job.spec.maxParallel) return false;
        if (job.spec.concurrency) {
          const occupied = await tx
            .select({ id: actionJob.id })
            .from(actionJob)
            .innerJoin(actionRun, eq(actionRun.id, actionJob.runId))
            .where(
              and(
                eq(actionJob.organizationId, org),
                ne(actionJob.id, job.id),
                isNull(actionJob.cleanedAt),
                sql`${actionJob.runnerId} IS NOT NULL`,
                sql`${actionJob.spec}->'concurrency'->>'group' = ${job.spec.concurrency.group}`,
                sql`${actionRun.configuration}->>'owner' = ${run.configuration.owner}`,
                sql`${actionRun.configuration}->>'repo' = ${run.configuration.repo}`,
              ),
            );
          if (occupied.length) {
            if (job.spec.concurrency.cancelInProgress)
              await tx
                .update(actionJob)
                .set({ cancelRequestedAt: new Date() })
                .where(
                  inArray(
                    actionJob.id,
                    occupied.map((j) => j.id),
                  ),
                );
            return false;
          }
        }
        await tx
          .update(actionJob)
          .set({
            runnerId,
            status: "running",
            startedAt: new Date(),
            error: null,
            updatedAt: new Date(),
          })
          .where(jobWhere(org, jobId));
        return true;
      });
    },
    async appendEvents(org: string, jobId: string, owner: string, incoming: ActionWorkerEvent[]) {
      if (!incoming.length) return;
      await db.transaction(async (tx) => {
        const [job] = await tx.select().from(actionJob).where(jobWhere(org, jobId)).for("update");
        if (!job) return;
        const [run] = await tx
          .select({ id: actionRun.id })
          .from(actionRun)
          .where(
            and(
              runWhere(org, job.runId),
              eq(actionRun.leaseOwner, owner),
              gt(actionRun.leaseUntil, new Date()),
            ),
          );
        if (!run) return;
        let bytes = job.logBytes;
        let sequence = job.lastEventSequence;
        const values = [];
        for (const event of incoming) {
          if (event.sequence <= sequence) continue;
          sequence = event.sequence;
          const size = Buffer.byteLength(JSON.stringify(event));
          if (event.type === "log" && bytes + size > ACTIONS_MAX_LOG_BYTES) continue;
          bytes += size;
          values.push({
            id: generateId("aevt"),
            organizationId: org,
            runId: job.runId,
            jobId,
            sequence,
            event,
          });
        }
        if (values.length)
          await tx
            .insert(actionEvent)
            .values(values)
            .onConflictDoNothing({ target: [actionEvent.jobId, actionEvent.sequence] });
        await tx
          .update(actionJob)
          .set({ lastEventSequence: sequence, logBytes: bytes })
          .where(jobWhere(org, jobId));
      });
    },
    async events(org: string, jobId: string, after = 0, limit = 250) {
      return db
        .select()
        .from(actionEvent)
        .where(
          and(
            eq(actionEvent.organizationId, org),
            eq(actionEvent.jobId, jobId),
            gt(actionEvent.sequence, after),
          ),
        )
        .orderBy(asc(actionEvent.sequence))
        .limit(Math.min(limit, 500));
    },
    async jobByCheck(org: string, checkId: string) {
      return (
        await db
          .select()
          .from(actionJob)
          .where(and(eq(actionJob.organizationId, org), eq(actionJob.checkRunId, checkId)))
          .limit(1)
      )[0];
    },
  };
}
