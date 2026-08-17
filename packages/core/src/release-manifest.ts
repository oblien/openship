/**
 * Versioned application-release manifest the control plane can hand an agent.
 * The agent does not plan: it validates this contract, then runs `steps`.
 */

import { ValidationError } from "./errors";

export const RELEASE_MANIFEST_VERSION = 1 as const;

export type ReleaseManifestSource = "git-prebuilt" | "local-upload" | "server-prepared";

export type ReleaseManifestStep = {
  command: string;
  args?: string[];
};

export type ReleaseManifest = {
  version: typeof RELEASE_MANIFEST_VERSION;
  projectId: string;
  deploymentId: string;
  source: ReleaseManifestSource;
  sha256: string;
  commitSha?: string;
  serviceId?: string;
  serviceName?: string;
  sharedPaths: string[];
  lockHashes?: Record<string, string>;
  migrationPolicy?: string;
  reloadCommand?: string;
  healthPath?: string;
  healthPort?: number;
  rollbackPolicy?: string;
  steps: ReleaseManifestStep[];
};

const SOURCES = new Set<ReleaseManifestSource>([
  "git-prebuilt",
  "local-upload",
  "server-prepared",
]);

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new ValidationError(`Release manifest missing ${field}.`);
  }
  return value.trim();
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function parseSteps(raw: unknown): ReleaseManifestStep[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    throw new ValidationError("Release manifest steps must be an array.");
  }
  const steps: ReleaseManifestStep[] = [];
  for (const item of raw) {
    const o = asRecord(item);
    if (!o) throw new ValidationError("Release manifest step is invalid.");
    const command = requireString(o.command, "steps.command");
    const args = Array.isArray(o.args) ? o.args.map(String) : undefined;
    steps.push(args ? { command, args } : { command });
  }
  return steps;
}

function parseLockHashes(raw: unknown): Record<string, string> | undefined {
  if (raw === undefined) return undefined;
  const o = asRecord(raw);
  if (!o) throw new ValidationError("Release manifest lockHashes must be an object.");
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(o)) {
    if (typeof value !== "string" || !/^[a-f0-9]{64}$/i.test(value)) {
      throw new ValidationError(`Release manifest lockHashes.${key} is not a SHA-256.`);
    }
    out[key] = value.toLowerCase();
  }
  return out;
}

/** Validate and allowlist an agent execute_release payload. */
export function parseReleaseManifest(raw: unknown): ReleaseManifest {
  const o = asRecord(raw);
  if (!o) throw new ValidationError("Release manifest must be an object.");
  if (o.version !== RELEASE_MANIFEST_VERSION) {
    throw new ValidationError("Release manifest version is unsupported.");
  }
  const source = o.source;
  if (typeof source !== "string" || !SOURCES.has(source as ReleaseManifestSource)) {
    throw new ValidationError("Release manifest source is invalid.");
  }
  const sha256 = requireString(o.sha256, "sha256").toLowerCase().replace(/^sha256:/, "");
  if (!/^[a-f0-9]{64}$/.test(sha256)) {
    throw new ValidationError("Release manifest sha256 is not a SHA-256 digest.");
  }
  const sharedPaths = Array.isArray(o.sharedPaths)
    ? o.sharedPaths.filter((item): item is string => typeof item === "string")
    : [];
  const out: ReleaseManifest = {
    version: RELEASE_MANIFEST_VERSION,
    projectId: requireString(o.projectId, "projectId"),
    deploymentId: requireString(o.deploymentId, "deploymentId"),
    source: source as ReleaseManifestSource,
    sha256,
    sharedPaths,
    steps: parseSteps(o.steps),
  };
  const commitSha = optionalString(o.commitSha);
  if (commitSha) out.commitSha = commitSha;
  const serviceId = optionalString(o.serviceId);
  if (serviceId) out.serviceId = serviceId;
  const serviceName = optionalString(o.serviceName);
  if (serviceName) out.serviceName = serviceName;
  const lockHashes = parseLockHashes(o.lockHashes);
  if (lockHashes) out.lockHashes = lockHashes;
  const migrationPolicy = optionalString(o.migrationPolicy);
  if (migrationPolicy) out.migrationPolicy = migrationPolicy;
  const reloadCommand = optionalString(o.reloadCommand);
  if (reloadCommand) out.reloadCommand = reloadCommand;
  const healthPath = optionalString(o.healthPath);
  if (healthPath) out.healthPath = healthPath;
  const healthPort = optionalNumber(o.healthPort);
  if (healthPort !== undefined) out.healthPort = healthPort;
  const rollbackPolicy = optionalString(o.rollbackPolicy);
  if (rollbackPolicy) out.rollbackPolicy = rollbackPolicy;
  return out;
}
