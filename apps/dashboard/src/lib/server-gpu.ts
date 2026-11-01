import type { ServerInfo } from "@/lib/api/system";

/** The API's GPU verdict for a server; `false` when the server carries no annotation (managed/cloud). */
export function serverHasGpu(server: Pick<ServerInfo, "gpu"> | null | undefined): boolean {
  return server?.gpu?.available === true;
}

/**
 * Put GPU servers first when the deployment needs one, keeping the original order inside each group.
 * Never REMOVES a server: the warning (not a filter) is the contract, since the operator can know
 * something the probe does not and the manual mark is how they say so.
 */
export function sortForGpu<T extends Pick<ServerInfo, "gpu">>(
  servers: readonly T[],
  needsGpu: boolean,
): T[] {
  if (!needsGpu) return [...servers];
  const yes: T[] = [];
  const rest: T[] = [];
  for (const server of servers) (serverHasGpu(server) ? yes : rest).push(server);
  return [...yes, ...rest];
}

/** "detected GPU but marked no" / "marked yes but none detected": the two disagreements worth surfacing. */
export function gpuMismatch(
  gpu: ServerInfo["gpu"] | undefined,
): "yes-not-detected" | "no-but-detected" | null {
  if (!gpu || !gpu.probed) return null;
  if (gpu.override === "yes" && !gpu.detected) return "yes-not-detected";
  if (gpu.override === "no" && gpu.detected) return "no-but-detected";
  return null;
}
