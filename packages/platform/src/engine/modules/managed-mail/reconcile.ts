import { repos } from "@repo/db";
import { diagnostics } from "@repo/core/diagnostics";
import { scheduleSystemJob } from "../../lib/system-jobs";
import { reconcileSending } from "./sending";
import { warmMailFleet } from "./fleet";
import { reconcileMailChange } from "./plan-change";

export async function startManagedMail() {
  await scheduleSystemJob({
    jobId: "managed-mail:prepare",
    cronExpression: "* * * * *",
    run: async () => {
      await warmMailFleet();
      return { ok: true };
    },
  });
  await scheduleSystemJob({
    jobId: "managed-mail:plan-changes",
    cronExpression: "* * * * *",
    run: async () => {
      for (const { organizationId, target } of await repos.managedMail.unfinishedChanges()) {
        if (!organizationId) continue;
        try {
          await reconcileMailChange(organizationId, target);
        } catch (error) {
          diagnostics.warn(
            "managed-mail",
            "Mail subscription change will retry.",
            { target },
            error,
          );
        }
      }
      return { ok: true };
    },
  });
  await scheduleSystemJob({
    jobId: "managed-mail:renew",
    cronExpression: "*/15 * * * *",
    run: async () => {
      const accounts = await repos.managedMail.senders();
      let failed = 0;
      for (const { organizationId } of accounts) {
        try {
          await reconcileSending(organizationId);
        } catch {
          failed++;
        }
      }
      if (failed)
        diagnostics.warn("managed-mail", "Mail allowance reconciliation will retry.", { failed });
      return { accounts: accounts.length, failed };
    },
  });
}
