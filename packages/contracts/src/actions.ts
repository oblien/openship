import { Type, type Static } from "@sinclair/typebox";
import { ACTIONS_MAX_WORKFLOW_BYTES } from "@repo/core";
import type {
  ResourceOperationSchema,
  ResourceOperations,
  ScopedOperations,
} from "./resource-operations";

const nullable = (schema: ReturnType<typeof Type.String>) => Type.Union([schema, Type.Null()]);
const date = nullable(Type.String());
const id = Type.String({ minLength: 1, maxLength: 128, pattern: "^[A-Za-z0-9_-]+$" });
const owner = Type.String({ minLength: 1, maxLength: 100, pattern: "^[A-Za-z0-9_-]+$" });
const repo = Type.String({ minLength: 1, maxLength: 100, pattern: "^[A-Za-z0-9_.-]+$" });
const path = Type.String({
  maxLength: 200,
  pattern: "^\\.(github|openship)/workflows/[A-Za-z0-9_.-]+\\.ya?ml$",
});
const ref = Type.String({ minLength: 1, maxLength: 256, pattern: "^[A-Za-z0-9_./-]+$" });
const strings = Type.Record(
  Type.String({ pattern: "^[A-Za-z_][A-Za-z0-9_]*$" }),
  Type.String({ maxLength: 65536 }),
  { maxProperties: 100 },
);
export const ActionStatusSchema = Type.Union(
  (
    [
      "queued",
      "waiting",
      "running",
      "cancelling",
      "success",
      "failure",
      "cancelled",
      "skipped",
      "timed_out",
    ] as const
  ).map((s) => Type.Literal(s)),
);
export const ActionRunnerConfigSchema = Type.Object(
  {
    mode: Type.Union([Type.Literal("container"), Type.Literal("native")]),
    labels: Type.Array(
      Type.String({ pattern: "^[A-Za-z0-9_.-]+$", minLength: 1, maxLength: 100 }),
      { maxItems: 20, uniqueItems: true },
    ),
    image: Type.Union([
      Type.String({ maxLength: 300, pattern: "^[A-Za-z0-9][A-Za-z0-9._/@:-]+$" }),
      Type.Null(),
    ]),
    maxParallel: Type.Integer({ minimum: 1, maximum: 16 }),
    cpu: Type.Number({ minimum: 0.25, maximum: 128 }),
    memoryMb: Type.Integer({ minimum: 256, maximum: 524288 }),
    allowDockerSocket: Type.Boolean(),
    cloudDiskGb: Type.Optional(Type.Integer({ minimum: 10, maximum: 256 })),
  },
  { additionalProperties: false },
);
export const ActionCapabilitiesSchema = Type.Object(
  {
    os: Type.Union([Type.Literal("linux"), Type.Literal("macos")]),
    architecture: Type.Union([Type.Literal("x64"), Type.Literal("arm64")]),
    docker: Type.Boolean(),
    dockerArchitecture: Type.Optional(Type.Union([Type.Literal("x64"), Type.Literal("arm64")])),
    dockerPlatforms: Type.Optional(
      Type.Array(Type.Union([Type.Literal("linux/amd64"), Type.Literal("linux/arm64")]), {
        uniqueItems: true,
        maxItems: 2,
      }),
    ),
    git: Type.Boolean(),
    node: Type.Boolean(),
    distribution: nullable(Type.String()),
    version: nullable(Type.String()),
  },
  { additionalProperties: false },
);
export const ActionRunnerSchema = Type.Object(
  {
    id,
    name: Type.String(),
    serverId: nullable(Type.String()),
    kind: Type.Union([Type.Literal("server"), Type.Literal("cloud")]),
    config: ActionRunnerConfigSchema,
    capabilities: Type.Union([ActionCapabilitiesSchema, Type.Null()]),
    enabled: Type.Boolean(),
    checkedAt: date,
    error: nullable(Type.String()),
    labels: Type.Array(Type.String()),
  },
  { additionalProperties: false },
);
export const ActionWorkflowInput = Type.Object(
  {
    name: Type.String({ minLength: 1, maxLength: 100 }),
    owner: nullable(owner),
    repo: nullable(repo),
    path,
    ref,
    /** Null applies repository updates automatically; a string pins the reviewed YAML. */
    source: Type.Optional(
      Type.Union([
        Type.String({ minLength: 1, maxLength: ACTIONS_MAX_WORKFLOW_BYTES }),
        Type.Null(),
      ]),
    ),
    runnerIds: Type.Array(id, { minItems: 1, maxItems: 20, uniqueItems: true }),
    storageDestinationId: Type.Optional(nullable(id)),
    variables: Type.Optional(strings),
    secrets: Type.Optional(strings),
    removeSecrets: Type.Optional(Type.Array(Type.String(), { maxItems: 100 })),
    enabled: Type.Optional(Type.Boolean()),
    allowForks: Type.Optional(Type.Boolean()),
    projectIds: Type.Optional(Type.Array(id, { maxItems: 50, uniqueItems: true })),
  },
  { additionalProperties: false },
);
const plannedJob = Type.Object({
  id: Type.String(),
  name: Type.String(),
  needs: Type.Array(Type.String()),
  runsOn: Type.Unknown(),
  requiresDocker: Type.Boolean(),
});
export const ActionPlanSchema = Type.Object(
  {
    name: Type.String(),
    triggers: Type.Array(Type.String()),
    triggerRules: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
    jobs: Type.Array(plannedJob),
    inputs: Type.Array(
      Type.Object({
        name: Type.String(),
        type: Type.String(),
        description: Type.String(),
        required: Type.Boolean(),
        default: Type.String(),
        options: Type.Array(Type.String()),
      }),
    ),
  },
  { additionalProperties: false },
);
export const ActionWorkflowSchema = Type.Object(
  {
    id,
    name: Type.String(),
    owner: nullable(owner),
    repo: nullable(repo),
    path,
    ref,
    source: nullable(Type.String()),
    runnerIds: Type.Array(Type.String()),
    storageDestinationId: nullable(id),
    variables: strings,
    plan: ActionPlanSchema,
    lastError: nullable(Type.String()),
    secretNames: Type.Array(Type.String()),
    enabled: Type.Boolean(),
    allowForks: Type.Boolean(),
    createdAt: Type.String(),
    updatedAt: Type.String(),
    projectIds: Type.Optional(Type.Array(id)),
  },
  { additionalProperties: false },
);
export const ActionJobSchema = Type.Object(
  {
    id,
    jobKey: Type.String(),
    name: Type.String(),
    matrixIndex: Type.Number(),
    matrix: Type.Record(Type.String(), Type.Unknown()),
    labels: Type.Array(Type.String()),
    status: ActionStatusSchema,
    phase: Type.Union([
      Type.Literal("queued"),
      Type.Literal("provisioning"),
      Type.Literal("running"),
      Type.Literal("finished"),
    ]),
    runnerId: nullable(Type.String()),
    startedAt: date,
    finishedAt: date,
    cleanedAt: date,
    error: nullable(Type.String()),
    checkRunId: nullable(Type.String()),
    checkError: nullable(Type.String()),
    logBytes: Type.Number(),
    lastEventSequence: Type.Number(),
    outputs: Type.Record(Type.String(), Type.String()),
    steps: Type.Record(
      Type.String(),
      Type.Object({ outcome: Type.String(), conclusion: Type.String() }),
    ),
  },
  { additionalProperties: false },
);
export const ActionRunSchema = Type.Object(
  {
    id,
    workflowId: Type.String(),
    name: Type.String(),
    number: Type.Number(),
    attempt: Type.Number(),
    status: ActionStatusSchema,
    owner: nullable(owner),
    repo: nullable(repo),
    revision: Type.String(),
    ref: Type.String(),
    eventName: Type.String(),
    actor: Type.String(),
    untrusted: Type.Boolean(),
    approvedAt: date,
    cancelRequestedAt: date,
    error: nullable(Type.String()),
    startedAt: date,
    finishedAt: date,
    createdAt: Type.String(),
    settledAt: date,
    plan: ActionPlanSchema,
    jobs: Type.Array(ActionJobSchema),
  },
  { additionalProperties: false },
);
const runnerInput = Type.Object(
  {
    serverId: id,
    name: Type.String({ minLength: 1, maxLength: 100 }),
    config: ActionRunnerConfigSchema,
    enabled: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);
const success = Type.Object({ success: Type.Literal(true) });
const event = Type.Object({
  version: Type.Literal(1),
  sequence: Type.Integer(),
  type: Type.String(),
  time: Type.String(),
  level: Type.Optional(Type.String()),
  message: Type.Optional(Type.String()),
  step: Type.Optional(Type.String()),
  stepId: Type.Optional(Type.String()),
  stage: Type.Optional(Type.String()),
  stepResult: Type.Optional(Type.String()),
  jobResult: Type.Optional(Type.String()),
  result: Type.Optional(Type.Unknown()),
});
export const ActionProjectSchema = Type.Object({
  id,
  name: Type.String(),
  owner: nullable(owner),
  repo: nullable(repo),
  branch: nullable(Type.String()),
});
export const ActionDeploymentRequestSchema = Type.Object({
  id,
  projectId: id,
  revision: Type.String(),
  ref: Type.String(),
  status: Type.String(),
  error: nullable(Type.String()),
  deploymentId: nullable(id),
  createdAt: Type.String(),
  workflowIds: Type.Array(id),
});
export const ActionProjectPolicySchema = Type.Object({
  project: ActionProjectSchema,
  mode: Type.Union([Type.Literal("manual"), Type.Literal("push"), Type.Literal("actions")]),
  workflowIds: Type.Array(id),
  requiredWorkflowIds: Type.Array(id),
  requests: Type.Array(ActionDeploymentRequestSchema),
});
export const ActionCollectionSchemas = {
  list: {
    action: "read",
    input: Type.Object({ projectId: Type.Optional(id) }),
    optionalInput: true,
    output: Type.Array(ActionWorkflowSchema),
  },
  create: { action: "write", input: ActionWorkflowInput, output: ActionWorkflowSchema },
  listRuns: {
    action: "read",
    input: Type.Object({
      workflowId: Type.Optional(id),
      projectId: Type.Optional(id),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
    }),
    optionalInput: true,
    output: Type.Array(ActionRunSchema),
  },
  runners: { action: "read", output: Type.Array(ActionRunnerSchema) },
  addRunner: { action: "admin", input: runnerInput, output: ActionRunnerSchema },
  inspectDestination: {
    action: "admin",
    input: Type.Object({ serverId: id }),
    output: ActionCapabilitiesSchema,
  },
  enableEmulation: {
    action: "admin",
    input: Type.Object({ serverId: id }, { additionalProperties: false }),
    output: ActionCapabilitiesSchema,
  },
  preview: {
    action: "read",
    input: Type.Object({
      source: Type.String({ maxLength: ACTIONS_MAX_WORKFLOW_BYTES }),
      path: Type.Optional(path),
    }),
    output: ActionPlanSchema,
  },
  discover: {
    action: "read",
    input: Type.Object({ owner, repo, ref }),
    output: Type.Array(Type.Object({ path: Type.String(), name: Type.String() })),
  },
  repositorySource: {
    action: "read",
    input: Type.Object({ owner, repo, ref, path }),
    output: Type.Object({
      source: Type.String(),
      sha: Type.String(),
      plan: Type.Union([ActionPlanSchema, Type.Null()]),
      error: nullable(Type.String()),
    }),
  },
  updateRepositorySource: {
    action: "write",
    input: Type.Object({
      owner,
      repo,
      ref,
      path,
      sha: Type.String({ pattern: "^[a-f0-9]{40,64}$" }),
      source: Type.String({ maxLength: ACTIONS_MAX_WORKFLOW_BYTES }),
    }),
    output: Type.Object({ sha: Type.String(), commit: Type.String() }),
  },
  projects: { action: "read", output: Type.Array(ActionProjectSchema) },
  projectPolicy: {
    action: "read",
    input: Type.Object({ projectId: id }),
    output: ActionProjectPolicySchema,
  },
  updateProjectPolicy: {
    action: "write",
    input: Type.Object({
      projectId: id,
      mode: ActionProjectPolicySchema.properties.mode,
      workflowIds: Type.Array(id, { maxItems: 50, uniqueItems: true }),
      requiredWorkflowIds: Type.Array(id, { maxItems: 20, uniqueItems: true }),
    }),
    output: ActionProjectPolicySchema,
  },
  updateDeploymentRequest: {
    action: "write",
    input: Type.Object({
      projectId: id,
      requestId: id,
      action: Type.Union([Type.Literal("retry"), Type.Literal("cancel")]),
      idempotencyKey: Type.String({ minLength: 8, maxLength: 128, pattern: "^[A-Za-z0-9_-]+$" }),
    }),
    output: ActionProjectPolicySchema,
  },
} as const satisfies Record<string, ResourceOperationSchema>;
export const ActionResourceSchemas = {
  get: { action: "read", output: ActionWorkflowSchema },
  update: { action: "write", input: ActionWorkflowInput, output: ActionWorkflowSchema },
  remove: { action: "write", output: success },
  dispatch: {
    action: "write",
    input: Type.Object({
      ref: Type.Optional(ref),
      inputs: Type.Optional(strings),
      /** Authenticated external events share dispatch permissions and idempotency. */
      eventType: Type.Optional(
        Type.String({ minLength: 1, maxLength: 100, pattern: "^[A-Za-z0-9_.-]+$" }),
      ),
      clientPayload: Type.Optional(
        Type.Record(Type.String(), Type.Unknown(), { maxProperties: 100 }),
      ),
      idempotencyKey: Type.String({ minLength: 8, maxLength: 128, pattern: "^[A-Za-z0-9_-]+$" }),
    }),
    output: ActionRunSchema,
  },
  getRun: { action: "read", output: ActionRunSchema },
  artifacts: {
    action: "read",
    output: Type.Array(
      Type.Object({
        id: Type.Integer(),
        name: Type.String(),
        size: Type.Number(),
        createdAt: Type.String(),
        expiresAt: Type.String(),
      }),
    ),
  },
  artifactDownload: {
    action: "read",
    input: Type.Object({ artifactId: Type.Integer({ minimum: 1 }) }),
    output: Type.Object({ url: Type.String() }),
  },
  cancel: { action: "write", output: ActionRunSchema },
  approve: { action: "admin", output: ActionRunSchema },
  rerun: {
    action: "write",
    input: Type.Object({
      idempotencyKey: Type.String({ minLength: 8, maxLength: 128, pattern: "^[A-Za-z0-9_-]+$" }),
    }),
    output: ActionRunSchema,
  },
  updateRunner: { action: "admin", input: runnerInput, output: ActionRunnerSchema },
  removeRunner: { action: "admin", output: success },
  probeRunner: { action: "admin", output: ActionRunnerSchema },
  jobEvents: {
    action: "read",
    input: Type.Object({ after: Type.Optional(Type.Integer({ minimum: 0, maximum: 2147483647 })) }),
    optionalInput: true,
    output: Type.Object({
      events: Type.Array(event),
      next: Type.Integer(),
      complete: Type.Boolean(),
    }),
  },
} as const satisfies Record<string, ResourceOperationSchema>;
export type ActionWorkflowView = Static<typeof ActionWorkflowSchema>;
export type ActionRunView = Static<typeof ActionRunSchema>;
export type ActionJobView = Static<typeof ActionJobSchema>;
export type ActionRunnerView = Static<typeof ActionRunnerSchema>;
export type CreateActionWorkflow = Static<typeof ActionWorkflowInput>;
export type ActionPlanView = Static<typeof ActionPlanSchema>;
export type ActionProjectPolicy = Static<typeof ActionProjectPolicySchema>;
export type ActionProjectView = Static<typeof ActionProjectSchema>;
export interface ActionOperations
  extends
    ScopedOperations<typeof ActionCollectionSchemas>,
    ResourceOperations<typeof ActionResourceSchemas> {}
