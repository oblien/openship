import { Type, type Static } from "@sinclair/typebox";
import {
  CreateProjectEnvironmentBody,
  MergeEnvVarsBody,
  ResourceTierEnum,
  SetBranchBody,
  SetOptionsBody,
  SetSleepModeBody,
  UpdateResourcesBody,
  LinkRepoBody,
  SourceProviderEnum,
  SetReleaseSourceBody,
  SetAutoDeployBody,
} from "./project-inputs";
import { DeploymentHistoryFilters, DeploymentLogsSchema, DeploymentPageSchema, LogEntrySchema } from "./deployment-resources";
import { AppError } from "@repo/core";
import { ProjectSchema } from "./projects";
import type { ResourceOperationSchema, ResourceOperations } from "./resource-operations";
import { ProjectIntegrationSchemas } from "./project-integrations";
import { ProjectRoutingSchemas } from "./project-routing";
import { ProjectLogSchemas } from "./project-logs";
import { ProjectTransferSchemas } from "./project-transfer";
import { AppProjectSchemas } from "./apps";
import { ProjectClusterSchemas } from "./project-cluster";
import { ProjectDatabaseSchemas } from "./cluster-database";
import { BranchPageInput, BranchPaginationSchema } from "./github";

const nullableString = Type.Union([Type.String(), Type.Null()]);
export const ProjectEnvironmentSchema = Type.Object({
  id: Type.String({ minLength: 1 }),
  name: Type.String(),
  slug: Type.String(),
  type: Type.String(),
  gitBranch: Type.String(),
  projectSlug: Type.String(),
  activeDeploymentId: Type.Optional(nullableString),
  latestDeploymentStatus: nullableString,
  primaryDomain: Type.Optional(nullableString),
  version: nullableString,
  isApp: Type.Boolean(),
  gitProvider: Type.Union([SourceProviderEnum(), Type.Null()]),
});
export type ProjectEnvironment = Static<typeof ProjectEnvironmentSchema>;
export const EnvironmentVariableSchema = Type.Object({
  id: Type.String({ minLength: 1 }),
  key: Type.String(),
  value: Type.String(),
  environment: Type.String(),
  isSecret: Type.Boolean(),
  createdAt: Type.String(),
  updatedAt: Type.String(),
});
export type EnvironmentVariable = Static<typeof EnvironmentVariableSchema>;
const ResourceValuesSchema = Type.Object({
  cpuCores: Type.Number(),
  memoryMb: Type.Number(),
  diskMb: Type.Number(),
});
export const ProjectResourcesSchema = Type.Object({
  production: ResourceValuesSchema,
  build: ResourceValuesSchema,
  sleepMode: Type.String(),
  port: Type.Number(),
  tier: ResourceTierEnum(),
  requiresLimit: Type.Boolean(),
  capacity: Type.Optional(
    Type.Object({
      cpuCores: Type.Number(),
      memoryMb: Type.Number(),
      source: Type.Union([Type.Literal("docker"), Type.Literal("local"), Type.Literal("unknown")]),
    }),
  ),
});
export const CloneTokenStateSchema = Type.Object({
  hasToken: Type.Boolean(),
  setAt: nullableString,
});
export const UpdateCloneTokenSchema = Type.Object({
  token: Type.Union([Type.String({ maxLength: 16384 }), Type.Null()]),
});
export const ProjectDeletionPreviewSchema = Type.Object({
  projectId: Type.String(),
  projectName: Type.String(),
  selfHosted: Type.Boolean(),
  services: Type.Array(
    Type.Object({
      id: Type.String(),
      name: Type.String(),
      image: nullableString,
      volumes: Type.Array(Type.String()),
      hasContainer: Type.Boolean(),
    }),
  ),
  deploymentVolumes: Type.Array(Type.String()),
  networks: Type.Array(Type.String()),
  totalVolumes: Type.Number(),
});
const message = Type.Object({ success: Type.Boolean(), message: Type.String() });

export const RemoveProjectSchema = Type.Object({
  force: Type.Optional(Type.Boolean()),
  forceOrphan: Type.Optional(Type.Boolean()),
  wipeVolumes: Type.Optional(Type.Boolean()),
  recordOnly: Type.Optional(Type.Boolean()),
});
export type RemoveProjectInput = Static<typeof RemoveProjectSchema>;
export function normalizeProjectDeleteOptions(input: RemoveProjectInput) {
  const options = {
    force: !!input.force || !!input.forceOrphan,
    forceOrphan: !!input.forceOrphan,
    wipeVolumes: !!input.wipeVolumes,
    recordOnly: !!input.recordOnly,
  };
  if (options.recordOnly && (options.wipeVolumes || options.forceOrphan))
    throw new AppError(
      "recordOnly cannot be combined with wipeVolumes or forceOrphan",
      400,
      "INVALID_DELETE_OPTIONS",
    );
  return options;
}
export const ProjectTeardownStepSchema = Type.Object({
  step: Type.String(),
  status: Type.Union([Type.Literal("ok"), Type.Literal("failed"), Type.Literal("skipped")]),
  details: Type.Optional(Type.String()),
  error: Type.Optional(Type.String()),
});
export const RemoveProjectResultSchema = Type.Object({
  ok: Type.Boolean(),
  message: Type.String(),
  steps: Type.Array(ProjectTeardownStepSchema),
  unrecoverable: Type.Optional(Type.Array(ProjectTeardownStepSchema)),
  orphaned: Type.Optional(
    Type.Array(Type.Object({ ref: Type.String(), label: Type.String(), serverId: nullableString })),
  ),
  unlinked: Type.Optional(
    Type.Array(
      Type.Object({
        linkId: Type.String(),
        projectId: Type.String(),
        projectName: Type.String(),
        envKey: Type.String(),
      }),
    ),
  ),
});
export type RemoveProjectResult = Static<typeof RemoveProjectResultSchema>;

const webhookStrategy = Type.Union([
  Type.Literal("app"),
  Type.Literal("domain"),
  Type.Literal("repo"),
  Type.Literal("none"),
]);
export const ProjectGitInfoSchema = Type.Union([
  Type.Object({
    success: Type.Literal(false),
    error: Type.String(),
    code: Type.Literal("NO_REPOSITORY"),
  }),
  Type.Object({
    success: Type.Literal(true),
    owner: Type.String(),
    repo: Type.String(),
    branch: Type.String(),
    provider: Type.String(),
    commits: Type.Array(
      Type.Object({
        sha: Type.String(),
        message: Type.String(),
        author: Type.String(),
        author_avatar: Type.String(),
        date: Type.String(),
        url: Type.String(),
      }),
    ),
    auto_deploy: Type.Boolean(),
    webhook_strategy: webhookStrategy,
    webhook_active: Type.Boolean(),
    webhook_domain: nullableString,
    available_strategies: Type.Array(webhookStrategy),
    verified_domains: Type.Array(Type.Object({ hostname: Type.String(), ssl: Type.Boolean() })),
    installation_installed: Type.Boolean(),
    install_url: Type.Optional(Type.String()),
    default_rollback_strategy: Type.String(),
  }),
]);
export const ProjectDetailsSchema = Type.Object({
  project: Type.Intersect([
    ProjectSchema,
    Type.Object({
      serviceCount: Type.Integer({ minimum: 0 }),
      hasMultipleServices: Type.Boolean(),
      projectType: Type.Union([
        Type.Literal("app"),
        Type.Literal("services"),
        Type.Literal("monorepo"),
      ]),
      latestDeploymentId: nullableString,
      latestDeploymentStatus: nullableString,
      latestDeploymentBlocked: Type.Boolean(),
      webhookStrategy: Type.Union([webhookStrategy, Type.Null()]),
      webhookActive: Type.Boolean(),
      options: Type.Object({
        buildCommand: Type.String(),
        outputDirectory: Type.String(),
        productionPaths: Type.String(),
        installCommand: Type.String(),
        startCommand: Type.String(),
        productionPort: Type.String(),
        hasServer: Type.Boolean(),
        hasBuild: Type.Boolean(),
        workloadType: Type.Union([
          Type.Literal("web"),
          Type.Literal("worker"),
          Type.Literal("static"),
        ]),
        rootDirectory: Type.String(),
        volumes: Type.Union([Type.Array(Type.String()), Type.Null()]),
        resolvedVolumes: Type.Array(Type.String()),
        isLoading: Type.Boolean(),
        error: Type.Null(),
      }),
    }),
  ]),
  environments: Type.Array(ProjectEnvironmentSchema),
});
export type ProjectDetails = Static<typeof ProjectDetailsSchema>;
export const ProjectPendingActionSchema = Type.Object({
  id: Type.String(),
  kind: Type.Union(
    (
      [
        "deploy_blocked",
        "prompt",
        "partial_decision",
        "routing_unsynced",
        "domain_unverified",
        "ssl_error",
        "port_advisory",
        "routing_rules_dropped",
      ] as const
    ).map((value) => Type.Literal(value)),
  ),
  severity: Type.Union([Type.Literal("action_required"), Type.Literal("advisory")]),
  title: Type.String(),
  message: Type.String(),
  details: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  expiresAt: Type.Optional(Type.String()),
  resolveWith: Type.Array(
    Type.Object({
      label: Type.String(),
      destructive: Type.Optional(Type.Boolean()),
      method: Type.Union([Type.Literal("POST"), Type.Literal("DELETE")]),
      path: Type.String(),
      body: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
    }),
  ),
});
const nullableNumber = Type.Union([Type.Number(), Type.Null()]);
const driftBase = {
  supported: Type.Literal(true),
  behind: Type.Boolean(),
  latestInProgress: Type.Boolean(),
};
export const ProjectDriftSchema = Type.Union([
  Type.Object({ supported: Type.Literal(false) }),
  Type.Object({
    ...driftBase,
    mode: Type.Literal("commit"),
    branch: Type.String(),
    latestSha: nullableString,
    latestMessage: nullableString,
    deployedSha: nullableString,
  }),
  Type.Object({
    ...driftBase,
    mode: Type.Literal("release"),
    latestVersion: nullableString,
    currentVersion: nullableString,
    pinned: Type.Boolean(),
  }),
  Type.Object({
    ...driftBase,
    mode: Type.Literal("image"),
    services: Type.Array(
      Type.Object({
        serviceId: Type.String(),
        name: Type.String(),
        ref: Type.String(),
        deployedDigest: nullableString,
        latestDigest: nullableString,
        behind: Type.Boolean(),
      }),
    ),
  }),
]);

export const ProjectControlSchemas = {
  ...ProjectDatabaseSchemas,
  ...AppProjectSchemas,
  ...ProjectTransferSchemas,
  ...ProjectLogSchemas,
  ...ProjectIntegrationSchemas,
  ...ProjectRoutingSchemas,
  remove: {
    action: "admin",
    input: RemoveProjectSchema,
    optionalInput: true,
    output: RemoveProjectResultSchema,
  },
  getInfo: { action: "read", output: ProjectDetailsSchema },
  getGitInfo: { action: "read", output: ProjectGitInfoSchema },
  listBranches: {
    action: "read",
    input: BranchPageInput,
    optionalInput: true,
    output: Type.Object({
      data: Type.Array(Type.Object({ name: Type.String(), sha: Type.String(), protected: Type.Boolean() })),
      pagination: BranchPaginationSchema,
    }),
  },
  linkRepo: {
    action: "write",
    input: LinkRepoBody,
    output: Type.Object({
      success: Type.Boolean(),
      owner: Type.String(),
      repo: Type.String(),
      branch: Type.String(),
      webhook_strategy: webhookStrategy,
      auto_deploy: Type.Boolean(),
    }),
  },
  setReleaseImageSource: { action: "write", input: SetReleaseSourceBody, output: ProjectSchema },
  setAutoDeploy: {
    action: "write",
    input: SetAutoDeployBody,
    output: Type.Object({
      success: Type.Boolean(),
      auto_deploy: Type.Boolean(),
      webhook_strategy: webhookStrategy,
    }),
  },
  setWebhookDomain: {
    action: "write",
    input: Type.Object({ domain: nullableString }),
    output: Type.Object({
      success: Type.Boolean(),
      webhook_domain: nullableString,
      webhook_url: Type.Optional(Type.String()),
    }),
  },
  listDeployments: {
    action: "read",
    input: Type.Object({
      ...DeploymentHistoryFilters,
      page: Type.Optional(Type.Integer({ minimum: 1 })),
      perPage: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000 })),
      environment: Type.Optional(Type.String()),
    }),
    optionalInput: true,
    output: DeploymentPageSchema,
  },
  deploymentSession: {
    action: "read",
    output: Type.Object({
      session: Type.Union([
        Type.Null(),
        Type.Object({
          id: Type.String(),
          deploymentId: nullableString,
          status: Type.String(),
          durationMs: nullableNumber,
        }),
      ]),
    }),
  },
  clearBuildCache: {
    action: "admin",
    output: Type.Object({
      success: Type.Boolean(),
      hostScoped: Type.Literal(true),
      target: Type.String(),
      serverId: nullableString,
      cachesDeleted: Type.Integer(),
      bytesReclaimed: Type.Number(),
    }),
  },
  getRollbackCapacity: {
    action: "read",
    output: Type.Object({
      window: Type.Integer(),
      source: Type.Union([Type.Literal("explicit"), Type.Literal("instance-default")]),
      explicit: nullableNumber,
      snapshotSizeBytes: nullableNumber,
      measuredAt: nullableString,
      diskFreeBytes: nullableNumber,
      diskTotalBytes: nullableNumber,
      maxWindow: Type.Integer(),
      diskBudgetFraction: Type.Number(),
      strategy: Type.String(),
    }),
  },
  checkPorts: {
    action: "read",
    output: Type.Array(
      Type.Object({
        port: Type.Number(),
        listening: Type.Boolean(),
        checked: Type.Boolean(),
        serviceId: Type.Optional(Type.String()),
        serviceName: Type.Optional(Type.String()),
        skippedReason: Type.Optional(Type.String()),
      }),
    ),
  },
  checkOutput: {
    action: "read",
    output: Type.Array(
      Type.Object({
        path: Type.String(),
        servedPath: Type.Optional(Type.String()),
        found: Type.Boolean(),
        hasIndex: Type.Boolean(),
        checked: Type.Boolean(),
        status: Type.Optional(Type.Number()),
        served: Type.Optional(Type.Boolean()),
      }),
    ),
  },
  getPendingActions: {
    action: "read",
    output: Type.Object({ actions: Type.Array(ProjectPendingActionSchema) }),
  },
  getCommitStatus: { action: "read", output: ProjectDriftSchema },
  listEnvironments: { action: "read", output: Type.Array(ProjectEnvironmentSchema) },
  createEnvironment: {
    action: "write",
    input: CreateProjectEnvironmentBody,
    output: ProjectEnvironmentSchema,
  },
  listEnvVars: {
    action: "read",
    input: Type.Object({ environment: Type.Optional(Type.String()) }),
    optionalInput: true,
    output: Type.Array(EnvironmentVariableSchema),
  },
  mergeEnvVars: {
    action: "write",
    input: MergeEnvVarsBody,
    output: Type.Object({ upserted: Type.Integer(), deleted: Type.Integer(), warnings: Type.Optional(Type.Array(Type.String())) }),
  },
  getResources: { action: "read", output: ProjectResourcesSchema },
  ...ProjectClusterSchemas,
  updateResources: { action: "write", input: UpdateResourcesBody, output: ProjectResourcesSchema },
  setSleepMode: {
    action: "write",
    input: SetSleepModeBody,
    output: Type.Object({ success: Type.Boolean(), sleepMode: Type.String() }),
  },
  setOptions: { action: "write", input: SetOptionsBody, output: ProjectSchema },
  setBranch: {
    action: "write",
    input: SetBranchBody,
    output: Type.Object({ success: Type.Boolean(), branch: Type.String() }),
  },
  enable: { action: "write", output: message },
  disable: { action: "write", output: message },
  retryRouting: {
    action: "write",
    output: Type.Object({
      ok: Type.Boolean(),
      error: Type.Optional(Type.String()),
      warning: Type.Optional(Type.String()),
    }),
  },
  runtimeLogs: {
    action: "read",
    input: DeploymentLogsSchema,
    optionalInput: true,
    output: Type.Array(LogEntrySchema),
  },
  getCloneToken: { action: "read", output: CloneTokenStateSchema },
  updateCloneToken: {
    action: "admin",
    input: UpdateCloneTokenSchema,
    output: CloneTokenStateSchema,
  },
  deletionPreview: { action: "read", output: ProjectDeletionPreviewSchema },
} as const satisfies Record<string, ResourceOperationSchema>;
export type ProjectControlOperations = ResourceOperations<typeof ProjectControlSchemas>;
export type RollbackCapacity = Static<typeof ProjectControlSchemas.getRollbackCapacity.output>;
