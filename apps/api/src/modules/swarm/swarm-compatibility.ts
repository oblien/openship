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

function sourceVolumeNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (typeof item !== "string") return [];
    const source = item.split(":")[0]?.trim() ?? "";
    // Only named volumes; bind paths are separately confined and don't move
    // with a scheduler either, but cannot be inferred as named volume state.
    return source && !source.startsWith(".") && !source.startsWith("/") && !source.includes("/") ? [source] : [];
  });
}

function hasPlacementConstraint(service: JsonRecord): boolean {
  const constraints = record(record(service.deploy)?.placement)?.constraints;
  return Array.isArray(constraints) && constraints.length > 0;
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
  discovery: Pick<SwarmDiscoverySnapshot, "networks" | "volumes" | "configs" | "secrets">;
  registryConfigured: boolean;
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
  for (const [serviceName, rawService] of Object.entries(services)) {
    const service = record(rawService);
    if (!service) continue;
    if (service.build && !input.registryConfigured) append(report, {
      severity: "blocker", code: "SWARM_BUILD_REGISTRY_REQUIRED", serviceName,
      message: "A source-built service cannot be applied until workers can pull its registry image.",
      remediation: "Configure an OCI registry for this stack and publish a digest-pinned image.",
    });
    for (const volume of sourceVolumeNames(service.volumes)) {
      const definition = record(volumeDefinitions[volume]);
      const driver = text(definition?.driver) ?? "local";
      if (driver === "local" && !externalName(volume, definition) && !hasPlacementConstraint(service)) append(report, {
        severity: "warning", code: "SWARM_LOCAL_VOLUME_MOVABILITY", serviceName,
        message: `Local named volume ${volume} may not follow ${serviceName} if Swarm reschedules it.`,
        remediation: "Add a placement constraint, use a multi-node volume driver, or make the service stateless.",
      });
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
