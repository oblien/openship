/**
 * Boot-time registration of the github_webhook_event retention prune.
 *
 * The delivery-id idempotency table only needs a recent window (GitHub redelivers
 * within hours), so rows older than the window are dropped to keep it bounded.
 * Runs daily at 03:47 UTC — off-peak, staggered from the audit/pending-grant sweeps.
 */

import { repos } from "@repo/db";
import { getJobRunner } from "../../lib/job-runner";

const PRUNE_JOB_ID = "github:webhook-event-prune";
const PRUNE_CRON = "47 3 * * *";
const RETENTION_DAYS = 30; // webhook_delivery is a history feed, not just a dedup window

export async function scheduleWebhookEventPrune(): Promise<void> {
  const runner = await getJobRunner();
  await runner.scheduleRecurring({
    jobId: PRUNE_JOB_ID,
    cronExpression: PRUNE_CRON,
    onTick: async () => {
      try {
        const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000);
        const deleted = await repos.webhookDelivery.pruneOlderThan(cutoff);
        if (deleted > 0) {
          console.log(`[webhook-event-prune] deleted ${deleted} row(s) older than ${RETENTION_DAYS}d`);
        }
      } catch (err) {
        console.error("[webhook-event-prune] sweep failed", err);
      }
    },
  });
}
