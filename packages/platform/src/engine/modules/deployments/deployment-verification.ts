import { repos, type Deployment } from "@repo/db";
import { type BuildLogger, DeployCancelledError } from "@repo/adapters";
import type { DeploymentVerification } from "@repo/core";
import { reportCaughtError } from "@repo/core/diagnostics";

/** Durable progress and live events share one receipt; success is recorded later. */
export async function beginDeploymentVerification(
  deployment: Pick<Deployment, "id" | "organizationId">,
  logger: BuildLogger,
  urls: string[],
): Promise<void> {
  const verification: DeploymentVerification = {
    startedAt: new Date().toISOString(),
    urls: [...new Set(urls)].filter(value => {
      try {
        const url = new URL(value);
        return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password &&
          !url.hostname.includes("*");
      } catch { return false; }
    }),
  };
  // Progress persistence is best-effort, like timing/log persistence. It must
  // not tear down a published application if the database is temporarily down.
  const recorded = await repos.deployment.setVerification(deployment.id, deployment.organizationId, verification)
    .catch(error => {
      reportCaughtError(error, "platform/engine/modules/deployments/deployment-verification");
      logger.log("Verification progress could not be saved; startup checks are continuing.\n", "warn");
    });
  if (recorded === false)
    throw new DeployCancelledError("Deployment changed before startup verification");
  logger.callback({ timestamp: verification.startedAt, level: "info", step: "verify",
    stepStatus: "running", message: verification.urls.length
      ? "Application published — verifying startup" : "Verifying startup", verification });
}
