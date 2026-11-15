import { setTimeout as delay } from "node:timers/promises";
import { withTimeout } from "@repo/core";
import { withDeploymentProgress, type BuildLogger, type RuntimeAdapter } from "@repo/adapters";

/** Poll only a declared long-form dependency. Siblings share this promise at the
 * caller, so N dependents do not multiply the host's health inspections. */
export async function waitForDependencyCondition(args: {
  runtime: RuntimeAdapter;
  containerId: string;
  serviceName: string;
  condition: "service_healthy" | "service_completed_successfully";
  logger: BuildLogger;
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<void> {
  const { runtime, containerId, serviceName, condition, logger, signal } = args;
  if (!runtime.sampleStability)
    throw new Error(`The runtime cannot verify ${condition} for dependency "${serviceName}".`);
  const deadline = Date.now() + (args.timeoutMs ?? 120_000);
  const reason = `dependency "${serviceName}" to reach ${condition}`;
  await withDeploymentProgress(logger, reason, async () => {
    for (;;) {
      signal?.throwIfAborted();
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error(`Timed out waiting for ${reason}.`);
      const sample = await withTimeout(
        runtime.sampleStability!(containerId),
        remaining,
        `Timed out waiting for ${reason}.`,
        signal,
      );
      signal?.throwIfAborted();
      if (
        condition === "service_completed_successfully" &&
        sample.state === "exited" &&
        sample.exitCode === 0
      )
        return;
      if (
        sample.state === "exited" ||
        sample.state === "dead" ||
        sample.state === "missing" ||
        sample.oomKilled
      ) {
        throw new Error(
          `Dependency "${serviceName}" did not reach ${condition}: ${sample.state}, exit code ${sample.exitCode ?? "unknown"}.`,
        );
      }
      if (condition === "service_healthy") {
        if (sample.state === "running" && sample.health === "healthy") return;
        if (
          sample.health === "unhealthy" ||
          (sample.state === "running" && sample.health === null)
        ) {
          throw new Error(
            `Dependency "${serviceName}" is ${sample.health === "unhealthy" ? "unhealthy" : "missing a Docker healthcheck"}; service_healthy cannot be satisfied.`,
          );
        }
      }
      await delay(Math.min(1_000, remaining), undefined, { signal });
    }
  });
}
