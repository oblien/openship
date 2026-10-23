import { and, eq, inArray } from "drizzle-orm";
import type { Database } from "../client";
import { webhookDelivery } from "../schema/webhook-delivery";

type Writer = Pick<Database, "update">;

/** Delivery history follows the durable request; it is never an execution queue. */
export async function settleAutomaticDeploymentDeliveries(
  tx: Writer,
  organizationId: string,
  projectId: string,
  requestIds: string[],
  outcome: "skipped" | "dispatched" | "failed",
  deploymentId?: string,
  error?: string | null,
) {
  if (!requestIds.length) return;
  await tx
    .update(webhookDelivery)
    .set({
      outcome,
      actionRef: deploymentId ?? null,
      error: error ?? null,
      processedAt: new Date(),
    })
    .where(
      and(
        eq(webhookDelivery.organizationId, organizationId),
        eq(webhookDelivery.projectId, projectId),
        eq(webhookDelivery.outcome, "queued"),
        inArray(webhookDelivery.actionRef, requestIds),
      ),
    );
}
