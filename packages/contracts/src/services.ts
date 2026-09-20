import { Type, type Static } from "@sinclair/typebox";
import type { ComposeAdvanced } from "@repo/core";
import {
  CreateServiceBody,
  UpdateServiceBody,
  SyncServicesBody,
  SetServiceEnvVarsBody,
} from "./service-inputs";
import { AgentExecBody } from "./exec";
import { EnvironmentScopeSchema } from "./environment-scope";
import { EnvRevealKeysSchema } from "./env-reveal";
import { EnvironmentVariableSchema } from "./project-controls";
import { LogEntrySchema, type DeploymentEvent } from "./deployment-resources";
import type {
  ChildResourceOperations,
  ResourceOperations,
  ResourceOperationSchema,
} from "./resource-operations";

const nullableString = Type.Union([Type.String(), Type.Null()]);
const nullableStrings = Type.Union([Type.Array(Type.String()), Type.Null()]);
const nullableNumber = Type.Union([Type.Number(), Type.Null()]);

/** Public service configuration. Compose merge baselines never cross this boundary. */
export const ServiceSchema = Type.Object({
  id: Type.String(),
  projectId: Type.String(),
  kind: Type.String(),
  name: Type.String(),
  image: nullableString,
  build: nullableString,
  dockerfile: nullableString,
  buildArgs: Type.Record(Type.String(), nullableString),
  /** Instance-keyed fingerprints for stored literal arguments; never runtime attestation. */
  buildArgsFingerprints: Type.Optional(Type.Record(Type.String(), Type.String())),
  ports: nullableStrings,
  dependsOn: nullableStrings,
  environment: Type.Union([Type.Record(Type.String(), Type.String()), Type.Null()]),
  volumes: nullableStrings,
  namespaceVolumes: Type.Boolean(),
  command: nullableString,
  commandArgv: nullableStrings,
  restart: nullableString,
  advanced: Type.Union([
    Type.Unsafe<ComposeAdvanced>(Type.Object({}, { additionalProperties: true })),
    Type.Null(),
  ]),
  exposed: Type.Boolean(),
  exposedPort: nullableString,
  domain: nullableString,
  customDomain: nullableString,
  domainType: nullableString,
  publicEndpoints: Type.Union([
    Type.Array(
      Type.Object({
        port: Type.Number(),
        domainType: Type.Union([Type.Literal("free"), Type.Literal("custom")]),
        domain: Type.Optional(Type.String()),
        customDomain: Type.Optional(Type.String()),
      }),
    ),
    Type.Null(),
  ]),
  rootDirectory: nullableString,
  installCommand: nullableString,
  buildCommand: nullableString,
  startCommand: nullableString,
  outputDirectory: nullableString,
  framework: nullableString,
  packageManager: nullableString,
  buildImage: nullableString,
  alwaysRebuildGlobs: nullableStrings,
  enabled: Type.Boolean(),
  sortOrder: Type.Integer(),
  createdAt: Type.String(),
  updatedAt: Type.String(),
  drift: Type.Union([
    Type.Object({
      changes: Type.Array(
        Type.Object({ field: Type.String(), from: Type.Unknown(), to: Type.Unknown() }),
      ),
    }),
    Type.Null(),
  ]),
});
export type Service = Static<typeof ServiceSchema>;

export const LiveServiceContainerSchema = Type.Object({
  serviceId: Type.String(),
  serviceName: Type.String(),
  containerId: nullableString,
  status: Type.String(),
  ip: nullableString,
  hostPort: nullableNumber,
  imageRef: nullableString,
  matchedBy: nullableString,
  duplicates: Type.Array(Type.String()),
});
export const ServiceVolumeSizesSchema = Type.Object({
  success: Type.Literal(true),
  measurable: Type.Boolean(),
  totalBytes: nullableNumber,
  partial: Type.Boolean(),
  volumes: Type.Array(
    Type.Object({
      raw: Type.String(),
      source: Type.String(),
      target: nullableString,
      kind: Type.String(),
      readOnly: Type.Boolean(),
      bytes: nullableNumber,
    }),
  ),
});
export const AgentExecResultSchema = Type.Object({
  exitCode: Type.Integer(),
  output: Type.String(),
  truncated: Type.Boolean(),
  timedOut: Type.Boolean(),
  durationMs: Type.Number(),
});
export type AgentExecResult = Static<typeof AgentExecResultSchema>;
export const RuntimeLogsInputSchema = Type.Object(
  { tail: Type.Optional(Type.Integer({ minimum: 0, maximum: 100_000 })) },
  { additionalProperties: false },
);
export type RuntimeLogsInput = Static<typeof RuntimeLogsInputSchema>;
export interface StreamOptions {
  signal?: AbortSignal;
}
export const RevealServiceEnvSchema = Type.Object(
  {
    keys: EnvRevealKeysSchema,
    environment: Type.Optional(EnvironmentScopeSchema),
  },
  { additionalProperties: false },
);

export const ServiceCollectionSchemas = {
  list: { action: "read", output: Type.Array(ServiceSchema) },
  create: { action: "write", input: CreateServiceBody, output: ServiceSchema },
  sync: { action: "write", input: SyncServicesBody, output: Type.Array(ServiceSchema) },
  activeContainers: { action: "read", output: Type.Array(LiveServiceContainerSchema) },
} as const satisfies Record<string, ResourceOperationSchema>;
export const ServiceResourceSchemas = {
  get: { action: "read", output: ServiceSchema },
  update: { action: "write", input: UpdateServiceBody, output: ServiceSchema },
  remove: { action: "admin", output: Type.Object({ success: Type.Literal(true) }) },
  acceptDrift: { action: "write", output: ServiceSchema },
  keepDrift: { action: "write", output: ServiceSchema },
  listEnvVars: {
    action: "read",
    input: Type.Object(
      { environment: Type.Optional(EnvironmentScopeSchema) },
      { additionalProperties: false },
    ),
    optionalInput: true,
    output: Type.Array(EnvironmentVariableSchema),
  },
  setEnvVars: {
    action: "write",
    input: SetServiceEnvVarsBody,
    output: Type.Object({ success: Type.Literal(true), count: Type.Integer() }),
  },
  revealEnv: {
    action: "write",
    input: RevealServiceEnvSchema,
    output: Type.Record(Type.String(), Type.String()),
  },
  volumeSizes: { action: "read", output: ServiceVolumeSizesSchema },
  start: { action: "write", output: Type.Object({ success: Type.Literal(true) }) },
  stop: { action: "write", output: Type.Object({ success: Type.Literal(true) }) },
  restart: {
    action: "write",
    input: Type.Object({ force: Type.Optional(Type.Boolean()) }, { additionalProperties: false }),
    optionalInput: true,
    output: Type.Object({ success: Type.Literal(true), containerId: Type.String() }),
  },
  applyEnvironment: {
    action: "write",
    output: Type.Object({
      success: Type.Literal(true), containerId: Type.String(),
      ip: Type.Optional(Type.String()), warning: Type.Optional(Type.String()),
    }),
  },
  runtimeLogs: {
    action: "read",
    input: RuntimeLogsInputSchema,
    optionalInput: true,
    output: Type.Array(LogEntrySchema),
  },
  exec: { action: "write", input: AgentExecBody, output: AgentExecResultSchema },
} as const satisfies Record<string, ResourceOperationSchema>;

export interface ServiceOperations
  extends
    ResourceOperations<typeof ServiceCollectionSchemas>,
    ChildResourceOperations<typeof ServiceResourceSchemas> {
  streamLogs(
    projectId: string,
    serviceId: string,
    input?: RuntimeLogsInput,
    options?: StreamOptions,
  ): AsyncIterable<DeploymentEvent>;
}
