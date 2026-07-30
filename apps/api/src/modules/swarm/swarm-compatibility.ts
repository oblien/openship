/** Deployment preflight for constraints Docker's renderer cannot fully explain. */

import { parseDocument } from "yaml";
import type { SwarmDiscoverySnapshot } from "@repo/adapters";
import { projectSwarmStackSource, type SwarmCompatibilityIssue } from "./swarm-stack-projection";

type JsonRecord = Record<string, unknown>;

export interface SwarmCompatibilityReport {
  blockers: SwarmCompatibilityIssue[];
  warnings: SwarmCompatibilityIssue[];
}

function record(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function names(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (typeof item === "string" && item.trim()) return [item.trim().split(":")[0]!];
    return text(record(item)?.source) ? [text(record(item)?.source)!] : [];
  });
}

function externalName(name: string, definition: unknown): string | null {
  const value = record(definition);
  const external = value?.external;
  if (external === true) return text(value?.name) ?? name;
  return text(record(external)?.name) ?? text(value?.name);
}

export interface ExternalSwarmResourceConsumer {
  kind: "config" | "secret";
  name: string;
  consumers: string[];
}

/** Safe metadata only: external object name and the services that mount it. */
export function externalSwarmResourceConsumers(renderedYaml: string): ExternalSwarmResourceConsumer[] {
  const document = parseDocument(renderedYaml, { prettyErrors: false });
  if (document.errors.length > 0) return [];
  const source = record(document.toJSON()) ?? {};
  const services = record(source.services) ?? {};
  const result: ExternalSwarmResourceConsumer[] = [];
  for (const [section, kind] of [["configs", "config"], ["secrets", "secret"]] as const) {
    const definitions = record(source[section]) ?? {};
    const consumers = new Map<string, Set<string>>();
    for (const [serviceName, rawService] of Object.entries(services)) {
      const service = record(rawService);
      if (!service) continue;
      for (const logicalName of names(service[section])) {
        const actualName = externalName(logicalName, definitions[logicalName]);
        if (!actualName) continue;
        const set = consumers.get(actualName) ?? new Set<string>();
        set.add(serviceName);
        consumers.set(actualName, set);
      }
    }
    for (const [name, serviceNames] of consumers) {
      result.push({ kind, name, consumers: [...serviceNames].sort() });
    }
  }
  return result.sort((left, right) => left.kind.localeCompare(right.kind) || left.name.localeCompare(right.name));
}

type StorageMount = {
  kind: "bind" | "volume" | "tmpfs" | "unknown";
  source: string | null;
};

function storageMounts(value: unknown): StorageMount[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap<StorageMount>((entry): StorageMount[] => {
    if (typeof entry === "string") {
      const source = entry.split(":")[0]?.trim() ?? "";
      if (!source) return [{ kind: "unknown", source: null }];
      if (source === "tmpfs") return [{ kind: "tmpfs", source: null }];
      return [{ kind: source.startsWith(".") || source.startsWith("/") || source.startsWith("~") ? "bind" : "volume", source }];
    }
    const mount = record(entry);
    if (!mount) return [{ kind: "unknown", source: null }];
    const type = text(mount.type)?.toLowerCase();
    const source = text(mount.source);
    if (type === "bind") return [{ kind: "bind", source }];
    if (type === "volume") return [{ kind: "volume", source }];
    if (type === "tmpfs") return [{ kind: "tmpfs", source: null }];
    return [{ kind: "unknown", source }];
  });
}

function placementConstraints(service: JsonRecord): string[] {
  const constraints = record(record(service.deploy)?.placement)?.constraints;
  return Array.isArray(constraints)
    ? constraints.flatMap((constraint) => typeof constraint === "string" && constraint.trim() ? [constraint.trim()] : [])
    : [];
}

function eligibleNodeCount(service: JsonRecord, nodes: SwarmDiscoverySnapshot["nodes"]): number | null {
  const constraints = placementConstraints(service);
  if (constraints.length === 0) return null;
  let candidates = nodes.filter((node) => node.status.toLowerCase() === "ready" && node.availability.toLowerCase() === "active");
  let understood = false;
  for (const constraint of constraints) {
    const label = constraint.match(/^node\.labels\.([A-Za-z0-9_.-]+)\s*(==|!=)\s*(.+)$/);
    if (label) {
      understood = true;
      const [, key, operator, expected] = label;
      candidates = candidates.filter((node) => (operator === "==") === (node.labels[key!] === expected!.trim()));
      continue;
    }
    const hostname = constraint.match(/^node\.hostname\s*(==|!=)\s*(.+)$/);
    if (hostname) {
      understood = true;
      const [, operator, expected] = hostname;
      candidates = candidates.filter((node) => (operator === "==") === (node.hostname === expected!.trim()));
    }
  }
  return understood && candidates.length > 0 ? candidates.length : null;
}

function volumeStorageKind(
  definition: JsonRecord | null,
  discovered: SwarmDiscoverySnapshot["volumes"][number] | undefined,
): "local" | "shared" | "unknown" {
  const driver = text(definition?.driver) ?? discovered?.driver ?? "local";
  if (driver !== "local") {
    return /(?:nfs|cifs|smb|gluster|ceph|efs|azurefile|portworx|longhorn|netapp)/i.test(driver) ? "shared" : "unknown";
  }
  const options = { ...(record(definition?.driver_opts) ?? {}), ...(discovered?.options ?? {}) };
  const type = text(options.type)?.toLowerCase();
  const device = text(options.device)?.toLowerCase();
  const shared = ["nfs", "nfs4", "cifs", "smb", "sshfs", "glusterfs", "ceph"].includes(type ?? "") ||
    !!device && (device.startsWith(":") || device.startsWith("//"));
  return shared ? "shared" : "local";
}

function storageKey(serviceName: string, mount: StorageMount): string {
  return `${serviceName}:${mount.kind}:${mount.source ?? ""}`;
}

function append(report: SwarmCompatibilityReport, issue: SwarmCompatibilityIssue): void {
  const bucket = issue.severity === "blocker" ? report.blockers : report.warnings;
  if (!bucket.some((entry) => entry.code === issue.code && entry.serviceName === issue.serviceName)) bucket.push(issue);
}

/**
 * Produces review-safe compatibility guidance. It consumes only config names
 * and Docker discovery metadata, never config/secret payloads or env values.
 */
export function evaluateSwarmCompatibility(input: {
  renderedYaml: string;
  discovery: Pick<SwarmDiscoverySnapshot, "networks" | "volumes" | "configs" | "secrets"> &
    Partial<Pick<SwarmDiscoverySnapshot, "nodes">>;
  registryConfigured: boolean;
  /** Exact storage findings the operator has explicitly reviewed as safe. */
  acknowledgedStorage?: string[];
}): SwarmCompatibilityReport {
  const report: SwarmCompatibilityReport = { blockers: [], warnings: [] };
  const projection = projectSwarmStackSource([{ path: "rendered-stack.yaml", content: input.renderedYaml }]);
  for (const issue of projection.compatibility) append(report, issue);

  const document = parseDocument(input.renderedYaml, { prettyErrors: false });
  if (document.errors.length > 0) {
    append(report, {
      severity: "blocker", code: "SWARM_RENDER_INVALID", message: "Rendered stack YAML could not be parsed for compatibility checks.",
      remediation: "Fix the stack source and render it again before applying.",
    });
    return report;
  }
  const source = record(document.toJSON()) ?? {};
  const services = record(source.services) ?? {};
  const externalConsumers = externalSwarmResourceConsumers(input.renderedYaml);
  const networkNames = new Set(input.discovery.networks.map((network) => network.name));
  const volumeNames = new Set(input.discovery.volumes.map((volume) => volume.name));
  const configNames = new Set(input.discovery.configs.map((config) => config.name));
  const secretNames = new Set(input.discovery.secrets.map((secret) => secret.name));
  const requirements: Array<[string, unknown, Set<string>, string]> = [
    ["network", source.networks, networkNames, "Create the external overlay network on the manager, or remove external: true."],
    ["volume", source.volumes, volumeNames, "Create the external volume with the required driver/options before applying."],
    ["config", source.configs, configNames, "Create the external config on the manager before applying."],
    ["secret", source.secrets, secretNames, "Create the external secret on the manager before applying."],
  ];
  for (const [kind, definitions, existing, remediation] of requirements) {
    for (const [name, definition] of Object.entries(record(definitions) ?? {})) {
      const required = externalName(name, definition);
      if (required && !existing.has(required)) append(report, {
        severity: "blocker", code: `SWARM_EXTERNAL_${kind.toUpperCase()}_MISSING`,
        ...(externalConsumers.find((entry) => entry.kind === kind && entry.name === required)?.consumers.length === 1
          ? { serviceName: externalConsumers.find((entry) => entry.kind === kind && entry.name === required)!.consumers[0] }
          : {}),
        message: `Required external ${kind} ${required} does not exist on this manager.${(() => {
          const consumers = externalConsumers.find((entry) => entry.kind === kind && entry.name === required)?.consumers ?? [];
          return consumers.length ? ` Consumed by ${consumers.join(", ")}.` : "";
        })()}`,
        remediation,
      });
    }
  }

  const volumeDefinitions = record(source.volumes) ?? {};
  const volumes = new Map(input.discovery.volumes.map((volume) => [volume.name, volume]));
  const acknowledgedStorage = new Set(input.acknowledgedStorage ?? []);
  for (const [serviceName, rawService] of Object.entries(services)) {
    const service = record(rawService);
    if (!service) continue;
    if (service.build && !input.registryConfigured) append(report, {
      severity: "blocker", code: "SWARM_BUILD_REGISTRY_REQUIRED", serviceName,
      message: "A source-built service cannot be applied until workers can pull its registry image.",
      remediation: "Configure an OCI registry for this stack and publish a digest-pinned image.",
    });
    for (const mount of storageMounts(service.volumes)) {
      if (acknowledgedStorage.has(storageKey(serviceName, mount))) continue;
      if (mount.kind === "bind") {
        append(report, {
          severity: "warning", code: "SWARM_STORAGE_BIND_UNVERIFIED", serviceName,
          acknowledgementKey: storageKey(serviceName, mount),
          message: `High storage risk: bind mount ${mount.source ?? "(unnamed)"} cannot be verified on every node eligible for ${serviceName}.`,
          remediation: "Pin the service to a verified node, use shared storage, or explicitly acknowledge the known-safe bind setup.",
        });
        continue;
      }
      if (mount.kind === "tmpfs") {
        append(report, {
          severity: "warning", code: "SWARM_STORAGE_TMPFS_EPHEMERAL", serviceName,
          acknowledgementKey: storageKey(serviceName, mount),
          message: `tmpfs storage for ${serviceName} is intentionally ephemeral and is lost when its task is rescheduled.`,
          remediation: "Use tmpfs only for disposable data, or attach persistent storage for application state.",
        });
        continue;
      }
      if (mount.kind === "unknown" || !mount.source) {
        append(report, {
          severity: "warning", code: "SWARM_STORAGE_MOUNT_UNKNOWN", serviceName,
          acknowledgementKey: storageKey(serviceName, mount),
          message: `OpenShip cannot classify one storage mount for ${serviceName}.`,
          remediation: "Use an explicit bind, volume, or tmpfs mount and verify its scheduler behavior before relying on it for state.",
        });
        continue;
      }
      const definition = record(volumeDefinitions[mount.source]);
      const actualName = externalName(mount.source, definition) ?? mount.source;
      const discovered = volumes.get(actualName);
      const volumeKind = volumeStorageKind(definition, discovered);
      if (volumeKind === "shared") {
        append(report, {
          severity: "warning", code: "SWARM_STORAGE_SHARED_VOLUME", serviceName,
          acknowledgementKey: storageKey(serviceName, mount),
          message: `Volume ${actualName} for ${serviceName} appears to use shared/distributed storage; OpenShip does not verify its availability or data-consistency guarantees.`,
          remediation: "Verify the driver's failover, locking, backup, and recovery guarantees with the storage operator.",
        });
        continue;
      }
      if (volumeKind === "unknown") {
        append(report, {
          severity: "warning", code: "SWARM_STORAGE_VOLUME_DRIVER_UNKNOWN", serviceName,
          acknowledgementKey: storageKey(serviceName, mount),
          message: `Volume ${actualName} for ${serviceName} uses a driver OpenShip cannot classify as local or shared.`,
          remediation: "Review the driver's scheduling and data guarantees, then explicitly acknowledge the known-safe setup if appropriate.",
        });
        continue;
      }
      const eligible = eligibleNodeCount(service, input.discovery.nodes ?? []);
      if (eligible === 1) {
        append(report, {
          severity: "warning", code: "SWARM_STORAGE_LOCAL_VOLUME_PINNED", serviceName,
          acknowledgementKey: storageKey(serviceName, mount),
          message: `Local volume ${actualName} for ${serviceName} is constrained to one eligible node; it is not portable or highly available.`,
          remediation: "Keep that node and its volume protected, or migrate the service to shared storage before relying on rescheduling.",
        });
      } else {
        append(report, {
          severity: "warning", code: "SWARM_STORAGE_LOCAL_VOLUME_UNPINNED", serviceName,
          acknowledgementKey: storageKey(serviceName, mount),
          message: `High storage risk: local volume ${actualName} may be absent if Swarm reschedules ${serviceName} to another node.`,
          remediation: "Add a constraint that selects one verified node, use a multi-node volume driver, or make the service stateless.",
        });
      }
    }
    const loggingDriver = text(record(service.logging)?.driver);
    if (loggingDriver && !["json-file", "local", "journald"].includes(loggingDriver)) append(report, {
      severity: "warning", code: "SWARM_SERVICE_LOGS_LIMITED", serviceName,
      message: `Logging driver ${loggingDriver} may not be available through Docker service logs.`,
      remediation: "Use a supported logging driver or retain an external log viewer for this service.",
    });
  }
  return report;
}
