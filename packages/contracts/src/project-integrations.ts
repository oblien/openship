import { Type, type Static } from "@sinclair/typebox";
import { OBJECT_STORAGE_PROVIDERS } from "@repo/core";
import { CreateConnectionBody, CreateBundleBody } from "./project-connections";
import { BindObjectStorageBody } from "./project-storage";
import { ResourceIdSchema } from "./deployment-resources";
import type { ResourceOperationSchema } from "./resource-operations";

const nullableString = Type.Union([Type.String(), Type.Null()]);
const mode = Type.Union([Type.Literal("internal"), Type.Literal("public")]);
const provider = Type.Union(OBJECT_STORAGE_PROVIDERS.map(value => Type.Literal(value)));

export const ProjectConnectionSchema = Type.Object({
  id: Type.String(), sourceProjectId: Type.String(), sourceName: Type.String(), sourceAppTemplateId: nullableString,
  sourceServiceId: Type.Optional(nullableString), sourceServiceName: Type.Optional(nullableString),
  targetProjectId: Type.String(), outputId: Type.String(), envKey: Type.String(), mode,
});
export type ProjectConnection = Static<typeof ProjectConnectionSchema>;
export const ProjectConnectionConsumerSchema = Type.Object({
  id: Type.String(), targetProjectId: Type.String(), targetName: Type.String(), targetSlug: nullableString,
  sourceServiceId: Type.Optional(nullableString),
  outputId: Type.String(), envKey: Type.String(), mode,
});
export const ProjectObjectStorageSchema = Type.Object({
  provider, bucket: Type.String(), endpoint: Type.Optional(nullableString), region: Type.Optional(nullableString),
  forcePathStyle: Type.Optional(Type.Union([Type.Boolean(), Type.Null()])), sourceProjectId: Type.Optional(nullableString),
  envKeys: Type.Array(Type.String()), boundAt: Type.String(),
});
export type ProjectObjectStorage = Static<typeof ProjectObjectStorageSchema>;
export const ProjectStorageViewSchema = Type.Object({
  binding: Type.Union([ProjectObjectStorageSchema, Type.Null()]),
  volumes: Type.Union([Type.Array(Type.String()), Type.Null()]), resolvedVolumes: Type.Array(Type.String()),
  envPreset: Type.String(), envKeys: Type.Array(Type.String()),
  candidates: Type.Array(Type.Object({ projectId: Type.String(), name: Type.String(), appTemplateId: nullableString, defaultBucket: Type.String() })),
  providers: Type.Record(Type.String(), Type.Object({ id: provider, label: Type.String(), endpointPlaceholder: Type.String(), defaultRegion: Type.String(), forcePathStyle: Type.Boolean() })),
});
const proxyValue = Type.Union([Type.String(), Type.Number(), Type.Boolean()]);
const proxySettings = Type.Record(Type.String(), proxyValue);
export const ProjectEdgeConfigSchema = Type.Object({
  reachable: Type.Boolean(), error: Type.Optional(Type.String()), proxyKind: Type.Optional(Type.String()), ours: Type.Optional(Type.Boolean()), nginxVersion: Type.Optional(Type.String()),
  saved: proxySettings,
  hosts: Type.Array(Type.Object({
    hostname: Type.String(), found: Type.Boolean(), tls: Type.Boolean(), driftCount: Type.Integer(), adoptable: proxySettings,
    directives: Type.Array(Type.Object({ key: Type.String(), directive: Type.String(), group: Type.String(), expected: Type.Optional(proxyValue), live: Type.Optional(proxyValue), liveRaw: Type.Optional(Type.String()), drift: Type.Boolean() })),
  })),
});

export const ProjectIntegrationSchemas = {
  listConnectionCandidates: { action: "write", output: Type.Array(Type.Object({ id: Type.String(), name: Type.String(), description: Type.String(), appTemplateId: nullableString })) },
  listConnections: { action: "read", output: Type.Array(ProjectConnectionSchema) },
  listConnectionConsumers: { action: "read", output: Type.Array(ProjectConnectionConsumerSchema) },
  createConnection: { action: "write", input: CreateConnectionBody, output: Type.Object({ connection: ProjectConnectionSchema, requiresRedeploy: Type.Literal(true) }) },
  connectBundle: { action: "write", input: CreateBundleBody, output: Type.Object({ connections: Type.Array(ProjectConnectionSchema), requiresRedeploy: Type.Literal(true) }) },
  removeConnection: { action: "admin", input: ResourceIdSchema, output: Type.Object({ requiresRedeploy: Type.Literal(true) }) },
  getStorage: { action: "read", output: ProjectStorageViewSchema },
  bindStorage: { action: "write", input: BindObjectStorageBody, output: Type.Object({ binding: ProjectObjectStorageSchema, requiresRedeploy: Type.Literal(true) }) },
  unbindStorage: { action: "admin", output: Type.Object({ removed: Type.Boolean() }) },
  getEdgeConfig: { action: "read", output: ProjectEdgeConfigSchema },
} as const satisfies Record<string, ResourceOperationSchema>;
