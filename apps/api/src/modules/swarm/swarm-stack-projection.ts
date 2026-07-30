/**
 * A derived, read-only view of a Swarm stack source document.
 *
 * This parser is deliberately not a Compose renderer. It preserves the source
 * bytes/files elsewhere and extracts just enough structure for service rows,
 * preview, and compatibility UI. Nothing produced here is written back to YAML.
 */

import { parseDocument } from "yaml";
import { AppError, type SwarmServiceProjection } from "@repo/core";

type JsonRecord = Record<string, unknown>;

export interface StackSourceFile {
  path: string;
  content: string;
}

export interface SwarmSourcePublishedPort {
  [key: string]: unknown;
  target: number | null;
  published: number | null;
  protocol: string;
  mode: string | null;
}

export interface SwarmCompatibilityIssue {
  severity: "warning" | "blocker";
  code: string;
  serviceName?: string;
  message: string;
  remediation: string;
}

export interface SwarmStackSourceProjection {
  services: SwarmServiceProjection[];
  networks: string[];
  volumes: string[];
  configs: string[];
  secrets: string[];
  compatibility: SwarmCompatibilityIssue[];
}

function record(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : null;
}

function cloneRecord(value: unknown): JsonRecord | undefined {
  const input = record(value);
  if (!input) return undefined;
  return JSON.parse(JSON.stringify(input)) as JsonRecord;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => typeof entry === "string" && entry.trim() ? [entry.trim()] : []);
}

function names(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (typeof entry === "string" && entry.trim()) return [entry.trim().split(":")[0]!];
    const candidate = record(entry);
    return text(candidate?.source) ? [text(candidate?.source)!] : [];
  });
}

function labels(value: unknown): Record<string, string> {
  if (Array.isArray(value)) {
    return Object.fromEntries(value.flatMap((entry) => {
      if (typeof entry !== "string") return [];
      const index = entry.indexOf("=");
      return index > 0 ? [[entry.slice(0, index), entry.slice(index + 1)]] : [];
    }));
  }
  const input = record(value);
  return Object.fromEntries(Object.entries(input ?? {}).flatMap(([key, item]) =>
    typeof item === "string" || typeof item === "number" || typeof item === "boolean"
      ? [[key, String(item)]]
      : [],
  ));
}

function numberValue(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 65535) return value;
  if (typeof value === "string" && /^\d+$/.test(value)) {
    const result = Number(value);
    return result <= 65535 ? result : null;
  }
  return null;
}

function port(value: unknown): SwarmSourcePublishedPort | null {
  if (typeof value === "number") return { target: numberValue(value), published: null, protocol: "tcp", mode: null };
  if (typeof value === "string") {
    const [withoutProtocol, protocol = "tcp"] = value.split("/");
    const parts = withoutProtocol!.split(":");
    const target = numberValue(parts.at(-1));
    const published = parts.length > 1 ? numberValue(parts.at(-2)) : null;
    return target === null ? null : { target, published, protocol, mode: null };
  }
  const input = record(value);
  if (!input) return null;
  const target = numberValue(input.target ?? input.target_port ?? input.container_port);
  if (target === null) return null;
  return {
    target,
    published: numberValue(input.published ?? input.published_port ?? input.host_port),
    protocol: text(input.protocol) ?? "tcp",
    mode: text(input.mode) ?? null,
  };
}

function mode(deploy: JsonRecord | null): SwarmServiceProjection["mode"] {
  const value = text(deploy?.mode)?.toLowerCase();
  if (value === "global" || value === "replicated" || value === "replicated-job" || value === "global-job") return value;
  return value ? "unknown" : "replicated";
}

function environmentKeys(value: unknown): string[] {
  if (Array.isArray(value)) {
    return Array.from(new Set(value.flatMap((entry) => {
      if (typeof entry !== "string") return [];
      const key = entry.split("=", 1)[0]?.trim() ?? "";
      return /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) ? [key] : [];
    }))).sort();
  }
  return Object.keys(record(value) ?? {}).filter((key) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key)).sort();
}

function healthcheck(value: unknown): SwarmServiceProjection["healthcheck"] | undefined {
  const input = record(value);
  if (!input) return undefined;
  const retries = numberValue(input.retries);
  return {
    configured: true,
    ...(input.disable === true ? { disabled: true } : {}),
    ...(text(input.interval) ? { interval: text(input.interval)! } : {}),
    ...(text(input.timeout) ? { timeout: text(input.timeout)! } : {}),
    ...(retries !== null ? { retries } : {}),
    ...(text(input.start_period) ? { startPeriod: text(input.start_period)! } : {}),
  };
}

function parse(content: string): JsonRecord {
  const document = parseDocument(content, { prettyErrors: false });
  if (document.errors.length > 0) {
    throw new AppError("Stack source YAML is invalid.", 400, "SWARM_SOURCE_INVALID");
  }
  const source = record(document.toJSON());
  if (!source) throw new AppError("Stack source must be a YAML mapping.", 400, "SWARM_SOURCE_INVALID");
  return source;
}

/**
 * Merge only to derive a dashboard projection from ordered source files. The
 * original ordered documents remain authoritative; Docker's stack config is
 * still used later for exact deployment semantics.
 */
function mergeForProjection(files: StackSourceFile[]): JsonRecord {
  if (files.length === 0) throw new AppError("At least one stack source file is required.", 400, "SWARM_SOURCE_INVALID");
  const merged: JsonRecord = {};
  for (const file of files) {
    const document = parse(file.content);
    for (const [key, value] of Object.entries(document)) {
      const sourceServices = key === "services" ? record(value) : null;
      if (sourceServices) {
        const services = { ...(record(merged.services) ?? {}) };
        for (const [serviceName, service] of Object.entries(sourceServices)) {
          services[serviceName] = { ...(record(services[serviceName]) ?? {}), ...(record(service) ?? {}) };
        }
        merged.services = services;
      } else {
        merged[key] = value;
      }
    }
  }
  return merged;
}

function compatibilityFor(serviceName: string, service: JsonRecord, deploy: JsonRecord | null): SwarmCompatibilityIssue[] {
  const issues: SwarmCompatibilityIssue[] = [];
  if (service.build) issues.push({
    severity: "warning", code: "SWARM_BUILD_REQUIRES_REGISTRY", serviceName,
    message: "This service uses build:. Swarm workers need a registry-reachable image.",
    remediation: "Configure an OCI registry and publish a digest-pinned image before apply.",
  });
  if (service.container_name) issues.push({
    severity: "warning", code: "SWARM_CONTAINER_NAME_IGNORED", serviceName,
    message: "container_name is not a stable Swarm task identity.",
    remediation: "Remove container_name and address the service by its stack service name.",
  });
  if (service.restart) issues.push({
    severity: "warning", code: "SWARM_RESTART_IGNORED", serviceName,
    message: "restart is a Compose container setting and does not control Swarm service restarts.",
    remediation: "Use deploy.restart_policy instead.",
  });
  if (record(service.depends_on) || Array.isArray(service.depends_on)) issues.push({
    severity: "warning", code: "SWARM_DEPENDS_ON_CONDITIONS", serviceName,
    message: "Swarm does not wait for Compose depends_on conditions during scheduling.",
    remediation: "Make startup retry dependencies independently or use health-aware application logic.",
  });
  if (service.links) issues.push({
    severity: "warning", code: "SWARM_LINKS_IGNORED", serviceName,
    message: "links is not a portable Swarm service dependency mechanism.",
    remediation: "Use service DNS names on an overlay network instead.",
  });
  if (mode(deploy).endsWith("-job")) issues.push({
    severity: "warning", code: "SWARM_JOB_MODE_ENGINE_SUPPORT", serviceName,
    message: "Swarm job modes require a compatible Docker Engine version.",
    remediation: "Verify manager and worker Engine support before applying this service.",
  });
  return issues;
}

export function projectSwarmStackSource(files: StackSourceFile[]): SwarmStackSourceProjection {
  const source = mergeForProjection(files);
  const rawServices = record(source.services) ?? {};
  const compatibility: SwarmCompatibilityIssue[] = [];
  const services = Object.entries(rawServices).flatMap(([sourceServiceName, value]) => {
    const service = record(value);
    if (!service) return [];
    const deploy = record(service.deploy);
    const replicas = numberValue(deploy?.replicas);
    const serviceLabels = { ...labels(service.labels), ...labels(deploy?.labels) };
    compatibility.push(...compatibilityFor(sourceServiceName, service, deploy));
    return [{
      sourceServiceName,
      mode: mode(deploy),
      ...(replicas !== null ? { replicas: { desired: replicas } } : {}),
      ...(text(service.image) ? { image: text(service.image) } : {}),
      ...(typeof service.build === "string" ? { build: service.build } : cloneRecord(service.build) ? { build: cloneRecord(service.build)! } : {}),
      ...(environmentKeys(service.environment).length ? { environmentKeys: environmentKeys(service.environment) } : {}),
      ...(healthcheck(service.healthcheck) ? { healthcheck: healthcheck(service.healthcheck) } : {}),
      ...(text(deploy?.endpoint_mode) ? { endpointMode: text(deploy?.endpoint_mode) } : {}),
      ...(cloneRecord(deploy?.placement) ? { placement: cloneRecord(deploy?.placement)! } : {}),
      ...(cloneRecord(deploy?.resources) ? { resources: cloneRecord(deploy?.resources)! } : {}),
      ...(cloneRecord(deploy?.update_config) ? { updateConfig: cloneRecord(deploy?.update_config)! } : {}),
      ...(cloneRecord(deploy?.rollback_config) ? { rollbackConfig: cloneRecord(deploy?.rollback_config)! } : {}),
      ...(cloneRecord(deploy?.restart_policy) ? { restartPolicy: cloneRecord(deploy?.restart_policy)! } : {}),
      ...(Object.keys(serviceLabels).length ? { labels: serviceLabels } : {}),
      publishedPorts: (Array.isArray(service.ports) ? service.ports : []).flatMap((entry) => {
        const parsed = port(entry);
        return parsed ? [parsed] : [];
      }),
      networks: names(service.networks),
      volumes: stringList(service.volumes),
      configs: names(service.configs),
      secrets: names(service.secrets),
      sourceState: "present" as const,
    } satisfies SwarmServiceProjection];
  });
  return {
    services,
    networks: Object.keys(record(source.networks) ?? {}).sort(),
    volumes: Object.keys(record(source.volumes) ?? {}).sort(),
    configs: Object.keys(record(source.configs) ?? {}).sort(),
    secrets: Object.keys(record(source.secrets) ?? {}).sort(),
    compatibility,
  };
}
