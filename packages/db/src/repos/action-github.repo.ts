import { and, asc, eq, exists, gt, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { createHash } from "node:crypto";
import { AppError, actionRunnerMismatch } from "@repo/core";
import type { Database } from "../client";
import {
  actionWorkflow,
  actionRun,
  actionJob,
  actionRunner,
  actionRunnerSession,
  actionCommand,
} from "../schema/actions";
import { organization } from "../schema/organization";
import { actionRunnerAllocationCount } from "./action-runner-allocation";

export type ActionRunnerSession = typeof actionRunnerSession.$inferSelect;
type Workflow = typeof actionWorkflow.$inferSelect;
type Run = typeof actionRun.$inferInsert;
type Job = typeof actionJob.$inferInsert;
export function githubActionRunId(org: string, id: string, attempt: number) {
  return `arun_${createHash("sha256").update(`github:${org}:${id}:${attempt}`).digest("hex").slice(0, 32)}`;
}
export function githubActionJobId(org: string, id: string) {
  return `ajob_${createHash("sha256").update(`github:${org}:${id}`).digest("hex").slice(0, 32)}`;
}

export function createActionGitHubRepo(db: Database) {
  const workflowWhere = (org: string, id: string) =>
    and(
      eq(actionWorkflow.organizationId, org),
      eq(actionWorkflow.id, id),
      eq(actionWorkflow.controller, "github"),
    );
  const sessionWhere = (org: string, id: string) =>
    and(eq(actionRunnerSession.organizationId, org), eq(actionRunnerSession.id, id));
  return {
    async beginGitHubCommand(value: typeof actionCommand.$inferInsert) {
      return db.transaction(async (tx) => {
        const [created] = await tx
          .insert(actionCommand)
          .values(value)
          .onConflictDoNothing()
          .returning();
        if (created) return { command: created, submit: true };
        const [command] = await tx
          .select()
          .from(actionCommand)
          .where(
            and(
              eq(actionCommand.organizationId, value.organizationId),
              eq(actionCommand.idempotencyKey, value.idempotencyKey),
            ),
          );
        if (
          !command ||
          command.workflowId !== value.workflowId ||
          command.requestHash !== value.requestHash
        )
          throw new AppError(
            "This request key was used for a different workflow command",
            409,
            "ACTIONS_REQUEST_KEY_REUSED",
          );
        return { command, submit: false };
      });
    },
    async finishGitHubCommand(
      org: string,
      id: string,
      value: Pick<
        typeof actionCommand.$inferSelect,
        "state" | "remoteRunId" | "remoteAttempt" | "error"
      >,
    ) {
      await db
        .update(actionCommand)
        .set({ ...value, updatedAt: new Date() })
        .where(
          and(
            eq(actionCommand.organizationId, org),
            eq(actionCommand.id, id),
            eq(actionCommand.state, "submitted"),
          ),
        );
    },
    async gitHubRunCommand(org: string, workflowId: string, runId: string, attempt: number) {
      return (
        await db
          .select()
          .from(actionCommand)
          .where(
            and(
              eq(actionCommand.organizationId, org),
              eq(actionCommand.workflowId, workflowId),
              eq(actionCommand.remoteRunId, runId),
              eq(actionCommand.remoteAttempt, attempt),
              eq(actionCommand.state, "accepted"),
            ),
          )
          .limit(1)
      )[0];
    },
    async pendingGitHubWorkflows(now = new Date(), limit = 25) {
      return db
        .select()
        .from(actionWorkflow)
        .where(
          and(
            eq(actionWorkflow.controller, "github"),
            or(
              eq(actionWorkflow.enabled, true),
              exists(
                db
                  .select({ id: actionRun.id })
                  .from(actionRun)
                  .where(
                    and(
                      eq(actionRun.organizationId, actionWorkflow.organizationId),
                      eq(actionRun.workflowId, actionWorkflow.id),
                      eq(actionRun.controller, "github"),
                      isNull(actionRun.settledAt),
                    ),
                  ),
              ),
            ),
            lt(actionWorkflow.syncAfter, now),
            or(isNull(actionWorkflow.syncLeaseUntil), lt(actionWorkflow.syncLeaseUntil, now)),
          ),
        )
        .orderBy(asc(actionWorkflow.syncAfter))
        .limit(limit);
    },
    async requestGitHubSync(org: string, id: string) {
      await db
        .update(actionWorkflow)
        .set({ syncAfter: new Date(0) })
        .where(workflowWhere(org, id));
    },
    async claimGitHubSync(org: string, id: string, owner: string) {
      const now = new Date();
      return (
        await db
          .update(actionWorkflow)
          .set({ syncLeaseOwner: owner, syncLeaseUntil: new Date(now.getTime() + 120_000) })
          .where(
            and(
              workflowWhere(org, id),
              or(
                isNull(actionWorkflow.syncLeaseUntil),
                lt(actionWorkflow.syncLeaseUntil, now),
                eq(actionWorkflow.syncLeaseOwner, owner),
              ),
            ),
          )
          .returning()
      )[0];
    },
    async finishGitHubSync(
      org: string,
      id: string,
      owner: string,
      error: string | null,
      delayMs = 30_000,
    ) {
      if (!error) {
        const [failed] = await db
          .select({ error: actionRunnerSession.error })
          .from(actionRunnerSession)
          .innerJoin(
            actionJob,
            and(
              eq(actionJob.id, actionRunnerSession.demandJobId),
              eq(actionJob.organizationId, org),
            ),
          )
          .where(
            and(
              eq(actionRunnerSession.organizationId, org),
              eq(actionRunnerSession.workflowId, id),
              sql`${actionRunnerSession.error} IS NOT NULL`,
              isNull(actionJob.finishedAt),
            ),
          )
          .orderBy(asc(actionRunnerSession.createdAt))
          .limit(1);
        error = failed?.error ?? null;
      }
      await db
        .update(actionWorkflow)
        .set({
          syncLeaseOwner: null,
          syncLeaseUntil: null,
          syncAfter: new Date(Date.now() + delayMs),
          lastError: error,
        })
        .where(and(workflowWhere(org, id), eq(actionWorkflow.syncLeaseOwner, owner)));
    },
    async gitHubRunHasAllocations(org: string, runId: string) {
      const [active] = await db
        .select({ id: actionRunnerSession.id })
        .from(actionRunnerSession)
        .where(
          and(
            eq(actionRunnerSession.organizationId, org),
            isNull(actionRunnerSession.cleanedAt),
            exists(
              db
                .select({ id: actionJob.id })
                .from(actionJob)
                .where(
                  and(
                    eq(actionJob.organizationId, org),
                    eq(actionJob.runId, runId),
                    or(
                      eq(actionRunnerSession.demandJobId, actionJob.id),
                      sql`${actionJob.github} ->> 'runnerName' = ${actionRunnerSession.runnerName}`,
                    ),
                  ),
                ),
            ),
          ),
        )
        .limit(1);
      return !!active;
    },
    async requestGitHubCancel(org: string, id: string) {
      await db
        .update(actionRun)
        .set({ cancelRequestedAt: new Date(), updatedAt: new Date() })
        .where(
          and(
            eq(actionRun.organizationId, org),
            eq(actionRun.id, id),
            eq(actionRun.controller, "github"),
            isNull(actionRun.finishedAt),
          ),
        );
    },
    async upsertGitHubRun(
      workflow: Workflow,
      value: Run,
      jobs: Job[],
      expectedUpdatedAt?: Date | null,
    ) {
      return db.transaction(async (tx) => {
        const [current] = await tx
          .select()
          .from(actionWorkflow)
          .where(workflowWhere(workflow.organizationId, workflow.id))
          .for("update");
        if (!current || current.updatedAt.getTime() !== workflow.updatedAt.getTime())
          throw new AppError(
            "Workflow configuration changed while GitHub was being synchronized",
            409,
            "ACTIONS_WORKFLOW_CHANGED",
          );
        if (
          !value.github ||
          value.controller !== "github" ||
          value.organizationId !== workflow.organizationId ||
          value.workflowId !== workflow.id
        )
          throw new Error("Invalid GitHub workflow mirror");
        const [prior] = await tx
          .select()
          .from(actionRun)
          .where(
            and(eq(actionRun.id, value.id), eq(actionRun.organizationId, value.organizationId)),
          );
        if (
          prior &&
          (prior.controller !== "github" ||
            prior.workflowId !== workflow.id ||
            prior.revision !== value.revision ||
            prior.github?.id !== value.github.id ||
            prior.attempt !== value.attempt)
        )
          throw new Error("GitHub run identity changed");
        // Compare the snapshot read before network I/O. A concurrent refresh
        // wins as a whole; stale job/step responses cannot overwrite it.
        if (
          expectedUpdatedAt !== undefined &&
          (prior?.updatedAt.getTime() ?? null) !== (expectedUpdatedAt?.getTime() ?? null)
        )
          return prior!;
        // Webhooks request a fresh read; neither a delayed read nor an old
        // attempt can roll a completed job back to running.
        if (
          prior?.github &&
          (prior.github.updatedAt > value.github.updatedAt ||
            (prior.finishedAt && !value.finishedAt))
        )
          return prior;
        const {
          id: _id,
          createdAt: _createdAt,
          authority: _authority,
          configuration: _configuration,
          ...changes
        } = value;
        const linkedJob = prior && !prior.configuration.sourceJob && value.configuration.sourceJob;
        const [saved] = await tx
          .insert(actionRun)
          .values(value)
          .onConflictDoUpdate({
            target: actionRun.id,
            set: {
              ...changes,
              updatedAt: new Date(),
              ...(linkedJob && {
                configuration: { ...prior!.configuration, sourceJob: linkedJob },
              }),
            },
            setWhere: and(
              eq(actionRun.organizationId, value.organizationId),
              eq(actionRun.controller, "github"),
            ),
          })
          .returning();
        if (!saved) throw new Error("GitHub run could not be synchronized");
        // GitHub completion and destination cleanup are separate facts. A
        // one-shot registration can accept another matching job, so reconcile
        // both the original demand and the runner name assigned by GitHub.
        const names = jobs.flatMap((job) =>
          job.github?.runnerName ? [job.github.runnerName] : [],
        );
        const sessions = jobs.length
          ? await tx
              .select({
                demandJobId: actionRunnerSession.demandJobId,
                runnerName: actionRunnerSession.runnerName,
                cleanedAt: actionRunnerSession.cleanedAt,
              })
              .from(actionRunnerSession)
              .where(
                and(
                  eq(actionRunnerSession.organizationId, workflow.organizationId),
                  or(
                    inArray(
                      actionRunnerSession.demandJobId,
                      jobs.map((job) => job.id),
                    ),
                    names.length ? inArray(actionRunnerSession.runnerName, names) : undefined,
                  ),
                ),
              )
          : [];
        const demandCleanup = new Map<string, Date | null>();
        const runnerCleanup = new Map<string, Date | null>();
        for (const session of sessions) {
          runnerCleanup.set(session.runnerName, session.cleanedAt);
          const priorCleanup = demandCleanup.get(session.demandJobId);
          demandCleanup.set(
            session.demandJobId,
            priorCleanup === null || session.cleanedAt === null
              ? null
              : new Date(Math.max(priorCleanup?.getTime() ?? 0, session.cleanedAt.getTime())),
          );
        }
        for (const job of jobs) {
          if (
            !job.github ||
            job.organizationId !== workflow.organizationId ||
            job.runId !== saved.id
          )
            throw new Error("Invalid GitHub job mirror");
          const cleanup = [
            demandCleanup.get(job.id),
            runnerCleanup.get(job.github.runnerName ?? ""),
          ];
          const cleanedAt =
            !job.finishedAt || cleanup.includes(null)
              ? null
              : new Date(
                  Math.max(
                    job.finishedAt.getTime(),
                    ...cleanup.map((date) => date?.getTime() ?? 0),
                  ),
                );
          const { id, createdAt, ...jobChanges } = job;
          await tx
            .insert(actionJob)
            .values({ ...job, cleanedAt })
            .onConflictDoUpdate({
              target: actionJob.id,
              set: { ...jobChanges, cleanedAt, updatedAt: new Date() },
              setWhere: and(
                eq(actionJob.organizationId, workflow.organizationId),
                eq(actionJob.runId, saved.id),
                sql`${actionJob.github} IS NOT NULL`,
                job.finishedAt ? undefined : isNull(actionJob.finishedAt),
              ),
            });
        }
        return saved;
      });
    },
    async pendingGitHubRuns(org: string, workflowId: string) {
      return db
        .select()
        .from(actionRun)
        .where(
          and(
            eq(actionRun.organizationId, org),
            eq(actionRun.workflowId, workflowId),
            eq(actionRun.controller, "github"),
            isNull(actionRun.settledAt),
          ),
        )
        .orderBy(asc(actionRun.createdAt))
        .limit(100);
    },
    async queuedGitHubJobs(limit = 50) {
      return db
        .select({ job: actionJob, run: actionRun, workflow: actionWorkflow })
        .from(actionJob)
        .innerJoin(
          actionRun,
          and(
            eq(actionJob.runId, actionRun.id),
            eq(actionJob.organizationId, actionRun.organizationId),
          ),
        )
        .innerJoin(
          actionWorkflow,
          and(
            eq(actionRun.workflowId, actionWorkflow.id),
            eq(actionRun.organizationId, actionWorkflow.organizationId),
          ),
        )
        .where(
          and(
            eq(actionRun.controller, "github"),
            eq(actionWorkflow.controller, "github"),
            eq(actionWorkflow.enabled, true),
            eq(actionJob.status, "queued"),
            isNull(actionJob.finishedAt),
            isNull(actionRun.finishedAt),
          ),
        )
        .orderBy(asc(actionJob.createdAt))
        .limit(limit);
    },
    async reserveRunnerSession(value: typeof actionRunnerSession.$inferInsert) {
      return db.transaction(async (tx) => {
        await tx
          .select({ id: organization.id })
          .from(organization)
          .where(eq(organization.id, value.organizationId))
          .for("update");
        const [workflow] = await tx
          .select()
          .from(actionWorkflow)
          .where(
            and(
              workflowWhere(value.organizationId, value.workflowId),
              eq(actionWorkflow.enabled, true),
            ),
          )
          .for("update");
        if (
          !workflow ||
          !workflow.runnerIds.includes(value.runnerId) ||
          workflow.owner !== value.repoOwner ||
          workflow.repo !== value.repoName
        )
          return;
        const [runner] = await tx
          .select()
          .from(actionRunner)
          .where(
            and(
              eq(actionRunner.organizationId, value.organizationId),
              eq(actionRunner.id, value.runnerId),
              eq(actionRunner.enabled, true),
            ),
          )
          .for("update");
        const [job] = await tx
          .select()
          .from(actionJob)
          .where(
            and(
              eq(actionJob.organizationId, value.organizationId),
              eq(actionJob.id, value.demandJobId),
              eq(actionJob.status, "queued"),
              isNull(actionJob.finishedAt),
            ),
          )
          .for("update");
        if (!job?.github || !job.spec) return;
        const [run] = await tx
          .select()
          .from(actionRun)
          .where(
            and(
              eq(actionRun.id, job.runId),
              eq(actionRun.organizationId, value.organizationId),
              eq(actionRun.workflowId, value.workflowId),
              eq(actionRun.controller, "github"),
              isNull(actionRun.finishedAt),
            ),
          );
        if (!run || !runner || actionRunnerMismatch(runner.capabilities, runner.config, job.spec))
          return;
        if (
          !runner ||
          (await actionRunnerAllocationCount(tx, value.organizationId, runner)) >=
            runner.config.maxParallel
        )
          return;
        // A provisioning failure needs explicit retry/rerun, never a paid VM loop.
        const [previous] = await tx
          .select()
          .from(actionRunnerSession)
          .where(
            and(
              eq(actionRunnerSession.organizationId, value.organizationId),
              eq(actionRunnerSession.demandJobId, value.demandJobId),
              or(
                isNull(actionRunnerSession.cleanedAt),
                sql`${actionRunnerSession.error} IS NOT NULL`,
              ),
            ),
          )
          .limit(1);
        if (previous) return;
        return (await tx.insert(actionRunnerSession).values(value).returning())[0];
      });
    },
    async runnerSessions(org?: string) {
      return db
        .select()
        .from(actionRunnerSession)
        .where(
          and(
            isNull(actionRunnerSession.cleanedAt),
            org ? eq(actionRunnerSession.organizationId, org) : undefined,
          ),
        )
        .orderBy(asc(actionRunnerSession.updatedAt))
        .limit(100);
    },
    async runnerSession(org: string, id: string) {
      return (await db.select().from(actionRunnerSession).where(sessionWhere(org, id)))[0];
    },
    async claimRunnerSession(org: string, id: string, owner: string) {
      const now = new Date();
      return (
        await db
          .update(actionRunnerSession)
          .set({ leaseOwner: owner, leaseUntil: new Date(now.getTime() + 120_000) })
          .where(
            and(
              sessionWhere(org, id),
              isNull(actionRunnerSession.cleanedAt),
              or(
                isNull(actionRunnerSession.leaseUntil),
                lt(actionRunnerSession.leaseUntil, now),
                eq(actionRunnerSession.leaseOwner, owner),
              ),
            ),
          )
          .returning()
      )[0];
    },
    async updateRunnerSession(
      org: string,
      id: string,
      owner: string,
      value: Partial<
        Pick<
          ActionRunnerSession,
          | "githubRunnerId"
          | "registration"
          | "registrationExpiresAt"
          | "directory"
          | "workerBinary"
          | "providerWorkspaceId"
          | "providerRequestedAt"
          | "workerStartedAt"
          | "lastEventSequence"
          | "state"
          | "cancelRequestedAt"
          | "finishedAt"
          | "cleanedAt"
          | "error"
        >
      >,
    ) {
      return (
        await db
          .update(actionRunnerSession)
          .set({ ...value, updatedAt: new Date() })
          .where(
            and(
              sessionWhere(org, id),
              eq(actionRunnerSession.leaseOwner, owner),
              gt(actionRunnerSession.leaseUntil, new Date()),
            ),
          )
          .returning()
      )[0];
    },
    async releaseRunnerSession(org: string, id: string, owner: string) {
      await db
        .update(actionRunnerSession)
        .set({ leaseOwner: null, leaseUntil: null, updatedAt: new Date() })
        .where(and(sessionWhere(org, id), eq(actionRunnerSession.leaseOwner, owner)));
    },
  };
}
