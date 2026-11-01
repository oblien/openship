/**
 * Build and validate backup manifest.json — the canonical pointer to
 * a run's artifacts on the destination.
 *
 * The manifest is written last and cross-checked during restore. The run's
 * durable succeeded status admits restore; older runs may have no manifest.
 * Version 2 records incremental blocks so older binaries refuse that format
 * instead of treating a block index as a tar archive.
 */

import type { BackupManifest } from "../types";

export function buildManifest(opts: {
  runId: string;
  projectId: string;
  projectSlug: string;
  serviceId: string;
  serviceName: string;
  serviceImage: string | null;
  capturedAt: Date;
  artifacts: BackupManifest["artifacts"];
  envVarKeys: string[];
  serviceConfig: BackupManifest["serviceConfig"];
}): BackupManifest {
  return {
    version: opts.artifacts.some(artifact => artifact.metadata.storage !== undefined) ? 2 : 1,
    runId: opts.runId,
    projectId: opts.projectId,
    projectSlug: opts.projectSlug,
    serviceId: opts.serviceId,
    serviceName: opts.serviceName,
    serviceImage: opts.serviceImage,
    capturedAt: opts.capturedAt.toISOString(),
    artifacts: opts.artifacts,
    envVarKeys: opts.envVarKeys,
    serviceConfig: opts.serviceConfig,
  };
}

/** Throws on an unsupported manifest version or invalid common envelope. */
export function validateManifest(value: unknown): BackupManifest {
  if (!value || typeof value !== "object") {
    throw new Error("Invalid manifest: not an object");
  }
  const v = value as Record<string, unknown>;
  if (v.version !== 1 && v.version !== 2) {
    throw new Error(`Unsupported manifest version: ${String(v.version)}`);
  }
  for (const field of ["runId", "projectId", "serviceId", "capturedAt"]) {
    if (typeof v[field] !== "string") {
      throw new Error(`Invalid manifest: missing or non-string ${field}`);
    }
  }
  if (!Array.isArray(v.artifacts)) {
    throw new Error("Invalid manifest: artifacts is not an array");
  }
  return value as BackupManifest;
}
