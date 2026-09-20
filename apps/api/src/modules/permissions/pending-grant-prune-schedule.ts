/**
 * Boot-time registration of the invitation_pending_grant sweep.
 *
 * Pending grants are linked to an invitation; the reject/cancel hooks
 * delete them inline, but Better Auth flips status="expired" on the
 * TIMED expiry path without firing a hook. Without this sweep, expired
 * invitations leak pending-grant rows indefinitely.
 *
 * Runs daily at 03:33 UTC — off-peak, staggered from the audit prune.
 */

import { repos } from "@repo/db";
import { getJobRunner } from "@repo/platform/engine/lib/job-runner/index";

const PENDING_GRANT_PRUNE_JOB_ID = "permissions:pending-grant-prune";
const PENDING_GRANT_PRUNE_CRON = "33 3 * * *";

export async function schedulePendingGrantPrune(): Promise<void> {
  const runner = await getJobRunner();
  await runner.scheduleRecurring({
    jobId: PENDING_GRANT_PRUNE_JOB_ID,
    cronExpression: PENDING_GRANT_PRUNE_CRON,
    onTick: async () => {
      try {
        const deleted = await repos.invitationPendingGrant.sweepDeadInvitations();
        if (deleted > 0) {
          console.log(`[pending-grant-prune] deleted ${deleted} orphan row(s)`);
        }
      } catch (err) {
        console.error("[pending-grant-prune] sweep failed", err);
      }
    },
  });
}
