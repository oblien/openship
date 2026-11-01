import { and, asc, desc, eq, gt, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { AppError, generateId } from "@repo/core";
import type { Database } from "../client";
import { actionDeployment, actionProject, actionRun, actionWorkflow } from "../schema/actions";
import { project } from "../schema/project";
import { deployment } from "../schema/deployment";
import { withProjectWorkAdmission } from "./project-work-admission";
import { webhookDelivery } from "../schema/webhook-delivery";
import { settleAutomaticDeploymentDeliveries } from "./automatic-deployment-deliveries";

export type ActionDeploymentRequest = typeof actionDeployment.$inferSelect;

/** Project integration shares Actions' organization-scoped repository and durable controller. */
export function createActionProjectRepo(db: Database) {
  const requestWhere = (org: string, id: string) =>
    and(eq(actionDeployment.organizationId, org), eq(actionDeployment.id, id));
  return {
    async workflowProjects(org: string, workflowId: string) {
      return db
        .select()
        .from(actionProject)
        .where(
          and(eq(actionProject.organizationId, org), eq(actionProject.workflowId, workflowId)),
        );
    },
    async projectWorkflows(org: string, projectId: string) {
      return db
        .select({ link: actionProject, workflow: actionWorkflow })
        .from(actionProject)
        .innerJoin(
          actionWorkflow,
          and(
            eq(actionWorkflow.id, actionProject.workflowId),
            eq(actionWorkflow.organizationId, actionProject.organizationId),
          ),
        )
        .where(and(eq(actionProject.organizationId, org), eq(actionProject.projectId, projectId)));
    },
    async configureProject(
      org: string,
      projectId: string,
      input: { enabled: boolean; workflowIds: string[]; requiredWorkflowIds: string[] },
    ) {
      const saved = await withProjectWorkAdmission(db, projectId, org, async (tx) => {
        const ids = [...new Set(input.workflowIds)];
        const required = new Set(input.requiredWorkflowIds);
        if (input.requiredWorkflowIds.some((id) => !ids.includes(id)))
          throw new AppError(
            "Required workflows must be linked to this project",
            400,
            "ACTIONS_PROJECT_INVALID",
          );
        if (ids.length) {
          const workflows = await tx
            .select()
            .from(actionWorkflow)
            .where(and(eq(actionWorkflow.organizationId, org), inArray(actionWorkflow.id, ids)))
            .for("share");
          if (workflows.length !== ids.length)
            throw new AppError("Workflow not found", 404, "ACTIONS_WORKFLOW_NOT_FOUND");
          const [target] = await tx.select().from(project).where(eq(project.id, projectId));
          for (const workflow of workflows) {
            if (!required.has(workflow.id)) continue;
            if (
              !workflow.enabled ||
              !workflow.owner ||
              !workflow.repo ||
              workflow.owner.toLowerCase() !== target!.gitOwner?.toLowerCase() ||
              workflow.repo.toLowerCase() !== target!.gitRepo?.toLowerCase()
            )
              throw new AppError(
                "Required checks must be enabled workflows from this project's repository",
                400,
                "ACTIONS_PROJECT_INVALID",
              );
          }
        }
        await tx
          .delete(actionProject)
          .where(
            and(eq(actionProject.organizationId, org), eq(actionProject.projectId, projectId)),
          );
        if (ids.length)
          await tx.insert(actionProject).values(
            ids.map((workflowId) => ({
              organizationId: org,
              projectId,
              workflowId,
              required: required.has(workflowId),
            })),
          );
        await tx
          .update(project)
          .set({ autoDeploy: input.enabled, updatedAt: new Date() })
          .where(and(eq(project.id, projectId), eq(project.organizationId, org)));
        // Old approvals cannot authorize a newly edited deployment policy.
        const retired = await tx
          .update(actionDeployment)
          .set({
            status: "superseded",
            error: "Deployment automation changed. A new push or manual deployment is required.",
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(actionDeployment.organizationId, org),
              eq(actionDeployment.projectId, projectId),
              isNull(actionDeployment.deploymentId),
              inArray(actionDeployment.status, ["waiting", "blocked", "deploying"]),
            ),
          )
          .returning();
        await settleAutomaticDeploymentDeliveries(
          tx,
          org,
          projectId,
          retired.map((row) => row.id),
          "skipped",
        );
        return true;
      });
      if (!saved)
        throw new AppError("Project is unavailable for changes", 409, "PROJECT_UNAVAILABLE");
    },
    async queueActionDeployment(
      input: typeof actionDeployment.$inferInsert,
      expectedDeploymentId?: string | null,
    ) {
      return withProjectWorkAdmission(db, input.projectId, input.organizationId, async (tx) => {
        const [target] = await tx.select().from(project).where(eq(project.id, input.projectId));
        if (!target?.autoDeploy || target.disabledAt) return undefined;
        const push = input.intent.kind === "push";
        if (
          push &&
          (input.intent.repository !== `${target.gitOwner}/${target.gitRepo}`.toLowerCase() ||
            (target.gitBranch && input.ref !== `refs/heads/${target.gitBranch}`))
        )
          return undefined;
        // Source resolution may finish out of order. An older invocation cannot
        // replace a newer push that has already entered the durable queue.
        if (push && input.createdAt && input.status !== "superseded") {
          const [newer] = await tx
            .select()
            .from(actionDeployment)
            .where(
              and(
                eq(actionDeployment.projectId, input.projectId),
                isNull(actionDeployment.deploymentId),
                inArray(actionDeployment.status, ["waiting", "blocked", "deploying"]),
                gt(actionDeployment.createdAt, input.createdAt),
              ),
            )
            .limit(1);
          if (newer) return newer;
        }
        const [existing] = push
          ? []
          : await tx
              .select()
              .from(actionDeployment)
              .where(
                and(
                  eq(actionDeployment.projectId, input.projectId),
                  eq(actionDeployment.revision, input.revision),
                  sql`${actionDeployment.intent}->>'kind' IS DISTINCT FROM 'push'`,
                ),
              );
        if (existing) return existing;
        const links = await tx
          .select({ id: actionWorkflow.id, version: actionWorkflow.updatedAt })
          .from(actionProject)
          .innerJoin(actionWorkflow, eq(actionWorkflow.id, actionProject.workflowId))
          .where(
            and(
              eq(actionProject.organizationId, input.organizationId),
              eq(actionProject.projectId, input.projectId),
              eq(actionProject.required, true),
            ),
          )
          .for("share");
        const requirements = Object.fromEntries(
          links.map((row) => [row.id, row.version.toISOString()]),
        );
        if (!push && !links.length) return undefined;
        if (push && links.length)
          throw new AppError(
            "Deployment automation changed. Retry the push.",
            409,
            "ACTIONS_DEPLOYMENT_CHANGED",
          );
        if (push && expectedDeploymentId !== undefined) {
          const [latest] = await tx
            .select({ id: deployment.id })
            .from(deployment)
            .where(eq(deployment.projectId, input.projectId))
            .orderBy(desc(deployment.createdAt), desc(deployment.id))
            .limit(1);
          if ((latest?.id ?? null) !== expectedDeploymentId)
            input = {
              ...input,
              status: "superseded",
              error: "A newer deployment was admitted before this push could be queued.",
            };
        }
        if (input.status !== "superseded") {
          const previous = await tx
            .update(actionDeployment)
            .set({
              status: "superseded",
              error: "A newer automatic deployment request replaced this commit.",
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(actionDeployment.projectId, input.projectId),
                isNull(actionDeployment.deploymentId),
                inArray(actionDeployment.status, ["waiting", "blocked", "deploying"]),
              ),
            )
            .returning();
          if (push && previous.some((row) => row.intent.forceAll))
            input = { ...input, intent: { ...input.intent, forceAll: true } };
          await settleAutomaticDeploymentDeliveries(
            tx,
            input.organizationId,
            input.projectId,
            previous.map((row) => row.id),
            "skipped",
          );
        }
        const saved = (
          await tx
            .insert(actionDeployment)
            .values({ ...input, requirements })
            .returning()
        )[0];
        if (push)
          await tx.insert(webhookDelivery).values({
            id: generateId("wdl"),
            organizationId: input.organizationId,
            projectId: input.projectId,
            source: "github",
            event: "push",
            authResult: "ok",
            outcome: saved.status === "superseded" ? "skipped" : "queued",
            actionRef: saved.id,
            summary: {
              repo: input.intent.repository,
              branch: input.ref.replace(/^refs\/heads\//, ""),
              commit: input.revision,
            },
          });
        return saved;
      });
    },
    async projectActionDeployments(org: string, projectId: string) {
      return db
        .select()
        .from(actionDeployment)
        .where(
          and(eq(actionDeployment.organizationId, org), eq(actionDeployment.projectId, projectId)),
        )
        .orderBy(desc(actionDeployment.createdAt))
        .limit(10);
    },
    async pendingActionDeployments(now = new Date()) {
      return db
        .select()
        .from(actionDeployment)
        .where(
          and(
            inArray(actionDeployment.status, ["waiting", "blocked", "deploying"]),
            lt(actionDeployment.retryAt, now),
            or(isNull(actionDeployment.leaseUntil), lt(actionDeployment.leaseUntil, now)),
          ),
        )
        .orderBy(asc(actionDeployment.retryAt))
        .limit(20);
    },
    async claimActionDeployment(org: string, id: string, owner: string, now = new Date()) {
      return (
        await db
          .update(actionDeployment)
          .set({ leaseOwner: owner, leaseUntil: new Date(now.getTime() + 90_000) })
          .where(
            and(
              requestWhere(org, id),
              inArray(actionDeployment.status, ["waiting", "blocked", "deploying"]),
              or(isNull(actionDeployment.leaseUntil), lt(actionDeployment.leaseUntil, now)),
            ),
          )
          .returning()
      )[0];
    },
    async renewActionDeployment(org: string, id: string, owner: string) {
      return (
        await db
          .update(actionDeployment)
          .set({ leaseUntil: new Date(Date.now() + 90_000) })
          .where(
            and(
              requestWhere(org, id),
              eq(actionDeployment.leaseOwner, owner),
              gt(actionDeployment.leaseUntil, new Date()),
            ),
          )
          .returning()
      )[0];
    },
    async updateActionDeployment(
      org: string,
      id: string,
      owner: string,
      changes: Partial<
        Pick<ActionDeploymentRequest, "status" | "error" | "deploymentId" | "retryAt">
      >,
      release = true,
    ) {
      return db.transaction(async (tx) => {
        const saved = (
          await tx
            .update(actionDeployment)
            .set({
              ...changes,
              updatedAt: new Date(),
              ...(release && { leaseOwner: null, leaseUntil: null }),
            })
            .where(
              and(
                requestWhere(org, id),
                eq(actionDeployment.leaseOwner, owner),
                gt(actionDeployment.leaseUntil, new Date()),
                inArray(actionDeployment.status, ["waiting", "blocked", "deploying"]),
              ),
            )
            .returning()
        )[0];
        if (saved && ["deployed", "superseded", "cancelled", "failed"].includes(saved.status))
          await settleAutomaticDeploymentDeliveries(
            tx,
            org,
            saved.projectId,
            [id],
            saved.status === "deployed"
              ? "dispatched"
              : saved.status === "failed"
                ? "failed"
                : "skipped",
            saved.deploymentId ?? undefined,
            saved.error,
          );
        return saved;
      });
    },
    async resetActionDeployment(
      org: string,
      projectId: string,
      id: string,
      changes: Pick<ActionDeploymentRequest, "status" | "error"> &
        Partial<Pick<ActionDeploymentRequest, "requirements" | "authority">>,
    ) {
      return withProjectWorkAdmission(db, projectId, org, async (tx) => {
        const saved = (
          await tx
            .update(actionDeployment)
            .set({
              ...changes,
              leaseOwner: null,
              leaseUntil: null,
              retryAt: new Date(),
              updatedAt: new Date(),
            })
            .where(
              and(
                requestWhere(org, id),
                eq(actionDeployment.projectId, projectId),
                isNull(actionDeployment.deploymentId),
              ),
            )
            .returning()
        )[0];
        if (saved && ["cancelled", "superseded"].includes(saved.status))
          await settleAutomaticDeploymentDeliveries(tx, org, projectId, [id], "skipped");
        return saved;
      });
    },
    async deploymentForActionRequest(org: string, requestId: string) {
      return (
        await db
          .select()
          .from(deployment)
          .where(and(eq(deployment.organizationId, org), eq(deployment.actionRequestId, requestId)))
          .limit(1)
      )[0];
    },
    async runsForActionDeployment(org: string, ids: string[], revision: string, ref: string) {
      if (!ids.length) return [];
      return db
        .selectDistinctOn([actionRun.workflowId])
        .from(actionRun)
        .where(
          and(
            eq(actionRun.organizationId, org),
            inArray(actionRun.workflowId, ids),
            eq(actionRun.revision, revision),
            eq(actionRun.ref, ref),
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
    },
    async actionDeployment(org: string, id: string) {
      return (await db.select().from(actionDeployment).where(requestWhere(org, id)).limit(1))[0];
    },
    async pendingActionDeploymentCount() {
      const rows = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(actionDeployment)
        .where(inArray(actionDeployment.status, ["waiting", "blocked", "deploying"]));
      return rows[0]?.count ?? 0;
    },
  };
}
