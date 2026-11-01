import { Type, type Static } from "@sinclair/typebox";
import { MigrationRequestSchemas } from "./migration";
import { ResourceIdSchema, type DeploymentEvent } from "./deployment-resources";
import { ServerDetailSchema } from "./servers";
import type {
  DiscoveredStack,
  ComposeRepoService,
  AdoptResult,
  ReimportResult,
  MigrationPreview,
  MigrationRun,
  TransferProgress,
} from "./migration-types";
import type {
  ResourceOperationSchema,
  ScopedOperations,
  ResourceOperations,
} from "./resource-operations";

const text = Type.String();
const strings = Type.Array(text);
const count = Type.Number();
const nullableText = Type.Union([text, Type.Null()]);
const optionalText = Type.Optional(text);
const optionalNullableText = Type.Optional(nullableText);
const object = Type.Record(text, Type.Unknown());
const env = Type.Record(text, text);
const ok = Type.Object({ success: Type.Literal(true) });
const source = Type.Union([Type.Literal("compose"), Type.Literal("container")]);
const service = Type.Object({
  name: text,
  source,
  running: Type.Boolean(),
  ports: strings,
  env,
  volumes: Type.Array(
    Type.Object({
      type: Type.Union([Type.Literal("volume"), Type.Literal("bind")]),
      source: optionalText,
      target: text,
      rw: Type.Boolean(),
    }),
  ),
  networks: strings,
  dependsOn: strings,
  warnings: strings,
});
/** Wire types are shared with the dashboard; validate required discovery fields before exposing them. */
export const DiscoveredStackSchema = Type.Unsafe<DiscoveredStack>(
  Type.Object({
    serverId: text,
    composeProjects: strings,
    services: Type.Array(service),
    groups: Type.Array(Type.Object({ project: nullableText, services: Type.Array(service) })),
    volumes: Type.Array(Type.Object({ name: text, driver: text, inUseBy: strings })),
    networks: Type.Array(Type.Object({ name: text, driver: text })),
    warnings: strings,
    adoptable: Type.Boolean(),
    alreadyManaged: count,
    openshipProjects: Type.Array(
      Type.Object({
        projectId: text,
        suggestedName: text,
        knownHere: Type.Boolean(),
        hasSnapshot: Type.Boolean(),
        services: Type.Array(service),
      }),
    ),
  }),
);
export const MigrationPreviewSchema = Type.Unsafe<MigrationPreview>(
  Type.Object({
    sameServer: Type.Boolean(),
    services: Type.Array(
      Type.Object({
        name: text,
        source,
        classification: Type.Union([Type.Literal("registry"), Type.Literal("build")]),
        blocked: Type.Boolean(),
        volumes: Type.Array(Type.Object({ name: text, target: text })),
        bindMounts: strings,
        bindMountsSkipped: strings,
        warnings: strings,
      }),
    ),
    volumesToMove: strings,
    hasBlocked: Type.Boolean(),
    downtimeWarning: Type.Boolean(),
    droppedProxies: strings,
    warnings: strings,
    plan: Type.Optional(
      Type.Object({
        totalBytes: count,
        partial: Type.Boolean(),
        items: Type.Array(
          Type.Object({
            ref: text,
            kind: Type.Union([
              Type.Literal("volume"),
              Type.Literal("bind"),
              Type.Literal("image"),
              Type.Literal("path"),
            ]),
            bytes: Type.Union([count, Type.Null()]),
          }),
        ),
      }),
    ),
  }),
);
export const MigrationRunSchema = Type.Unsafe<MigrationRun>(
  Type.Object({
    id: text,
    status: Type.Union([
      Type.Literal("queued"),
      Type.Literal("adopting"),
      Type.Literal("moving_data"),
      Type.Literal("deploying"),
      Type.Literal("verifying"),
      Type.Literal("awaiting_cutover"),
      Type.Literal("cutover"),
      Type.Literal("partial"),
      Type.Literal("succeeded"),
      Type.Literal("failed"),
      Type.Literal("rolled_back"),
    ]),
    mode: Type.Union([
      Type.Literal("cross_server"),
      Type.Literal("same_server"),
      Type.Literal("project_move"),
      Type.Literal("project_copy"),
    ]),
    confirmationToken: optionalNullableText,
    projectId: optionalNullableText,
    deploymentId: optionalNullableText,
    errorMessage: optionalNullableText,
    logs: optionalNullableText,
    sourceServerId: optionalNullableText,
    targetServerId: optionalNullableText,
    pendingPrompt: Type.Optional(
      Type.Union([
        Type.Null(),
        Type.Object({
          promptId: text,
          title: text,
          message: text,
          actions: Type.Array(Type.Object({ id: text, label: text })),
          expiresAt: optionalText,
        }),
      ]),
    ),
    inputSnapshot: Type.Optional(Type.Union([object, Type.Null()])),
    pendingItems: Type.Optional(
      Type.Array(
        Type.Object({
          key: text,
          kind: Type.Union([Type.Literal("volume"), Type.Literal("bind"), Type.Literal("path")]),
          source: text,
          dest: optionalText,
          serviceName: optionalText,
          reason: Type.Union([
            Type.Literal("missing"),
            Type.Literal("denied"),
            Type.Literal("error"),
          ]),
          message: optionalText,
        }),
      ),
    ),
    targetVolumes: Type.Optional(strings),
  }),
);
const progress = Type.Unsafe<TransferProgress>(
  Type.Object({
    task: text,
    kind: Type.Union([Type.Literal("image"), Type.Literal("volume")]),
    movedBytes: count,
    totalBytes: Type.Union([count, Type.Null()]),
  }),
);
const start = Type.Object({
  success: Type.Literal(true),
  migrationId: ResourceIdSchema,
  confirmationToken: Type.String({ minLength: 1 }),
});
export const MigrationRevealEnvSchema = Type.Object(
  {
    serverId: ResourceIdSchema,
    containerId: ResourceIdSchema,
    keys: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
  },
  { additionalProperties: false },
);
export const MigrationScopedSchemas = {
  listSources: { action: "read", output: Type.Array(ServerDetailSchema) },
  createSource: {
    action: "write",
    input: MigrationRequestSchemas.source,
    output: ServerDetailSchema,
  },
  testSource: {
    action: "write",
    input: MigrationRequestSchemas.source,
    output: Type.Object({ ok: Type.Boolean(), message: text, fingerprint: text }),
  },
  scan: { action: "read", input: MigrationRequestSchemas.scan, output: DiscoveredStackSchema },
  revealEnv: { action: "write", input: MigrationRevealEnvSchema, output: env },
  repoCompose: {
    action: "read",
    input: MigrationRequestSchemas.repoCompose,
    output: Type.Array(
      Type.Unsafe<ComposeRepoService>(
        Type.Object({ name: text, ports: strings, environment: env, dependsOn: strings }),
      ),
    ),
  },
  adopt: {
    action: "write",
    input: MigrationRequestSchemas.adopt,
    output: Type.Unsafe<AdoptResult>(
      Type.Object({
        success: Type.Literal(true),
        projectId: text,
        slug: text,
        created: Type.Boolean(),
        adopted: strings,
      }),
    ),
  },
  reimport: {
    action: "write",
    input: MigrationRequestSchemas.reimport,
    output: Type.Unsafe<ReimportResult>(
      Type.Object({
        success: Type.Literal(true),
        projectId: text,
        slug: text,
        reimported: strings,
        reattached: Type.Boolean(),
      }),
    ),
  },
  preview: {
    action: "read",
    input: MigrationRequestSchemas.preview,
    output: MigrationPreviewSchema,
  },
  start: { action: "write", input: MigrationRequestSchemas.migrate, output: start },
  moveProject: { action: "write", input: MigrationRequestSchemas.project, output: start },
  active: {
    action: "read",
    input: MigrationRequestSchemas.active,
    output: Type.Object({
      success: Type.Literal(true),
      run: Type.Union([MigrationRunSchema, Type.Null()]),
      confirmationToken: nullableText,
    }),
  },
  listRuns: {
    action: "read",
    input: MigrationRequestSchemas.runs,
    output: Type.Array(MigrationRunSchema),
  },
} as const satisfies Record<string, ResourceOperationSchema>;
export const MigrationResourceSchemas = {
  removeSource: { action: "write", output: ok },
  get: {
    action: "read",
    output: Type.Object({
      success: Type.Literal(true),
      run: MigrationRunSchema,
      progress: Type.Optional(Type.Union([progress, Type.Null()])),
    }),
  },
  cutover: { action: "write", input: MigrationRequestSchemas.cutover, output: ok },
  cancel: { action: "write", output: ok },
  respond: { action: "write", input: MigrationRequestSchemas.respond, output: ok },
  resume: { action: "write", input: MigrationRequestSchemas.resume, output: ok },
  cleanupTarget: {
    action: "write",
    output: Type.Object({ success: Type.Literal(true), removed: count }),
  },
  remove: { action: "write", output: ok },
} as const satisfies Record<string, ResourceOperationSchema>;
export interface MigrationOperations
  extends
    ScopedOperations<typeof MigrationScopedSchemas>,
    ResourceOperations<typeof MigrationResourceSchemas> {
  events(id: string, options?: { signal?: AbortSignal }): AsyncIterable<DeploymentEvent>;
  scanEvents(
    input: Static<typeof MigrationRequestSchemas.scan>,
    options?: { signal?: AbortSignal },
  ): AsyncIterable<DeploymentEvent>;
}
