import { diagnostics } from "@repo/core/diagnostics";
import { repos } from "@repo/db";
import { env, runtimeTarget } from "../../config/env";
import { sendMail } from "../../lib/mail";
import { CustomerEmailService } from "./service";

export const customerEmails = new CustomerEmailService({
  enabled: () => env.CLOUD_MODE,
  repo: repos.cloudCustomerEmail,
  send: sendMail,
  dashboardUrl: runtimeTarget.dashboard,
});

export async function startCustomerEmails() {
  if (!env.CLOUD_MODE) return;
  const { scheduleSystemJob } = await import("../../lib/system-jobs");
  const run = async () => {
    const result = await customerEmails.flush();
    if (result.failed)
      diagnostics.warn(
        "platform/engine/modules/customer-email",
        "Customer email delivery failed; delivery state is saved.",
        { failed: result.failed },
      );
    return result;
  };
  await scheduleSystemJob({
    jobId: "cloud-customer-email:deliver",
    cronExpression: "* * * * *",
    run,
  });
  await run();
}
