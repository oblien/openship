/**
 * Manual trigger — "Backup now" button. The simplest of the four
 * trigger types: a user hits an HTTP endpoint, we build a
 * BackupTrigger value, and the orchestrator does the rest.
 *
 * Authorization: route layer guarantees the caller belongs to the
 * active organization. We re-verify org-scope on both the policy's
 * project and the destination before enqueueing.
 */

import { repos } from "@repo/db";
import { assertResourceInOrg } from "@repo/platform/engine/lib/resource-access";
import type { ExecutionContext as RequestContext } from "@repo/platform";
import { backupOrchestrator } from "@repo/platform/engine/modules/backups/backup.orchestrator";
import { policyOrganizationId } from "@repo/platform/engine/modules/backups/backup.service";

export async function triggerManualBackup(
  ctx: RequestContext,
  policyId: string,
): Promise<{ runId: string }> {
  const policy = await repos.backupPolicy.findById(policyId);
  if (!policy) {
    throw new Error("Backup policy not found");
  }
  const orgId = await policyOrganizationId(policy);
  try {
    assertResourceInOrg(
      orgId ? { organizationId: orgId } : null,
      "Backup policy",
      ctx.organizationId,
      policyId,
    );
  } catch {
    throw new Error("Backup policy not found"); // hide existence
  }
  const destination = await repos.backupDestination.findById(policy.destinationId);
  try {
    assertResourceInOrg(
      destination,
      "Backup destination",
      ctx.organizationId,
      policy.destinationId,
    );
  } catch {
    throw new Error("Backup destination not accessible");
  }

  return backupOrchestrator.enqueue({
    policyId,
    trigger: {
      source: "manual",
      userId: ctx.userId,
      clientIp: ctx.clientIp ?? undefined,
    },
  });
}
