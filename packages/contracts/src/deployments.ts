import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { ValidationError } from "@repo/core";
import type { DeploymentResourceOperations } from "./deployment-resources";

/** Public command shared by HTTP, native callers, and the remote client. */
export const CreateDeploymentSchema = Type.Object({
  projectId: Type.String({ minLength: 1 }),
  serverId: Type.Optional(
    Type.String({ minLength: 1, description: "Registered server to target." }),
  ),
  branch: Type.Optional(Type.String()),
  commitSha: Type.Optional(Type.String()),
  environment: Type.Optional(Type.Union([Type.Literal("production"), Type.Literal("preview")], {
    description: "Variable set within the target project (default production). Preview values require a non-production project; projectId selects the runtime.",
  })),
  forceAll: Type.Optional(Type.Boolean({ description: "Rebuild every enabled service." })),
  serviceIds: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
  smartRoute: Type.Optional(
    Type.Boolean({ description: "Rebuild services changed since the active deployment." }),
  ),
  refresh: Type.Optional(
    Type.Boolean({ description: "Re-apply environment without pulling source or rebuilding." }),
  ),
});

export type CreateDeploymentInput = Static<typeof CreateDeploymentSchema>;

/**
 * Keep the HTTP compatibility behavior of ignoring unknown fields. Construct a
 * fresh allowlist BEFORE any await: private pipeline flags and later mutations
 * of a native caller's object must never change the authorized command.
 */
export function parseCreateDeploymentInput(value: unknown): CreateDeploymentInput {
  let snapshot: unknown = value;
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const fields: Record<string, unknown> = {};
    for (const key of Object.keys(CreateDeploymentSchema.properties)) {
      const field = (value as Record<string, unknown>)[key];
      if (field !== undefined)
        fields[key] = key === "serviceIds" && Array.isArray(field) ? [...field] : field;
    }
    snapshot = fields;
  }
  if (!Value.Check(CreateDeploymentSchema, snapshot)) {
    const details: Record<string, string[]> = {};
    for (const error of Value.Errors(CreateDeploymentSchema, snapshot)) {
      (details[error.path || "/"] ??= []).push(error.message);
    }
    throw new ValidationError("Invalid deployment input", details);
  }
  return snapshot;
}

/** JSON representation returned by the existing deployment API. Dates are ISO strings in both transports. */
export const DeploymentSchema = Type.Object({
  id: Type.String({ minLength: 1 }),
  projectId: Type.String({ minLength: 1 }),
  organizationId: Type.String({ minLength: 1 }),
  branch: Type.String(),
  commitSha: Type.Union([Type.String(), Type.Null()]),
  commitMessage: Type.Union([Type.String(), Type.Null()]),
  commitShaBefore: Type.Union([Type.String(), Type.Null()]),
  trigger: Type.String(),
  environment: Type.String(),
  framework: Type.Union([Type.String(), Type.Null()]),
  /** Persisted status, including partial_failure, action_required, no_changes and reconciling. */
  status: Type.String(),
  imageRef: Type.Union([Type.String(), Type.Null()]),
  buildDurationMs: Type.Union([Type.Number(), Type.Null()]),
  version: Type.Union([Type.Number(), Type.Null()]),
  releaseVersion: Type.Union([Type.String(), Type.Null()]),
  containerId: Type.Union([Type.String(), Type.Null()]),
  url: Type.Union([Type.String(), Type.Null()]),
  /** Public, masked configuration snapshot. */
  meta: Type.Unknown(),
  /** Existing API field: encrypted environment snapshot, never decrypted here. */
  envVars: Type.Unknown(),
  errorMessage: Type.Union([Type.String(), Type.Null()]),
  errorCode: Type.Union([Type.String(), Type.Null()]),
  errorDetails: Type.Unknown(),
  changedPaths: Type.Union([Type.Array(Type.String()), Type.Null()]),
  changedPathsTruncated: Type.Boolean(),
  forceAll: Type.Boolean(),
  rollbackStrategy: Type.String(),
  artifactRetainedAt: Type.Union([Type.String(), Type.Null()]),
  pinned: Type.Boolean(),
  createdAt: Type.String(),
  updatedAt: Type.String(),
  isActive: Type.Optional(Type.Boolean()),
  projectName: Type.Optional(Type.String()),
  favicon: Type.Optional(Type.Union([Type.String(), Type.Null()])),
});

export type Deployment = Static<typeof DeploymentSchema>;

export const CreateDeploymentResultSchema = Type.Object({
  deployment_id: Type.String({ minLength: 1 }),
  project_id: Type.String({ minLength: 1 }),
  /** Compatibility with ID-only responses; when supplied, the complete record is required. */
  deployment: Type.Optional(DeploymentSchema),
  skipped: Type.Optional(Type.Boolean()),
});

export type CreateDeploymentResult = Static<typeof CreateDeploymentResultSchema>;

export function isDeployment(value: unknown): value is Deployment {
  return Value.Check(DeploymentSchema, value);
}

/** One response contract for native presentation, remote clients, and cloud forwarding. */
export function isCreateDeploymentResult(value: unknown): value is CreateDeploymentResult {
  if (!Value.Check(CreateDeploymentResultSchema, value)) return false;
  return (
    !value.deployment ||
    (value.deployment.id === value.deployment_id &&
      value.deployment.projectId === value.project_id)
  );
}

export interface DeploymentOperations extends DeploymentResourceOperations, BuildOperations {
  create(input: CreateDeploymentInput): Promise<CreateDeploymentResult>;
}
import type { BuildOperations } from "./builds";
