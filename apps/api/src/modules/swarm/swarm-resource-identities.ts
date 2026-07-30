/** Effective Swarm volume/network names, separate from Compose logical keys. */

import { parseDocument } from "yaml";
import { AppError } from "@repo/core";
import type { SwarmServiceState } from "@repo/adapters";

type JsonRecord = Record<string, unknown>;

export interface SwarmResourceIdentity {
  kind: "volume" | "network";
  logicalName: string;
  effectiveName: string;
  external: boolean;
  driver: string | null;
  driverOptions: Record<string, string>;
}

function record(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function values(value: unknown): Record<string, string> {
  return Object.fromEntries(Object.entries(record(value) ?? {}).flatMap(([key, item]) =>
    typeof item === "string" || typeof item === "number" || typeof item === "boolean" ? [[key, String(item)]] : [],
  ));
}

function effectiveName(stackName: string, logicalName: string, definition: JsonRecord | null): { name: string; external: boolean } {
  const external = definition?.external;
  const externalName = external === true
    ? text(definition?.name) ?? logicalName
    : text(record(external)?.name);
  const explicitName = text(definition?.name);
  return {
    name: externalName ?? explicitName ?? `${stackName}_${logicalName}`,
    external: externalName !== null || external === true,
  };
}

/**
 * Docker Stack (unlike standalone Compose) namespaces unnamed volumes and
 * networks with the stack name. Explicit `name:` and external identities are
 * passed through exactly and must never be rewritten by OpenShip.
 */
export function swarmResourceIdentities(renderedYaml: string, stackName: string): SwarmResourceIdentity[] {
  const document = parseDocument(renderedYaml, { prettyErrors: false });
  if (document.errors.length > 0) throw new AppError("Rendered stack YAML could not be parsed for resource identities.", 409, "SWARM_RENDER_INVALID");
  const source = record(document.toJSON());
  if (!source) throw new AppError("Rendered stack YAML must be a mapping.", 409, "SWARM_RENDER_INVALID");
  const identities: SwarmResourceIdentity[] = [];
  for (const kind of ["volume", "network"] as const) {
    const section = kind === "volume" ? "volumes" : "networks";
    for (const [logicalName, rawDefinition] of Object.entries(record(source[section]) ?? {})) {
      const definition = record(rawDefinition);
      const resolved = effectiveName(stackName, logicalName, definition);
      identities.push({
        kind,
        logicalName,
        effectiveName: resolved.name,
        external: resolved.external,
        driver: text(definition?.driver),
        driverOptions: values(definition?.driver_opts ?? definition?.driverOpts),
      });
    }
  }
  return identities.sort((left, right) => left.kind.localeCompare(right.kind) || left.logicalName.localeCompare(right.logicalName));
}

/** Stateful volume replacements require an explicit reviewed acknowledgement. */
export function changedSwarmVolumeIdentities(
  previousYaml: string,
  nextYaml: string,
  stackName: string,
): Array<{ logicalName: string; previousName: string; nextName: string }> {
  const previous = new Map(swarmResourceIdentities(previousYaml, stackName)
    .filter((resource) => resource.kind === "volume")
    .map((resource) => [resource.logicalName, resource]));
  return swarmResourceIdentities(nextYaml, stackName)
    .filter((resource) => resource.kind === "volume")
    .flatMap((resource) => {
      const old = previous.get(resource.logicalName);
      return old && old.effectiveName !== resource.effectiveName
        ? [{ logicalName: resource.logicalName, previousName: old.effectiveName, nextName: resource.effectiveName }]
        : [];
    });
}

export function swarmVolumeReplacementAcknowledgementKey(change: {
  logicalName: string;
  previousName: string;
  nextName: string;
}): string {
  return `${change.logicalName}:${change.previousName}:${change.nextName}`;
}

function sourceVolumeNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (typeof entry === "string") {
      const source = entry.split(":")[0]?.trim() ?? "";
      return source && !source.startsWith(".") && !source.startsWith("/") ? [source] : [];
    }
    const mount = record(entry);
    return text(mount?.type) === "volume" && text(mount?.source) ? [text(mount?.source)!] : [];
  });
}

/** Compares desired effective volume identities with the currently attached live names before a first claim. */
export function claimVolumeIdentityMismatches(
  renderedYaml: string,
  stackName: string,
  liveServices: SwarmServiceState[],
): Array<{ serviceName: string; logicalName: string; previousName: string; nextName: string }> {
  const document = parseDocument(renderedYaml, { prettyErrors: false });
  if (document.errors.length > 0) throw new AppError("Rendered stack YAML could not be parsed for resource identities.", 409, "SWARM_RENDER_INVALID");
  const source = record(document.toJSON());
  if (!source) throw new AppError("Rendered stack YAML must be a mapping.", 409, "SWARM_RENDER_INVALID");
  const identities = new Map(swarmResourceIdentities(renderedYaml, stackName)
    .filter((resource) => resource.kind === "volume")
    .map((resource) => [resource.logicalName, resource.effectiveName]));
  const live = new Map(liveServices.map((service) => [service.sourceServiceName, service]));
  const mismatches: Array<{ serviceName: string; logicalName: string; previousName: string; nextName: string }> = [];
  for (const [serviceName, rawService] of Object.entries(record(source.services) ?? {})) {
    const actual = live.get(serviceName)?.volumes ?? [];
    if (actual.length === 0) continue;
    for (const logicalName of sourceVolumeNames(record(rawService)?.volumes)) {
      const nextName = identities.get(logicalName);
      if (!nextName || actual.includes(nextName)) continue;
      const previousName = actual.find((name) => ![...identities.values()].includes(name));
      if (previousName) mismatches.push({ serviceName, logicalName, previousName, nextName });
    }
  }
  return mismatches;
}
