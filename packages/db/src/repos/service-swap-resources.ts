import { eq, type SQL } from "drizzle-orm";
import { hasMemoryLimit, validateSwapDisabled, type ComposeAdvanced } from "@repo/core";
import type { createConfigurationSecrets } from "../configuration-secrets";
import type { DatabaseTransaction } from "../connection";
import { project, service } from "../schema";

type MemoryLimit = { memoryMb?: number } | null;

/** Call under the existing project configuration lock, alongside the write.
 * Both project and service edits use that row lock, so neither can invalidate
 * the other's inherited memory limit between validation and commit. */
export async function assertServiceSwapResources(
  tx: DatabaseTransaction,
  projectId: string,
  resources: ComposeAdvanced["resources"],
): Promise<void> {
  if (resources?.swapDisabled !== true) return;
  if (resources.memoryMb !== undefined) {
    validateSwapDisabled(resources);
    return;
  }
  const [owner] = await tx
    .select({ resources: project.resources })
    .from(project)
    .where(eq(project.id, projectId));
  validateSwapDisabled(resources, owner?.resources as MemoryLimit);
}

/** A project memory edit must preserve every service's effective memory cap.
 * Query only for edits removing the cap; positive project limits stay valid. */
export async function assertProjectSwapResources(
  tx: DatabaseTransaction,
  predicate: SQL,
  resources: unknown,
  codec: Pick<ReturnType<typeof createConfigurationSecrets>, "openService">,
): Promise<void> {
  const inherited = resources as MemoryLimit;
  if (hasMemoryLimit(inherited)) return;
  const services = await tx
    .select({ advanced: service.advanced })
    .from(service)
    .innerJoin(project, eq(service.projectId, project.id))
    .where(predicate);
  for (const item of services)
    validateSwapDisabled(codec.openService(item).advanced?.resources, inherited);
}
