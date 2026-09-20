/**
 * Advisory post-deploy port audit.
 *
 * Runs AFTER a deployment is live and confirms the app is actually listening on
 * each user-configured exposed port, probing from INSIDE the instance via the
 * runtime's `inContainerExecutor` (docker exec / cloud workspace exec / bare
 * host). Purely advisory — it can NEVER throw or fail a deploy; the worst it
 * does is record `checked:false` so the dashboard stays silent.
 */

import { waitForPortListening, type BuildLogger, type RuntimeAdapter } from "@repo/adapters";
import type { PortCheckResult } from "../../lib/deployment-runtime";

// The instance is already reported "started", so a correct port returns on the
// first probe. This window only bounds the WRONG-port case: it absorbs a normal
// late bind (heavy runtime booting a few seconds after start) without stalling
// the deploy's "ready" signal for long when nothing will ever come up.
const PORT_AUDIT_TIMEOUT_MS = 15_000;

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Probe each of `ports` inside the deployment `containerId`. Returns one result
 * per unique port. Guaranteed to resolve (never rejects).
 */
export async function auditPorts(
  runtime: RuntimeAdapter,
  containerId: string,
  ports: number[],
  logger: BuildLogger,
): Promise<PortCheckResult[]> {
  const unique = [...new Set(ports.filter((p) => Number.isFinite(p) && p > 0))];
  if (unique.length === 0) return [];

  const inconclusive = (reason: PortCheckResult["skippedReason"]): PortCheckResult[] =>
    unique.map((port) => ({ port, listening: false, checked: false, skippedReason: reason }));

  // Runtime can't exec inside the instance → no signal, stay silent.
  if (!runtime.inContainerExecutor) return inconclusive("no-exec");

  try {
    const executor = await runtime.inContainerExecutor(containerId);
    const results: PortCheckResult[] = [];
    for (const port of unique) {
      const probe = await waitForPortListening(executor, port, {
        timeoutMs: PORT_AUDIT_TIMEOUT_MS,
      });
      if (probe.listening) {
        logger.log(`Port check: port ${port} is listening.\n`, "info");
      } else if (probe.checked) {
        logger.log(`Port check: nothing is listening on port ${port} inside the deployment.\n`, "warn");
      }
      results.push({ port, listening: probe.listening, checked: probe.checked });
    }
    return results;
  } catch (err) {
    // Acquiring the executor (or anything unexpected) failed — advisory only,
    // so degrade to "not checked" instead of surfacing an error.
    logger.log(`Port check skipped (${errMsg(err)}).\n`, "warn");
    return inconclusive("no-exec");
  }
}
