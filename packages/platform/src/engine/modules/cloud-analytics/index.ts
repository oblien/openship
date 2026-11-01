import { reportCaughtError as observeCaughtError } from "@repo/core/diagnostics";
import { repos } from "@repo/db";
import { getCloudAnalyticsConfig } from "./config";
import { CloudAnalytics } from "./service";

export const cloudAnalytics = new CloudAnalytics({
  config: getCloudAnalyticsConfig,
  repo: repos.cloudAnalytics,
});

/** Existing scheduler owns retries; no per-request timers or unbounded workers. */
export async function startCloudAnalytics(): Promise<void> {
  if (!cloudAnalytics.enabled()) return;
  const { scheduleSystemJob } = await import("../../lib/system-jobs");
  await scheduleSystemJob({
    jobId: "cloud-analytics:deliver",
    cronExpression: "* * * * *",
    run: async () => {
      await cloudAnalytics.drain();
      await cloudAnalytics.flush();
      const due = await repos.cloudAnalytics.claimCheckouts(new Date());
      const { getCheckoutStatus } = await import("../billing/billing.service");
      // Four short provider lookups at a time, at most twenty each tick. The
      // persisted claims prevent multiple API replicas polling the same checkout.
      for (let offset = 0; offset < due.length; offset += 4) {
        await Promise.all(
          due.slice(offset, offset + 4).map(async (checkout) => {
            if (
              !cloudAnalytics.enabled({
                organizationId: checkout.organizationId,
                userId: checkout.userId,
              }) ||
              (checkout.checks > 1 &&
                Date.now() - checkout.createdAt.getTime() > 7 * 24 * 60 * 60_000)
            ) {
              await repos.cloudAnalytics.observedCheckout(
                checkout.organizationId,
                checkout.id,
                checkout.status ?? "unknown",
                null,
              );
              return;
            }
            // Provider failures leave the claim retryable. They never mean unpaid.
            await getCheckoutStatus(checkout.organizationId, checkout.id).catch((diagnosticFailure) => {
              observeCaughtError(diagnosticFailure, "platform/engine/modules/cloud-analytics/index");
            });
          }),
        );
      }
      await cloudAnalytics.flush();
      await repos.cloudAnalytics.prune(new Date(Date.now() - 30 * 24 * 60 * 60_000));
      return { checkoutsChecked: due.length };
    },
  });
  await cloudAnalytics.flush();
}
