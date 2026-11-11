import { reportCaughtError } from "@repo/core/diagnostics";
import type { BuildLogger } from "./build-pipeline";

/** A heartbeat describes an existing wait; it never adds probes or delays. */
export async function withDeploymentProgress<T>(
  logger: Pick<BuildLogger, "log">,
  reason: string,
  run: () => Promise<T>,
): Promise<T> {
  const started = Date.now();
  const timer = setInterval(() => {
    try {
      logger.log(
        `Waiting for ${reason} (${Math.floor((Date.now() - started) / 1000)}s elapsed)…\n`,
      );
    } catch (error) {
      reportCaughtError(error, "adapters/runtime/deployment-progress");
    }
  }, 1_000);
  timer.unref?.();
  try {
    return await run();
  } finally {
    clearInterval(timer);
  }
}
