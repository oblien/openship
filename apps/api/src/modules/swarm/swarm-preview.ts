/** Safe rendered-stack redaction and semantic desired-vs-live preview. */

import { createHash } from "node:crypto";
import { parseDocument, stringify } from "yaml";
import type { SwarmServiceProjection } from "@repo/core";
import type { SwarmServiceState } from "@repo/adapters";
import { projectSwarmStackSource } from "./swarm-stack-projection";

const SENSITIVE = /(?:pass(?:word)?|secret|token|api[_-]?key|authorization|credential|private[_-]?key)/i;
const REDACTED = "[REDACTED]";

type JsonRecord = Record<string, unknown>;

export type SwarmPreviewChangeKind =
  | "stack-create"
  | "service-add"
  | "service-remove"
  | "image-change"
  | "replica-mode-change"
  | "placement-resource-change"
  | "network-port-change"
  | "config-secret-reference-change"
  | "labels-routing-change";

export interface SwarmPreviewChange {
  kind: SwarmPreviewChangeKind;
  serviceName?: string;
  summary: string;
}

export interface SwarmPreviewInput {
  renderedYaml: string;
  renderedDigest: string;
  sourceDigest: string | null;
  liveServices: SwarmServiceState[];
  /** The last successful rendered digest, if the stack is already managed. */
  lastAppliedRenderedDigest?: string | null;
  /** Digest captured with the last live observation. */
  lastObservedLiveDigest?: string | null;
  interpolationValues?: Record<string, string>;
}

export interface SwarmStackPreview {
  sourceDigest: string | null;
  renderedDigest: string;
  redactedRenderedYaml: string;
  services: Array<Pick<SwarmServiceProjection, "sourceServiceName" | "image" | "build" | "mode" | "replicas" | "publishedPorts" | "networks" | "volumes" | "configs" | "secrets">>;
  changes: SwarmPreviewChange[];
  cannotCompareExactly: string[];
  liveStateDigest: string;
  noOp: boolean;
}

function record(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : null;
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  const object = record(value);
  if (!object) return value;
  return Object.fromEntries(Object.keys(object).sort().map((key) => [key, canonical(object[key])]));
}

function stable(value: unknown): string {
  return JSON.stringify(canonical(value));
}

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function redactedEnvironment(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => {
      if (typeof entry !== "string") return entry;
      const index = entry.indexOf("=");
      return index > 0 && SENSITIVE.test(entry.slice(0, index)) ? `${entry.slice(0, index)}=${REDACTED}` : entry;
    });
  }
  const values = record(value);
  if (!values) return value;
  return Object.fromEntries(Object.entries(values).map(([key, entry]) => [key, SENSITIVE.test(key) ? REDACTED : redactValue(entry, ["environment", key])]));
}

function redactValue(value: unknown, path: string[]): unknown {
  if (typeof value === "string") {
    return /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(value) ? REDACTED : value;
  }
  if (Array.isArray(value)) return value.map((entry) => redactValue(entry, path));
  const object = record(value);
  if (!object) return value;
  return Object.fromEntries(Object.entries(object).map(([key, entry]) => {
    const nextPath = [...path, key];
    const insideSensitiveMap = path.includes("secrets") || path.includes("configs");
    const namedDefinition = path.at(-1) === "secrets" || path.at(-1) === "configs";
    if (key === "environment") return [key, redactedEnvironment(entry)];
    if (key === "secrets" || key === "configs") return [key, redactValue(entry, nextPath)];
    // Names of top-level secret/config objects are references, not values. Only
    // redact their inline contents, plus any generally sensitive key.
    if ((!namedDefinition && SENSITIVE.test(key)) || (insideSensitiveMap && (key === "data" || key === "content"))) return [key, REDACTED];
    return [key, redactValue(entry, nextPath)];
  }));
}

export function redactRenderedStackYaml(renderedYaml: string): string {
  const document = parseDocument(renderedYaml, { prettyErrors: false });
  if (document.errors.length > 0) return "# Rendered stack could not be parsed for safe preview.\n";
  return stringify(redactValue(document.toJSON(), []));
}

function redactWarning(warning: string, values: Record<string, string>): string {
  let safe = warning;
  for (const value of Object.values(values)) {
    if (value) safe = safe.replaceAll(value, REDACTED);
  }
  return safe.replace(/((?:password|token|secret|api[_-]?key|authorization)\s*[=:]\s*)\S+/ig, `$1${REDACTED}`);
}

function desiredSummary(service: SwarmServiceProjection) {
  return {
    sourceServiceName: service.sourceServiceName,
    image: service.image,
    build: service.build,
    mode: service.mode,
    replicas: service.replicas,
    publishedPorts: service.publishedPorts,
    networks: service.networks,
    volumes: service.volumes,
    configs: service.configs,
    secrets: service.secrets,
  };
}

function liveDigest(services: SwarmServiceState[]): string {
  return sha256(stable(services.map((service) => ({
    sourceServiceName: service.sourceServiceName,
    id: service.id,
    specVersion: service.specVersion,
    mode: service.mode,
    desiredReplicas: service.desiredReplicas,
    image: service.image,
    placement: service.placement,
    resources: service.resources,
    publishedPorts: service.publishedPorts,
    labels: service.labels,
    networks: service.networks,
    configs: service.configs,
    secrets: service.secrets,
  })).sort((a, b) => a.sourceServiceName.localeCompare(b.sourceServiceName))));
}

function differs(left: unknown, right: unknown): boolean {
  return stable(left) !== stable(right);
}

function compareService(desired: SwarmServiceProjection, live: SwarmServiceState, changes: SwarmPreviewChange[]) {
  const serviceName = desired.sourceServiceName;
  if (desired.image && desired.image !== live.image) changes.push({ kind: "image-change", serviceName, summary: `Image changes for ${serviceName}.` });
  if (desired.mode !== live.mode || (desired.replicas?.desired ?? null) !== live.desiredReplicas) {
    changes.push({ kind: "replica-mode-change", serviceName, summary: `Mode or desired replicas change for ${serviceName}.` });
  }
  if (
    (desired.placement && differs(desired.placement, live.placement)) ||
    (desired.resources && differs(desired.resources, live.resources))
  ) changes.push({ kind: "placement-resource-change", serviceName, summary: `Placement or resource policy changes for ${serviceName}.` });
  if (differs(desired.publishedPorts ?? [], live.publishedPorts) || differs(desired.networks ?? [], live.networks)) {
    changes.push({ kind: "network-port-change", serviceName, summary: `Network or published-port changes for ${serviceName}.` });
  }
  if (differs(desired.configs ?? [], live.configs) || differs(desired.secrets ?? [], live.secrets)) {
    changes.push({ kind: "config-secret-reference-change", serviceName, summary: `Config or secret references change for ${serviceName}.` });
  }
  if (desired.labels && differs(desired.labels, live.labels)) {
    changes.push({ kind: "labels-routing-change", serviceName, summary: `Service labels or routing metadata change for ${serviceName}.` });
  }
}

export function previewSwarmStack(input: SwarmPreviewInput): SwarmStackPreview {
  const projection = projectSwarmStackSource([{ path: "rendered-stack.yaml", content: input.renderedYaml }]);
  const desired = projection.services;
  const live = new Map(input.liveServices.map((service) => [service.sourceServiceName, service]));
  const changes: SwarmPreviewChange[] = [];
  const cannotCompareExactly: string[] = [];
  if (input.liveServices.length === 0 && desired.length > 0) {
    changes.push({ kind: "stack-create", summary: "This render creates a new stack." });
  }
  for (const service of desired) {
    const existing = live.get(service.sourceServiceName);
    if (!existing) {
      changes.push({ kind: "service-add", serviceName: service.sourceServiceName, summary: `Service ${service.sourceServiceName} will be added.` });
      if (service.build) cannotCompareExactly.push(`${service.sourceServiceName}: build output requires a registry-published image before exact comparison.`);
      continue;
    }
    compareService(service, existing, changes);
    live.delete(service.sourceServiceName);
  }
  for (const service of live.values()) {
    changes.push({ kind: "service-remove", serviceName: service.sourceServiceName, summary: `Service ${service.sourceServiceName} is absent from the desired stack.` });
  }
  for (const issue of projection.compatibility) {
    if (issue.code === "SWARM_BUILD_REQUIRES_REGISTRY") cannotCompareExactly.push(`${issue.serviceName}: ${issue.message}`);
  }
  const currentLiveDigest = liveDigest(input.liveServices);
  return {
    sourceDigest: input.sourceDigest,
    renderedDigest: input.renderedDigest,
    redactedRenderedYaml: redactRenderedStackYaml(input.renderedYaml),
    services: desired.map(desiredSummary),
    changes,
    cannotCompareExactly,
    liveStateDigest: currentLiveDigest,
    noOp: changes.length === 0 &&
      input.renderedDigest === input.lastAppliedRenderedDigest &&
      currentLiveDigest === input.lastObservedLiveDigest,
  };
}

export function redactRenderWarnings(warnings: string[], interpolationValues: Record<string, string> = {}): string[] {
  return warnings.map((warning) => redactWarning(warning, interpolationValues));
}
