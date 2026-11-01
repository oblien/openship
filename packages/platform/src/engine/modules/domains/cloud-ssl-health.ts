import { reportCaughtError as observeCaughtError } from "@repo/core/diagnostics";
import { SYSTEM } from "@repo/core";
import { repos } from "@repo/db";
import { manageDomainSsl } from "../../lib/domain-ssl";
import { withLiveProjectRuntimeMutation } from "../../lib/project-runtime-lock";

/** Uses the existing job runner and domain observations. No separate incidents,
 * renewal loop, network on page render, or route mutation. */
export async function checkCloudDomainHttps() {
  const cutoff = new Date(Date.now() - SYSTEM.DOMAINS.SSL_HEALTH_CHECK_INTERVAL_MS);
  const queue = [...(await repos.domain.findDueCloudSslChecks(cutoff))];
  const result = { checked: 0, healthy: 0, invalid: 0, unknown: 0 };
  await Promise.all(
    Array.from({ length: Math.min(3, queue.length) }, async () => {
      for (;;) {
        const candidate = queue.shift();
        if (!candidate) break;
        if (!candidate.projectId) continue;
        try {
          await withLiveProjectRuntimeMutation(candidate.projectId, async (project) => {
            // A manual check, removal or move may have won while we waited.
            const [current] = await repos.domain.findDueCloudSslChecks(cutoff, 1, candidate.id);
            if (!current || current.projectId !== project.id) return;
            const observed = await manageDomainSsl(current.hostname, {
              action: "verify",
              projectId: project.id,
            });
            result.checked++;
            if (observed.verified) result.healthy++;
            else if (observed.reason === "read_error" || observed.reason === "pending")
              result.unknown++;
            else result.invalid++;
          });
        } catch (error) {
          observeCaughtError(error, "platform/engine/modules/domains/cloud-ssl-health");
          result.unknown++;
        }
      }
    }),
  );
  return result;
}
