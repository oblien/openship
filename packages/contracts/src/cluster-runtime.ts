import { Type, type Static } from "@sinclair/typebox";
import type { ResourceOperationSchema } from "./resource-operations";

const id = Type.String({ minLength: 1, maxLength: 200 });
const nullable = Type.Union([Type.String(), Type.Null()]);
export const ClusterRuntimeStatusSchema = Type.Union(
  (["setting_up", "ready", "failed", "interrupted", "removing", "removed"] as const).map((value) =>
    Type.Literal(value),
  ),
);
const step = Type.Union(
  (["connect", "prerequisites", "inspect", "install", "join", "verify", "remove"] as const).map(
    (value) => Type.Literal(value),
  ),
);
export const ClusterRuntimeSchema = Type.Object(
  {
    id,
    clusterId: id,
    provider: Type.Union([Type.Literal("k3s"), Type.Literal("swarm")]),
    status: ClusterRuntimeStatusSchema,
    intent: Type.Union([Type.Literal("setup"), Type.Literal("remove")]),
    sequence: Type.Integer({ minimum: 1 }),
    generation: Type.Integer({ minimum: 1 }),
    plan: Type.Object({
      networkId: Type.Union([id, Type.Null()]),
      networkRevision: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
      version: nullable,
      podCidr: nullable,
      serviceCidr: nullable,
      clusterUid: Type.Optional(Type.String()),
      cleanup: Type.Optional(Type.Object({ verifiedAt: Type.String(), clusterUid: nullable })),
      hosts: Type.Array(
        Type.Object({
          serverId: id,
          name: Type.String(),
          address: Type.String(),
          privateIp: Type.String(),
          nodeName: Type.String(),
          role: Type.Union([Type.Literal("server"), Type.Literal("agent")]),
          hostIdentity: nullable,
          interfaceName: nullable,
          installed: Type.Boolean(),
          ready: Type.Boolean(),
          steps: Type.Array(
            Type.Object({
              id: step,
              status: Type.Union(
                (["pending", "running", "completed", "failed", "skipped"] as const).map((value) =>
                  Type.Literal(value),
                ),
              ),
              message: nullable,
              startedAt: nullable,
              finishedAt: nullable,
            }),
          ),
          logs: Type.Array(
            Type.Object({
              timestamp: Type.String(),
              step,
              level: Type.Union([
                Type.Literal("info"),
                Type.Literal("warn"),
                Type.Literal("error"),
              ]),
              message: Type.String(),
            }),
          ),
        }),
      ),
    }),
    error: nullable,
    verifiedAt: nullable,
    createdAt: Type.String(),
    updatedAt: Type.String(),
  },
  { additionalProperties: false },
);

export const SetupClusterRuntimeInputSchema = Type.Object(
  {
    clusterId: id,
    revision: Type.Integer({ minimum: 1 }),
    requestId: Type.String({ minLength: 16, maxLength: 64, pattern: "^[a-zA-Z0-9_-]+$" }),
  },
  { additionalProperties: false },
);
export const ChangeClusterRuntimeInputSchema = Type.Object(
  { clusterId: id, sequence: Type.Integer({ minimum: 1 }) },
  { additionalProperties: false },
);
export type SetupClusterRuntimeInput = Static<typeof SetupClusterRuntimeInputSchema>;
export type ChangeClusterRuntimeInput = Static<typeof ChangeClusterRuntimeInputSchema>;
export const ClusterRuntimeCollectionSchemas = {
  getClusterRuntime: {
    action: "read",
    scope: "all",
    input: Type.Object({ clusterId: id }, { additionalProperties: false }),
    output: Type.Union([ClusterRuntimeSchema, Type.Null()]),
  },
  setupClusterRuntime: {
    action: "admin",
    scope: "all",
    input: SetupClusterRuntimeInputSchema,
    output: ClusterRuntimeSchema,
  },
  retryClusterRuntime: {
    action: "admin",
    scope: "all",
    input: ChangeClusterRuntimeInputSchema,
    output: ClusterRuntimeSchema,
  },
  removeClusterRuntime: {
    action: "admin",
    scope: "all",
    input: ChangeClusterRuntimeInputSchema,
    output: ClusterRuntimeSchema,
  },
} as const satisfies Record<string, ResourceOperationSchema>;
