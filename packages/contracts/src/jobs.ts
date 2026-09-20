import { Type, type Static } from "@sinclair/typebox";
import { CreateJobBody, UpdateJobBody } from "./job-inputs";
import type { DeploymentEvent } from "./deployment-resources";
import type { ResourceOperationSchema, ResourceOperations, ScopedOperations } from "./resource-operations";

const nullableString = Type.Union([Type.String(), Type.Null()]);
const object = Type.Record(Type.String(), Type.Unknown());
export const JobRunSchema = Type.Object({
  id: Type.String(), jobId: Type.String(), kind: Type.String(), trigger: Type.String(), status: Type.String(), serverId: nullableString,
  serverIds: Type.Optional(Type.Union([Type.Array(Type.String()), Type.Null()])),
  attempt: Type.Number(), startedAt: Type.String(), finishedAt: nullableString, durationMs: Type.Union([Type.Number(), Type.Null()]),
  summary: Type.Union([object, Type.Null()]), output: nullableString, error: nullableString, createdAt: Type.String(),
}, { additionalProperties: false });
const actionConfig = Type.Object({
  serverId: Type.Optional(Type.String()), serverIds: Type.Optional(Type.Array(Type.String())), command: Type.Optional(Type.String()),
  timeoutMs: Type.Optional(Type.Number()), retry: Type.Optional(Type.Object({ maxAttempts: Type.Number(), backoffSeconds: Type.Number() })),
  env: Type.Optional(Type.Record(Type.String(), Type.String())), secrets: Type.Optional(Type.Record(Type.String(), Type.Literal(""))),
}, { additionalProperties: false });
export const JobSchema = Type.Object({
  id: Type.String(), key: Type.String(), kind: Type.String(), label: Type.String(), cronExpression: nullableString,
  scheduleType: Type.String(), runAt: nullableString, enabled: Type.Boolean(), actionType: Type.String(),
  actionConfig: Type.Union([actionConfig, Type.Null()]), dependsOn: Type.Union([Type.Array(Type.String()), Type.Null()]),
  triggerEvents: Type.Union([Type.Array(Type.String()), Type.Null()]),
  notifyConfig: Type.Union([Type.Object({ channels: Type.Array(Type.String()), states: Type.Array(Type.String()) }), Type.Null()]),
  createdBy: nullableString, createdAt: Type.String(), updatedAt: Type.String(), nextRunAt: nullableString,
  lastRun: Type.Union([JobRunSchema, Type.Null()]), recentRuns: Type.Array(JobRunSchema),
}, { additionalProperties: false });
export const BackupScheduleSchema = Type.Object({
  policyId: Type.String(), sourceKind: Type.String(), projectId: nullableString, projectName: nullableString, serviceId: nullableString,
  serviceName: nullableString, mailServerId: nullableString, payloadKind: Type.String(), destinationName: nullableString,
  cronExpression: Type.String(), enabled: Type.Boolean(), nextRunAt: nullableString,
  lastRun: Type.Union([Type.Object({ id: Type.String(), status: Type.String(), startedAt: Type.String(), finishedAt: nullableString }), Type.Null()]),
});
export type Job = Static<typeof JobSchema>;
export type JobRun = Static<typeof JobRunSchema>;
export type CreateJobInput = Static<typeof CreateJobBody>;
export type UpdateJobInput = Static<typeof UpdateJobBody>;
export const JobCollectionSchemas = {
  list: { action: "read", output: Type.Array(JobSchema) },
  create: { action: "write", input: CreateJobBody, output: JobSchema },
  triggerEvents: { action: "read", output: Type.Array(Type.Object({ id: Type.String(), label: Type.String(), description: Type.String() })) },
  backupSchedules: { action: "read", output: Type.Array(BackupScheduleSchema) },
} as const satisfies Record<string, ResourceOperationSchema>;
export const JobResourceSchemas = {
  get: { action: "read", output: JobSchema },
  update: { action: "write", input: UpdateJobBody, output: JobSchema },
  remove: { action: "write", output: Type.Object({ success: Type.Literal(true) }) },
  run: { action: "write", output: Type.Object({ key: Type.String(), runId: Type.Optional(Type.String()), summary: Type.Optional(object) }) },
  listRuns: { action: "read", input: Type.Object({ limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000 })) }), optionalInput: true, output: Type.Array(JobRunSchema) },
  getRun: { action: "read", output: JobRunSchema },
} as const satisfies Record<string, ResourceOperationSchema>;
export interface JobOperations extends ScopedOperations<typeof JobCollectionSchemas>, ResourceOperations<typeof JobResourceSchemas> {
  streamRun(id: string, options?: { signal?: AbortSignal }): AsyncIterable<DeploymentEvent>;
}
