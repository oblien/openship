import { createRunBus } from "../../lib/run-bus";

export type NetworkSetupStreamKind = "preparation" | "operation" | "overview";
export const networkSetupBus = createRunBus<void>(() => false);
export const networkSetupTopic = (organizationId: string, kind: NetworkSetupStreamKind, id = "") =>
  JSON.stringify([organizationId, kind, id]);

/** Call only after the database write/transaction commits. */
export function notifyNetworkSetup(organizationId: string, kind: NetworkSetupStreamKind, id = "") {
  networkSetupBus.publish(networkSetupTopic(organizationId, kind, id), undefined);
  if (kind !== "overview")
    networkSetupBus.publish(networkSetupTopic(organizationId, "overview"), undefined);
}
