import { Type, type Static } from "@sinclair/typebox";
import { ProjectPendingActionSchema } from "./project-controls";
import type { ResourceOperationSchema, ScopedOperations } from "./resource-operations";

const scope = Type.Union((["platform", "server", "project", "domain"] as const).map(value => Type.Literal(value)));
const nullableString = Type.Union([Type.String(), Type.Null()]);
export const IssueCountsSchema = Type.Object({ outage: Type.Number(), actionRequired: Type.Number(), advisory: Type.Number(), total: Type.Number() });
export const SystemIssueSchema = Type.Object({
  id: Type.String(), kind: Type.String(), severity: Type.Union((["outage", "action_required", "advisory"] as const).map(value => Type.Literal(value))), scope,
  source: Type.Union((["incident", "component", "deploy", "domain", "update"] as const).map(value => Type.Literal(value))), title: Type.String(), message: Type.String(),
  details: Type.Optional(Type.Record(Type.String(), Type.Unknown())), expiresAt: Type.Optional(Type.String()), since: Type.Optional(Type.String()), resolvedAt: Type.Optional(Type.String()),
  target: Type.Object({ scope, id: Type.String(), name: Type.String(), href: Type.String() }), resolveWith: ProjectPendingActionSchema.properties.resolveWith,
  infraFix: Type.Optional(Type.Object({ serverId: Type.String(), component: Type.Union([Type.Literal("edge"), Type.Literal("mail")]), action: Type.Union([Type.Literal("repair"), Type.Literal("update")]) })),
});
const currentScan = Type.Object({ completedAt: Type.String(), summary: Type.Record(Type.String(), Type.Number()) });
export const WorkloadHealthSchema = Type.Object({ organizationId: Type.String(), projectId: Type.String(), projectName: Type.String(), projectSlug: Type.String(), serviceId: nullableString, serviceKey: Type.String(), serviceName: Type.String(), serverId: nullableString, serverName: Type.String(), containerId: Type.String(), state: Type.Union((["healthy", "down", "crash_loop", "unhealthy", "unknown"] as const).map(value => Type.Literal(value))), observedAt: Type.String() });
export const IssueCollectionSchemas = {
  list: { action: "read", scope: "list", input: Type.Object({ status: Type.Optional(Type.Union([Type.Literal("open"), Type.Literal("resolved")])) }), optionalInput: true, output: Type.Object({ issues: Type.Array(SystemIssueSchema), counts: IssueCountsSchema, status: Type.Union([Type.Literal("open"), Type.Literal("resolved")]) }) },
  summary: { action: "read", scope: "list", output: IssueCountsSchema },
  health: { action: "read", scope: "list", output: Type.Object({ workloads: Type.Array(WorkloadHealthSchema), watching: Type.Boolean(), capabilities: Type.Object({ current: Type.Boolean(), continuous: Type.Boolean() }), currentScan: Type.Union([currentScan, Type.Null()]), watcher: Type.Object({ key: Type.String(), schedule: nullableString, available: Type.Boolean(), eventsEnabled: Type.Boolean() }) }) },
  scanHealth: { action: "read", scope: "list", output: currentScan },
} as const satisfies Record<string, ResourceOperationSchema>;
export const IssueRescanSchema = Type.Object({ id: Type.String(), status: Type.Union([Type.Literal("running"), Type.Literal("completed")]), startedAt: Type.String(), finishedAt: Type.Optional(Type.String()), stages: Type.Array(Type.Object({ key: Type.String(), status: Type.Union((["pending", "running", "completed", "failed", "skipped"] as const).map(value => Type.Literal(value))), summary: Type.Optional(Type.Record(Type.String(), Type.Unknown())), error: Type.Optional(Type.String()) })) });
export const IssueJobSchemas = {
  rescan: { action: "write", output: IssueRescanSchema },
  rescanStatus: { action: "read", output: Type.Union([IssueRescanSchema, Type.Null()]) },
} as const satisfies Record<string, ResourceOperationSchema>;
export type SystemIssue = Static<typeof SystemIssueSchema>;
export type IssueCounts = Static<typeof IssueCountsSchema>;
export type IssueRescan = Static<typeof IssueRescanSchema>;
export interface IssueOperations extends ScopedOperations<typeof IssueCollectionSchemas>, ScopedOperations<typeof IssueJobSchemas> {}
