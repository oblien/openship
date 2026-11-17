import { AppError } from "./errors";
import { clusterWorkloadNeedsOperator } from "./cluster-workload";
import { parseVolumeMount } from "./volume-spec";
import type { ComposeAdvanced } from "./types";
import { composeNamespaceDependencies } from "./compose-namespace";

export const MAX_WORKLOAD_REPLICAS = 100;

export function validateWorkloadReplicas(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_WORKLOAD_REPLICAS)
    throw new AppError("Choose between 1 and 100 instances.", 422, "WORKLOAD_REPLICAS_INVALID");
}

/** Both Compose readers map these equivalent inputs into one stored replica count. */
export function readComposeReplicas(
  service: Record<string, unknown>,
  interpolate = (value: string) => value,
): number | undefined {
  const deploy = service.deploy as Record<string, unknown> | undefined;
  const read = (value: unknown) => {
    if (value === undefined) return undefined;
    const resolved = typeof value === "string" ? interpolate(value) : value;
    if (typeof resolved !== "number" && (typeof resolved !== "string" || !/^\d+$/.test(resolved)))
      throw new AppError(
        "Compose replicas must be a whole number from 1 to 100.",
        422,
        "WORKLOAD_REPLICAS_INVALID",
      );
    const count = Number(resolved);
    validateWorkloadReplicas(count);
    return count;
  };
  const scale = read(service.scale);
  const replicas = read(deploy?.replicas);
  if (scale !== undefined && replicas !== undefined && scale !== replicas)
    throw new AppError(
      "Compose scale and deploy.replicas must agree.",
      422,
      "WORKLOAD_REPLICAS_INVALID",
    );
  const count = replicas ?? scale;
  if ((count ?? 1) > 1 && deploy?.mode !== undefined && deploy.mode !== "replicated")
    throw new AppError(
      "Application replicas require replicated deployment mode.",
      422,
      "WORKLOAD_REPLICAS_UNSUPPORTED",
    );
  if ((count ?? 1) > 1 && service.container_name)
    throw new AppError(
      "Remove container_name before running multiple instances.",
      422,
      "WORKLOAD_REPLICAS_UNSUPPORTED",
    );
  return count;
}

/** Normalize private ports once for both Compose import paths. */
export function readComposeExposedPorts(
  value: unknown,
  interpolate = (value: string) => value,
): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value))
    throw new AppError(
      "Compose expose must be a list of container ports.",
      422,
      "COMPOSE_PORT_INVALID",
    );
  const ports = new Set<string>();
  for (const entry of value) {
    const match = /^(\d+)(?:-(\d+))?(?:\/(tcp|udp))?$/.exec(interpolate(String(entry)));
    const first = Number(match?.[1]),
      last = Number(match?.[2] ?? match?.[1]);
    if (!match || first < 1 || last > 65535 || last < first || last - first >= 128)
      throw new AppError(
        "Compose expose requires valid TCP or UDP ports (at most 128).",
        422,
        "COMPOSE_PORT_INVALID",
      );
    for (let port = first; port <= last; port++) ports.add(`${port}/${match[3] ?? "tcp"}`);
    if (ports.size > 128)
      throw new AppError("At most 128 internal ports are supported.", 422, "COMPOSE_PORT_INVALID");
  }
  return [...ports];
}

/** Shared by the editor, admission and Docker. Replicas never imply database replication. */
export function workloadReplicaUnsupportedReason(input: {
  workload?: string;
  framework?: string | null;
  image?: string | null;
  volumes?: readonly string[] | null;
  advanced?: ComposeAdvanced | null;
  controlPlane?: boolean;
}): string | null {
  if (input.controlPlane)
    return "The OpenShip control plane cannot be replicated through application scaling.";
  if (input.workload === "static") return "Static files have no application process to replicate.";
  if (clusterWorkloadNeedsOperator(input.framework, input.image))
    return "Use database management for synchronized database replicas and failover.";
  if (input.volumes?.some((value) => !parseVolumeMount(value).options.includes("ro")))
    return "Multiple instances require stateless storage. Remove writable mounts or make them read-only first.";
  if (input.advanced?.networkMode || input.advanced?.pidMode)
    return "Shared network or process namespaces cannot be used with multiple instances.";
  if (input.advanced?.gpus || input.advanced?.runtime)
    return "GPU allocation must be configured per instance before scaling this workload.";
  return null;
}

export function assertWorkloadReplicas(
  replicas: number,
  input: Parameters<typeof workloadReplicaUnsupportedReason>[0],
): void {
  validateWorkloadReplicas(replicas);
  if (replicas === 1) return;
  const reason = workloadReplicaUnsupportedReason(input);
  if (reason) throw new AppError(reason, 422, "WORKLOAD_REPLICAS_UNSUPPORTED");
}

export function assertWorkloadReplicaTopology(
  services: readonly {
    name: string;
    replicas?: number | null;
    advanced?: ComposeAdvanced | null;
  }[],
): void {
  const replicated = new Set(
    services.filter((service) => (service.replicas ?? 1) > 1).map((service) => service.name),
  );
  for (const service of services) {
    const shared = composeNamespaceDependencies(service.advanced).find((name) =>
      replicated.has(name),
    );
    if (shared)
      throw new AppError(
        `Service "${service.name}" shares a namespace with "${shared}". Remove that dependency before adding instances.`,
        422,
        "WORKLOAD_REPLICAS_UNSUPPORTED",
      );
  }
}
