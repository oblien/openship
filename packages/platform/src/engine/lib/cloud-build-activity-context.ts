import { AsyncLocalStorage } from "node:async_hooks";
import { AppError } from "@repo/core";
import type { CloudBuildActivityIdentity } from "@repo/db";

export const cloudBuildActivityContext = new AsyncLocalStorage<{
  identity: CloudBuildActivityIdentity;
  ownerToken: string;
  active: boolean;
  verifyQuiescence?: () => Promise<void>;
}>();

/** Project-scoped nested helpers inherit admission, never lifecycle privileges. */
export function sharesCloudBuildAdmission(
  workspaceId: string | null | undefined,
  options: { scope?: string; lifecycle?: boolean },
): boolean {
  const state = cloudBuildActivityContext.getStore();
  if (!state) return false;
  if (!state.active)
    throw new AppError(
      "The Cloud build activity has finished",
      409,
      "CLOUD_BUILD_ACTIVITY_CHANGED",
    );
  if (
    workspaceId !== state.identity.workspaceId ||
    options.lifecycle ||
    options.scope !== `project:${state.identity.projectId}`
  )
    throw new AppError(
      "Shared build admission cannot acquire exclusive server activity",
      409,
      "CLOUD_BUILD_ACTIVITY_UPGRADE_FORBIDDEN",
    );
  return true;
}
