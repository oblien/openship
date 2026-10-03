import { Type, type Static } from "@sinclair/typebox";
import { CreateServerInputSchema } from "./servers";
import { ResourceIdSchema } from "./deployment-resources";
import { UpdateTransferPrefsBody } from "./settings-inputs";

/** One reviewed route in a Docker Compose migration. Paths are HTTP locations. */
export interface MigrationRouteSpec {
  exposedPort?: string;
  domainType: "free" | "custom";
  domain?: string;
  customDomain?: string;
  targetPath?: string;
  exact?: boolean;
}

/** Container ID → routes; legacy service-name keys and single routes are accepted. */
export type MigrationServiceRoutes = Record<string, MigrationRouteSpec | MigrationRouteSpec[]>;

/** HTTP and MCP share the request shape; the migration engine owns normalization. */
const stringMap = Type.Record(Type.String(), Type.String());
const selectedServices = {
  serviceNames: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
  serviceContainerIds: Type.Optional(
    Type.Array(ResourceIdSchema, {
      description:
        "Container IDs from the scan identify services unambiguously across Compose projects.",
    }),
  ),
  flatDocker: Type.Optional(Type.Boolean()),
};
const customPaths = Type.Optional(
  Type.Array(
    Type.Object({
      source: Type.String({ pattern: "^/", description: "Absolute path on the source server." }),
      dest: Type.String({ pattern: "^/", description: "Absolute path on the destination server." }),
    }),
    { maxItems: 50 },
  ),
);
const volumeStrategies = Type.Optional(
  Type.Record(Type.String(), Type.Union([Type.Literal("reuse"), Type.Literal("copy")])),
);
const serviceEnv = Type.Optional(Type.Record(Type.String(), stringMap));
const conflictResolution = Type.Optional(
  Type.Record(
    Type.String(),
    Type.Union([Type.Literal("override"), Type.Literal("clone"), Type.Literal("keep")]),
  ),
);
const routeFields = {
  exposedPort: Type.Optional(Type.String()),
  targetPath: Type.Optional(Type.String()),
  exact: Type.Optional(Type.Boolean()),
};
const route = Type.Union([
  Type.Object({
    ...routeFields,
    domainType: Type.Literal("custom"),
    customDomain: Type.String({ minLength: 1 }),
  }),
  Type.Object({
    ...routeFields,
    domainType: Type.Literal("free"),
    domain: Type.String({ minLength: 1 }),
  }),
]);
const sourceAndTarget = {
  sourceServerId: ResourceIdSchema,
  targetServerId: Type.Optional(ResourceIdSchema),
  ...selectedServices,
  customPaths,
};

/** Intentionally excludes agent, key paths, jump hosts and local SSH options. */
export const MigrationSourceInputSchema = Type.Object({
  ...Type.Pick(CreateServerInputSchema, ["name", "sshHost", "sshPort", "sshUser"]).properties,
  sshHost: Type.String({ minLength: 1, maxLength: 253 }),
  sshAuthMethod: Type.Union([Type.Literal("password"), Type.Literal("key")]),
  sshPassword: Type.Optional(Type.String({ minLength: 1, maxLength: 4096 })),
  sshPrivateKey: Type.Optional(Type.String({ minLength: 1, maxLength: 65536 })),
  sshKeyPassphrase: Type.Optional(Type.String({ maxLength: 4096 })),
}, { additionalProperties: false });
export type MigrationSourceInput = Static<typeof MigrationSourceInputSchema>;

export const MigrationRequestSchemas = {
  source: MigrationSourceInputSchema,
  scan: Type.Object({ serverId: ResourceIdSchema, flatDocker: selectedServices.flatDocker }),
  repoCompose: Type.Object({
    owner: Type.String({ minLength: 1 }),
    repo: Type.String({ minLength: 1 }),
    branch: Type.Optional(Type.String()),
  }),
  adopt: Type.Object({
    serverId: ResourceIdSchema,
    projectName: Type.String({ minLength: 1 }),
    ...selectedServices,
    composeProject: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    volumeStrategies,
    serviceSubpaths: Type.Optional(stringMap),
    serviceEnv,
  }),
  reimport: Type.Object({
    serverId: ResourceIdSchema,
    projectId: ResourceIdSchema,
    projectName: Type.Optional(Type.String()),
    serviceNames: Type.Optional(Type.Array(Type.String())),
  }),
  preview: Type.Object(sourceAndTarget),
  migrate: Type.Object({
    ...sourceAndTarget,
    projectName: Type.String({ minLength: 1 }),
    killOriginals: Type.Optional(
      Type.Boolean({
        description:
          "Defaults to false: pause for explicit cutover. True authorizes automatic retirement of the original containers after verification.",
      }),
    ),
    ...UpdateTransferPrefsBody.properties,
    volumeStrategies,
    serviceSubpaths: Type.Optional(stringMap),
    serviceRenames: Type.Optional(stringMap),
    serviceEnv,
    gitSource: Type.Optional(
      Type.Object({
        provider: Type.Literal("github"),
        owner: Type.String({ minLength: 1 }),
        repo: Type.String({ minLength: 1 }),
        branch: Type.Optional(Type.String()),
      }),
    ),
    routesByServiceName: Type.Optional(
      Type.Record(Type.String(), Type.Union([route, Type.Array(route)]), {
        description:
          "Prefer scan container IDs as keys; legacy service names are accepted. These routes are saved and published by the migration.",
      }),
    ),
    conflictResolution,
  }),
  project: Type.Object({
    projectId: ResourceIdSchema,
    targetServerId: ResourceIdSchema,
    intent: Type.Optional(Type.Union([Type.Literal("move"), Type.Literal("copy")])),
    newName: Type.Optional(Type.String()),
    serviceNames: Type.Optional(Type.Array(Type.String())),
    ...UpdateTransferPrefsBody.properties,
    conflictResolution,
    customPaths,
  }),
  cutover: Type.Object({
    confirmationToken: Type.String({ minLength: 1 }),
    kill: Type.Optional(Type.Boolean()),
  }),
  respond: Type.Object({ promptId: ResourceIdSchema, action: Type.String({ minLength: 1 }) }),
  resume: Type.Object({
    overrides: Type.Optional(stringMap),
    skip: Type.Optional(Type.Array(Type.String())),
  }),
  active: Type.Object({ serverId: ResourceIdSchema }, { additionalProperties: false }),
  runs: Type.Union([
    Type.Object(
      { serverId: ResourceIdSchema, projectId: Type.Optional(ResourceIdSchema) },
      { additionalProperties: false },
    ),
    Type.Object(
      { projectId: ResourceIdSchema, serverId: Type.Optional(ResourceIdSchema) },
      { additionalProperties: false },
    ),
  ]),
} as const;
