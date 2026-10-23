import { and, desc, eq, isNull, isNotNull, lte, or, sql } from "drizzle-orm";
import { AppError, generateId } from "@repo/core";
import type { AutoscaleEvent } from "@repo/core";
import type { Database, DatabaseTransaction } from "../client";
import { project, deployment, projectAutoscalePolicy, projectAutoscaleEvent } from "../schema";
import type { AutoscalePendingScale } from "../schema/project-autoscale";
import { withProjectConfigurationWrite } from "./project-work-admission";

/** Recent events per project are capped so one hot project cannot grow the
 * history unbounded; the autoscaler inserts at most one row per tick. */
const EVENTS_PER_PROJECT = 100;

export type AutoscalePolicyRecord = typeof projectAutoscalePolicy.$inferSelect;
export type AutoscaleEventRecord = typeof projectAutoscaleEvent.$inferSelect;

export interface SetAutoscalePolicyInput {
  enabled: boolean;
  targetCpuPercent: number;
  minReplicas: number;
  maxReplicas: number;
  stepSize: number;
  cooldownSeconds: number;
  suspendAfterFailures: number;
  /** Operator confirms a suspended policy should resume ownership. */
  rearm?: true;
  /** CAS precondition against the saved policy row; ignored when absent. */
  expectedUpdatedAt?: string | null;
}

const FAILURE_BACKOFF_MS = (failures: number) =>
  Math.min(60_000 * 2 ** Math.max(0, failures - 1), 30 * 60_000);

export function createAutoscaleRepo(db: Database) {
  const owned = (projectId: string) => eq(projectAutoscalePolicy.projectId, projectId);

  async function insertEvent(
    tx: DatabaseTransaction,
    projectId: string,
    event: Omit<AutoscaleEvent, "id">,
    cooldownSeconds?: number,
  ) {
    const row = { ...event, id: generateId("ase") };
    await tx.insert(projectAutoscaleEvent).values({
      ...row,
      projectId,
      createdAt: new Date(row.createdAt),
      observedCpuPercent:
        row.observedCpuPercent === null ? null : Math.round(row.observedCpuPercent),
      cooldownSeconds: cooldownSeconds ?? null,
    });
    await tx.execute(sql`
      DELETE FROM "project_autoscale_event" WHERE "project_id" = ${projectId}
      AND "id" NOT IN (SELECT "id" FROM "project_autoscale_event"
        WHERE "project_id" = ${projectId} ORDER BY "created_at" DESC, "id" DESC LIMIT ${EVENTS_PER_PROJECT})`);
    await tx.update(projectAutoscalePolicy).set({ lastDecision: row }).where(owned(projectId));
  }

  return {
    async get(projectId: string): Promise<AutoscalePolicyRecord | null> {
      const [row] = await db.select().from(projectAutoscalePolicy).where(owned(projectId));
      return row ?? null;
    },

    async listDue(): Promise<AutoscalePolicyRecord[]> {
      return db
        .select()
        .from(projectAutoscalePolicy)
        .where(
          and(
            or(
              isNotNull(projectAutoscalePolicy.pendingScale),
              and(
                eq(projectAutoscalePolicy.enabled, 1),
                isNull(projectAutoscalePolicy.suspendedAt),
              ),
            ),
            or(
              isNull(projectAutoscalePolicy.nextAttemptAt),
              lte(projectAutoscalePolicy.nextAttemptAt, new Date()),
            ),
          ),
        );
    },

    /** Only this path (operator, via the dashboard) may clear a suspension.
     *  CAS on the saved policy's updatedAt keeps two dashboard tabs from
     *  silently overwriting each other (or an operator's re-arm from landing
     *  on a policy the loop just re-suspended). */
    async save(projectId: string, input: SetAutoscalePolicyInput): Promise<AutoscalePolicyRecord> {
      return withProjectConfigurationWrite(db, eq(project.id, projectId), async (tx) => {
        const [existing] = await tx
          .select()
          .from(projectAutoscalePolicy)
          .where(owned(projectId))
          .for("update");
        if (
          input.expectedUpdatedAt !== undefined &&
          (existing?.updatedAt.toISOString() ?? null) !== input.expectedUpdatedAt
        )
          throw new AppError(
            "The autoscaling policy changed. Reload before applying these settings.",
            409,
            "AUTOSCALE_POLICY_CONFLICT",
          );
        const now = new Date(Math.max(Date.now(), (existing?.updatedAt.getTime() ?? 0) + 1));
        const rearming = !input.enabled || input.rearm === true;
        const values = {
          projectId,
          enabled: input.enabled ? 1 : 0,
          targetCpuPercent: input.targetCpuPercent,
          minReplicas: input.minReplicas,
          maxReplicas: input.maxReplicas,
          stepSize: input.stepSize,
          cooldownSeconds: input.cooldownSeconds,
          suspendAfterFailures: input.suspendAfterFailures,
          suspendedAt: rearming ? null : (existing?.suspendedAt ?? null),
          suspendedReason: rearming ? null : (existing?.suspendedReason ?? null),
          nextAttemptAt: rearming ? null : (existing?.nextAttemptAt ?? null),
          failureCount: rearming ? 0 : (existing?.failureCount ?? 0),
          lastDecision: existing?.lastDecision ?? null,
          createdAt: existing?.createdAt ?? now,
          updatedAt: now,
        };
        const [row] = await tx
          .insert(projectAutoscalePolicy)
          .values(values)
          .onConflictDoUpdate({
            target: projectAutoscalePolicy.projectId,
            set: values,
          })
          .returning();
        return row;
      });
    },

    /** The autoscaler, or an override detector, suspends ownership with a
     * reason; only `save(..., { rearm: true })` clears it afterwards. An
     * already-suspended row keeps its FIRST and most human-relevant reason. */
    async suspend(projectId: string, reason: string): Promise<void> {
      await db
        .update(projectAutoscalePolicy)
        .set({
          suspendedAt: new Date(),
          suspendedReason: reason,
          updatedAt: sql`greatest(date_trunc('milliseconds', clock_timestamp()), ${projectAutoscalePolicy.updatedAt} + interval '1 millisecond')`,
        })
        .where(
          and(
            owned(projectId),
            eq(projectAutoscalePolicy.enabled, 1),
            isNull(projectAutoscalePolicy.suspendedAt),
          ),
        );
    },

    async recordFailure(projectId: string, suspendAfterFailures: number): Promise<void> {
      await db.transaction(async (tx) => {
        const [current] = await tx
          .select()
          .from(projectAutoscalePolicy)
          .where(owned(projectId))
          .for("update");
        if (!current?.enabled || current.suspendedAt) return;
        const failureCount = current.failureCount + 1;
        const suspended = failureCount >= suspendAfterFailures;
        await tx
          .update(projectAutoscalePolicy)
          .set({
            failureCount,
            nextAttemptAt: new Date(Date.now() + FAILURE_BACKOFF_MS(failureCount)),
            ...(suspended
              ? {
                  suspendedAt: new Date(),
                  suspendedReason: `The autoscaler failed ${failureCount} times in a row. Review the cluster, then resume it.`,
                  updatedAt: new Date(Math.max(Date.now(), current.updatedAt.getTime() + 1)),
                }
              : {}),
          })
          .where(owned(projectId));
      });
    },

    async recordSuccess(projectId: string): Promise<void> {
      await db
        .update(projectAutoscalePolicy)
        .set({ failureCount: 0, nextAttemptAt: null })
        .where(
          and(
            owned(projectId),
            or(
              sql`${projectAutoscalePolicy.failureCount} > 0`,
              isNotNull(projectAutoscalePolicy.nextAttemptAt),
            ),
          ),
        );
    },

    async insertEvent(
      projectId: string,
      event: Omit<AutoscaleEvent, "id">,
      opts?: { cooldownSeconds?: number },
    ): Promise<void> {
      await db.transaction((tx) => insertEvent(tx, projectId, event, opts?.cooldownSeconds));
    },

    /** Persist before touching Kubernetes. A restart or lost response keeps the
     * same operation identity; only its matching runtime receipt can commit it. */
    async beginScale(
      projectId: string,
      expectedUpdatedAt: Date,
      pendingScale: AutoscalePendingScale,
    ): Promise<void> {
      const [row] = await db
        .update(projectAutoscalePolicy)
        .set({ pendingScale })
        .where(
          and(
            owned(projectId),
            eq(projectAutoscalePolicy.enabled, 1),
            isNull(projectAutoscalePolicy.suspendedAt),
            isNull(projectAutoscalePolicy.pendingScale),
            eq(projectAutoscalePolicy.updatedAt, expectedUpdatedAt),
          ),
        )
        .returning();
      if (!row)
        throw new AppError(
          "The autoscaling policy changed. Observe it again before scaling.",
          409,
          "AUTOSCALE_POLICY_CONFLICT",
        );
    },

    async discardScale(projectId: string): Promise<void> {
      await db
        .update(projectAutoscalePolicy)
        .set({ pendingScale: null })
        .where(and(owned(projectId), isNotNull(projectAutoscalePolicy.pendingScale)));
    },

    /** Only the replica count of the already-bound active release changes here.
     * Project intent, release snapshot, receipt and event commit together. */
    async completeScale(projectId: string, operationId: string): Promise<void> {
      await withProjectConfigurationWrite(db, eq(project.id, projectId), async (tx) => {
        const [current] = await tx.select().from(project).where(eq(project.id, projectId));
        const [policy] = await tx
          .select()
          .from(projectAutoscalePolicy)
          .where(owned(projectId))
          .for("update");
        const pending = policy?.pendingScale;
        if (!pending || pending.operationId !== operationId) return;
        if (
          !current ||
          current.deletionInProgress ||
          current.disabledAt ||
          current.activeDeploymentId !== pending.deploymentId ||
          current.clusterId !== pending.clusterId ||
          current.updatedAt.toISOString() !== pending.projectUpdatedAt ||
          current.clusterConfig?.replicas !== pending.replicas
        )
          throw new AppError(
            "The project changed while scaling. Its new configuration was preserved.",
            409,
            "CLUSTER_WORKLOAD_CONFLICT",
          );
        const [release] = await tx
          .update(deployment)
          .set({
            meta: sql`jsonb_set(${deployment.meta}, '{clusterConfig,replicas}', ${pending.toReplicas}::text::jsonb)`,
          })
          .where(
            and(
              eq(deployment.id, pending.deploymentId),
              eq(deployment.projectId, projectId),
              sql`${deployment.meta}->>'clusterId' = ${pending.clusterId}`,
              sql`${deployment.meta}->'clusterConfig'->>'replicas' = ${String(pending.replicas)}`,
            ),
          )
          .returning();
        if (!release)
          throw new AppError(
            "The active release changed while scaling.",
            409,
            "CLUSTER_WORKLOAD_CONFLICT",
          );
        await tx
          .update(project)
          .set({
            clusterConfig: { ...current.clusterConfig, replicas: pending.toReplicas },
            updatedAt: new Date(),
          })
          .where(eq(project.id, projectId));
        await insertEvent(
          tx,
          projectId,
          { ...pending.event, createdAt: new Date().toISOString() },
          pending.cooldownSeconds,
        );
        await tx
          .update(projectAutoscalePolicy)
          .set({ pendingScale: null, failureCount: 0, nextAttemptAt: null })
          .where(owned(projectId));
      });
    },

    /** The most recent applied step (up or down), for cooldown timing. Holds
     *  and failures never reset the window. */
    async lastScaleEvent(projectId: string): Promise<AutoscaleEventRecord | null> {
      const [row] = await db
        .select()
        .from(projectAutoscaleEvent)
        .where(
          and(
            eq(projectAutoscaleEvent.projectId, projectId),
            sql`${projectAutoscaleEvent.action} IN ('scale_up','scale_down')`,
          ),
        )
        .orderBy(desc(projectAutoscaleEvent.createdAt), desc(projectAutoscaleEvent.id))
        .limit(1);
      return row ?? null;
    },

    async listEvents(projectId: string): Promise<AutoscaleEventRecord[]> {
      return db
        .select()
        .from(projectAutoscaleEvent)
        .where(eq(projectAutoscaleEvent.projectId, projectId))
        .orderBy(desc(projectAutoscaleEvent.createdAt), desc(projectAutoscaleEvent.id))
        .limit(EVENTS_PER_PROJECT);
    },
  };
}

export type AutoscaleRepo = ReturnType<typeof createAutoscaleRepo>;
