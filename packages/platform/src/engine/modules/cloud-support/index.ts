import { diagnostics as errorDiagnostics } from "@repo/core/diagnostics";
import { repos } from "@repo/db";
import { env } from "../../config/env";
import { sendMail } from "../../lib/mail";
import { trackBackgroundWork } from "../../lib/background-work";
import { CloudSupportService } from "./service";

export const cloudSupport = new CloudSupportService({
  enabled: () => env.CLOUD_MODE,
  repo: repos.cloudSupport,
  send: sendMail,
});

export function deliverCloudSupport() {
  if (!env.CLOUD_MODE) return;
  void trackBackgroundWork(cloudSupport.flush()).catch(() => {
    errorDiagnostics.warn("platform/engine/modules/cloud-support/index", "[cloud-support] Email delivery deferred; saved requests will be retried.");
  });
}

export async function startCloudSupport() {
  if (!env.CLOUD_MODE) return;
  const { scheduleSystemJob } = await import("../../lib/system-jobs");
  await scheduleSystemJob({
    jobId: "cloud-support:deliver",
    cronExpression: "* * * * *",
    run: () => cloudSupport.flush(),
  });
  deliverCloudSupport();
}
