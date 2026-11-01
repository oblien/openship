import { Type, type Static } from "@sinclair/typebox";
import type { DeploymentEvent } from "./deployment-resources";
import type { ProjectRuntimeLogsInput } from "./project-runtime";
import type { ResourceOperationSchema, ResourceOperations } from "./resource-operations";

export const ServerLogsInputSchema = Type.Object({
  domain: Type.Optional(Type.String({ maxLength: 253 })),
});
export type ServerLogsInput = Static<typeof ServerLogsInputSchema>;
export const RecentServerLogsInputSchema = Type.Object({
  ...ServerLogsInputSchema.properties,
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
});
export const ServerLogStreamTokenSchema = Type.Union([
  Type.Object({ kind: Type.Literal("cloud"), url: Type.String(), token: Type.String() }),
  Type.Object({ kind: Type.Literal("self-hosted") }),
  Type.Object({ kind: Type.Literal("unavailable") }),
]);

export const ProjectLogSchemas = {
  getServerLogStreamToken: {
    action: "read",
    input: ServerLogsInputSchema,
    optionalInput: true,
    output: ServerLogStreamTokenSchema,
  },
  recentServerLogs: {
    action: "read",
    input: RecentServerLogsInputSchema,
    optionalInput: true,
    output: Type.Object({ logs: Type.Array(Type.Unknown()) }),
  },
} as const satisfies Record<string, ResourceOperationSchema>;
export type ProjectLogOperations = ResourceOperations<typeof ProjectLogSchemas>;
export interface ProjectLogStreams {
  streamClusterVolumeEvents(
    id: string,
    options?: { signal?: AbortSignal },
  ): AsyncIterable<DeploymentEvent>;
  streamClusterDatabaseEvents(
    id: string,
    options?: { signal?: AbortSignal },
  ): AsyncIterable<DeploymentEvent>;
  streamRuntimeLogs(
    id: string,
    input?: ProjectRuntimeLogsInput,
    options?: { signal?: AbortSignal },
  ): AsyncIterable<DeploymentEvent>;
  /** Request-log events. The remote SDK selects the authorized self-hosted or Cloud stream. */
  streamServerLogs(
    id: string,
    input?: ServerLogsInput,
    options?: { signal?: AbortSignal },
  ): AsyncIterable<DeploymentEvent>;
}
