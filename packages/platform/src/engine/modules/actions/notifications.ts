import { isDeepStrictEqual } from "node:util";
import { AppError, type ActionWorkflowNotifications } from "@repo/core";
import { db, repos, type ActionRun } from "@repo/db";
import type { ExecutionContext } from "../../../context";
import { authorization } from "../../lib/authorization";
import { notification, type NotificationEmitInput } from "../../lib/notification-dispatcher";
import { localDashboardUrl } from "../../config/env";

export async function validateActionNotifications(
  ctx: ExecutionContext,
  input: ActionWorkflowNotifications | null | undefined,
  previous?: ActionWorkflowNotifications | null,
): Promise<ActionWorkflowNotifications | null> {
  if (input === undefined) return previous ?? null;
  if (isDeepStrictEqual(input, previous ?? null)) return input;
  if (input?.channels.length) {
    await authorization.authorize(ctx, {
      resourceType: "notifications",
      resourceId: "*",
      action: "read",
    });
    for (const id of input.channels) {
      // A workflow editor can retain existing team destinations, but may only
      // attach their own verified channels. IDs never grant channel access.
      if (previous?.channels.includes(id)) continue;
      const channel = await repos.notificationChannel.findById(id);
      if (!channel || channel.userId !== ctx.userId)
        throw new AppError(
          "Notification channel not found",
          404,
          "ACTIONS_NOTIFICATION_CHANNEL_NOT_FOUND",
        );
      if (!channel.enabled || !channel.verified)
        throw new AppError(
          "Verify and enable the notification channel before selecting it",
          422,
          "ACTIONS_NOTIFICATION_CHANNEL_UNAVAILABLE",
        );
    }
  }
  return input;
}

/** Both controllers checkpoint completion only after this durable outbox write.
 * Retrying queues the same delivery IDs; workers perform external delivery and
 * recheck current access. No workflow commands, secrets or raw logs enter alerts. */
export async function completeActionRun(run: ActionRun, notify = true): Promise<void> {
  if (!run.finishedAt) return;
  const event = run.status === "timed_out" ? "failure" : run.status;
  const result =
    event === "failure"
      ? "failed"
      : event === "success"
        ? "succeeded"
        : event === "cancelled"
          ? "cancelled"
          : null;
  const sourceJob = run.configuration.sourceJob;
  const input: NotificationEmitInput & { idempotencyKey: string } = {
    organizationId: run.organizationId,
    idempotencyKey: `actions-completed:${run.id}`,
    eventType: `action_run.${result}`,
    resourceType: "action_run",
    resourceId: run.id,
    payload: {
      durable: true,
      runId: run.id,
      workflowName: run.plan.name,
      runNumber: `${run.number} · ${run.attempt}`,
      branch: run.ref,
      commitSha: run.revision,
      ...(localDashboardUrl && {
        url: `${localDashboardUrl.replace(/\/$/, "")}/actions/runs/${encodeURIComponent(run.id)}`,
      }),
    },
  };
  const deliveries: Array<(database: typeof db) => Promise<void>> = [];
  if (notify && result) {
    const config = run.configuration.notifications;
    deliveries.push(
      await notification.prepare({
        ...input,
        destinations: {
          channelIds: config?.events.includes(event as "failure" | "success" | "cancelled")
            ? config.channels
            : [],
          includeSubscriptions: true,
        },
      }),
    );
  }
  if (sourceJob) {
    const state = run.status === "success" ? "success" : "failed";
    const config = sourceJob.notifyConfig;
    deliveries.push(
      await notification.prepare({
        ...input,
        eventType: `job_run.${state === "success" ? "succeeded" : "failed"}`,
        payload: { ...input.payload, jobName: sourceJob.label, jobKey: sourceJob.key },
        ...(config?.channels.length && {
          destinations: { channelIds: config.states.includes(state) ? config.channels : [] },
        }),
      }),
    );
  }
  // One event delivered to the same channel through both a workflow and a Job
  // rule remains one notification, even after a partial controller retry.
  if (deliveries.length)
    await db.transaction(async (tx) => {
      for (const queue of deliveries) await queue(tx as typeof db);
    });
  if (sourceJob) await (await import("../jobs/job-workflow")).workflowJobCompleted(run);
}
