import type { ActionDeploymentRequest } from "@repo/db";
import type { DeploymentTriggerInput } from "./build.service";

/** Pending pushes can replace each other, so re-evaluate the complete diff from
 * the deployed release instead of retaining the last push's partial service list. */
export function automaticDeploymentIntent(
  input: DeploymentTriggerInput,
): ActionDeploymentRequest["intent"] {
  return {
    serverId: input.serverId,
    environment: input.environment,
    commitMessage: input.commitMessage,
    forceAll: input.forceAll,
    forcePullImages: input.forcePullImages,
    smartRoute: true,
    ...(input.strictServiceScope ? { strictServiceScope: true, serviceIds: input.serviceIds } : {}),
    event: input.actionEvent,
  };
}
