/**
 * Compare an immutable, review-safe service projection with the live Swarm
 * service spec. Task history is intentionally absent: task churn is normal and
 * must never read as an external stack edit.
 */

import type { SwarmServiceState } from "@repo/adapters";
import type { SwarmServiceProjection } from "@repo/core";

export type SwarmDriftKind =
  | "added-service"
  | "removed-service"
  | "image"
  | "replicas"
  | "mode"
  | "environment-keys"
  | "mounts"
  | "networks"
  | "ports"
  | "labels"
  | "constraints-resources"
  | "configs-secrets";

export interface SwarmDriftChange {
  kind: SwarmDriftKind;
  serviceName: string;
  expected?: unknown;
  actual?: unknown;
}

function stable(value: unknown): unknown {
  if (Array.isArray(value))
    return value.map(stable).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value as Record<string, unknown>)
      .sort()
      .map((key) => [key, stable((value as Record<string, unknown>)[key])]),
  );
}

function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(stable(left)) === JSON.stringify(stable(right));
}

function names(values: string[] | undefined): string[] {
  return [...new Set(values ?? [])].sort();
}

/** Docker and OpenShip own these labels; they are not source-level drift. */
function sourceLabels(labels: Record<string, string> | undefined): Record<string, string> {
  return Object.fromEntries(
    Object.entries(labels ?? {}).filter(
      ([key]) => !key.startsWith("com.docker.stack.") && !key.startsWith("com.openship."),
    ),
  );
}

function desiredReplicas(service: SwarmServiceProjection): number | null {
  if (service.mode === "global" || service.mode === "global-job") return null;
  return service.replicas?.desired ?? 1;
}

function liveReplicas(service: SwarmServiceState): number | null {
  return service.mode === "global" || service.mode === "global-job"
    ? null
    : service.desiredReplicas;
}

function normalizedReferences(values: string[] | undefined, stackName: string): string[] {
  const prefix = `${stackName}_`;
  return names(values).map((value) =>
    value.startsWith(prefix) ? value.slice(prefix.length) : value,
  );
}

function sameImage(expected: string | null | undefined, actual: string | null): boolean {
  if (expected === actual) return true;
  // Docker resolves a tag to `tag@sha256:…` on the manager. That digest is the
  // desired runtime form of the exact configured tag, not external drift.
  return (
    typeof expected === "string" &&
    typeof actual === "string" &&
    actual.startsWith(`${expected}@sha256:`)
  );
}

function networkName(id: string, namesById: Record<string, string> | undefined): string {
  if (!namesById) return id;
  if (namesById[id]) return namesById[id];
  // `docker network ls` deliberately emits a shortened ID while service
  // inspect holds the full Target ID. Match that Engine representation safely.
  return (
    Object.entries(namesById).find(
      ([knownId]) => id.startsWith(knownId) || knownId.startsWith(id),
    )?.[1] ?? id
  );
}

/**
 * Expected projections are derived from the rendered source and contain no
 * secret values. The live side is normalized by the adapter to the same safe
 * shape, so this comparison is safe to persist and return to a browser.
 */
export function classifySwarmSpecDrift(input: {
  stackName: string;
  expected: SwarmServiceProjection[];
  live: SwarmServiceState[];
  /** Discovery maps Engine network IDs to names before safe comparison. */
  networkNamesById?: Record<string, string>;
}): SwarmDriftChange[] {
  const expected = new Map(input.expected.map((service) => [service.sourceServiceName, service]));
  const live = new Map(input.live.map((service) => [service.sourceServiceName, service]));
  const changes: SwarmDriftChange[] = [];

  for (const [name, service] of expected) {
    const actual = live.get(name);
    if (!actual) {
      changes.push({
        kind: "removed-service",
        serviceName: name,
        expected: { mode: service.mode, image: service.image },
      });
      continue;
    }
    const add = (kind: SwarmDriftKind, left: unknown, right: unknown) => {
      if (!same(left, right))
        changes.push({ kind, serviceName: name, expected: left, actual: right });
    };
    if (service.image !== undefined && !sameImage(service.image, actual.image)) {
      changes.push({
        kind: "image",
        serviceName: name,
        expected: service.image,
        actual: actual.image,
      });
    }
    add("mode", service.mode, actual.mode);
    add("replicas", desiredReplicas(service), liveReplicas(actual));
    add("environment-keys", names(service.environmentKeys), names(actual.environmentKeys));
    add(
      "mounts",
      normalizedReferences(service.volumes, input.stackName),
      normalizedReferences(actual.volumes, input.stackName),
    );
    const liveNetworks = (actual.networks ?? [])
      .map((network) => networkName(network, input.networkNamesById))
      // The implicit `<stack>_default` attachment is created by Docker when
      // source omits networks; it is not a user-authored service spec edit.
      .filter((network) => network !== `${input.stackName}_default`);
    add(
      "networks",
      normalizedReferences(service.networks, input.stackName),
      normalizedReferences(liveNetworks, input.stackName),
    );
    add("ports", service.publishedPorts ?? [], actual.publishedPorts);
    add("labels", sourceLabels(service.labels), sourceLabels(actual.labels));
    add(
      "constraints-resources",
      {
        placement: service.placement ?? {},
        resources: service.resources ?? {},
      },
      {
        placement: Object.fromEntries(
          Object.entries(actual.placement ?? {}).filter(([key]) => key !== "Platforms"),
        ),
        resources: actual.resources ?? {},
      },
    );
    add(
      "configs-secrets",
      {
        configs: normalizedReferences(service.configs, input.stackName),
        secrets: normalizedReferences(service.secrets, input.stackName),
      },
      {
        configs: normalizedReferences(actual.configs, input.stackName),
        secrets: normalizedReferences(actual.secrets, input.stackName),
      },
    );
  }
  for (const [name, service] of live) {
    if (!expected.has(name))
      changes.push({
        kind: "added-service",
        serviceName: name,
        actual: { mode: service.mode, image: service.image },
      });
  }
  return changes;
}
