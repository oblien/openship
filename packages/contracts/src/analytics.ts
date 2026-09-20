import { Type, type Static } from "@sinclair/typebox";
import { RuntimeUsageSchema, DeploymentContainerInfoSchema } from "./deployment-controls";
import type { DeploymentEvent } from "./deployment-resources";
import type { ResourceOperationSchema, ResourceOperations, ScopedOperations } from "./resource-operations";

const nullableString = Type.Union([Type.String(), Type.Null()]);
const nullableNumber = Type.Union([Type.Number(), Type.Null()]);
const numbers = Type.Record(Type.String(), Type.Number());
const object = Type.Record(Type.String(), Type.Unknown());
const dateInput = Type.String({ minLength: 1, maxLength: 64 });
export const AnalyticsDomainSchema = Type.Object({ domain: Type.Optional(Type.String()) }, { additionalProperties: false });
/** Ranges are ordered, finite ISO dates, limited to 366 days per query. */
export const AnalyticsRangeSchema = Type.Object({ from: Type.Optional(dateInput), to: Type.Optional(dateInput), domain: Type.Optional(Type.String()) }, { additionalProperties: false });
export const AnalyticsSummarySchema = Type.Object({ totalRequests: Type.Number(), pageRequests: Type.Number(), uniqueVisitors: nullableNumber, bandwidthIn: Type.Number(), bandwidthOut: Type.Number(), avgResponseTimeMs: Type.Number(), lastUpdated: nullableString });
const pathCount = Type.Object({ path: Type.String(), count: Type.Number() });
export const AnalyticsPeriodSchema = Type.Object({ from: Type.String(), to: Type.String(), requests: Type.Number(), uniqueVisitors: Type.Number(), bandwidthIn: Type.Number(), bandwidthOut: Type.Number(), avgResponseTimeMs: Type.Number(), topPaths: Type.Array(pathCount), trafficByHour: numbers });
export const ProjectGeoSchema = Type.Object({
  total: Type.Number(), countries: Type.Array(Type.Object({ code: Type.String(), count: Type.Number(), pct: Type.Number() })),
  visitorDays: Type.Number(), peakDayVisitors: Type.Number(), topPaths: Type.Array(pathCount), statuses: numbers,
  geoAvailable: Type.Boolean(), approximate: Type.Boolean(), pathsEnabled: Type.Boolean(), source: Type.Union([Type.Literal("self-hosted"), Type.Literal("cloud"), Type.Literal("none")]),
});
export const DeploymentStatsSchema = Type.Object({ totalDeployments: Type.Number(), successfulDeployments: Type.Number(), failedDeployments: Type.Number(), avgBuildDurationMs: Type.Number(), dailyCounts: Type.Array(Type.Object({ date: Type.String(), total: Type.Number(), success: Type.Number(), failed: Type.Number() })) });
export const ProjectUsageSchema = Type.Object({
  supported: Type.Boolean(), reason: Type.Optional(Type.String()), overall: RuntimeUsageSchema,
  services: Type.Array(Type.Object({ serviceId: nullableString, name: Type.String(), containerId: nullableString, status: Type.String(), usage: Type.Union([RuntimeUsageSchema, Type.Null()]) })),
  capacity: Type.Object({ cpuCores: nullableNumber, memoryMb: nullableNumber }), timestamp: Type.String(),
});
export const UsageHistorySchema = Type.Object({
  buckets: Type.Array(Type.Object({ minute: Type.Number(), cpuPercent: Type.Number(), memoryMb: Type.Number(), networkRxBytes: Type.Number(), networkTxBytes: Type.Number(), hasData: Type.Boolean() })),
  services: Type.Array(Type.Object({ serviceKey: Type.String(), name: Type.String() })), granularityMinutes: Type.Number(), serviceKey: nullableString,
});
export const AnalyticsProjectSchemas = {
  summary: { action: "read", input: AnalyticsDomainSchema, optionalInput: true, output: AnalyticsSummarySchema },
  periods: { action: "read", input: AnalyticsRangeSchema, optionalInput: true, output: Type.Array(AnalyticsPeriodSchema) },
  overview: { action: "read", input: AnalyticsRangeSchema, optionalInput: true, output: Type.Object({ summary: AnalyticsSummarySchema, periods: Type.Array(AnalyticsPeriodSchema) }) },
  geo: { action: "read", input: AnalyticsRangeSchema, optionalInput: true, output: ProjectGeoSchema },
  deploymentStats: { action: "read", output: DeploymentStatsSchema },
  usage: { action: "read", output: Type.Union([RuntimeUsageSchema, Type.Null()]) },
  containerInfo: { action: "read", output: Type.Union([DeploymentContainerInfoSchema, Type.Null()]) },
  resources: { action: "read", output: ProjectUsageSchema },
  usageHistory: { action: "read", input: Type.Object({ from: Type.Optional(dateInput), to: Type.Optional(dateInput), serviceKey: Type.Optional(Type.String()) }), optionalInput: true, output: UsageHistorySchema },
  setPathsCollection: { action: "write", input: Type.Object({ enabled: Type.Boolean() }, { additionalProperties: false }), output: Type.Object({ enabled: Type.Boolean() }) },
} as const satisfies Record<string, ResourceOperationSchema>;
export const AnalyticsCollectionSchemas = {
  dashboard: { action: "read", output: Type.Object({ projects: Type.Object({ total: Type.Number(), active: Type.Number() }), deployments: Type.Object({ total: Type.Number(), success: Type.Number(), failed: Type.Number(), pending: Type.Number() }) }) },
} as const satisfies Record<string, ResourceOperationSchema>;
export const ServerAnalyticsBucketSchema = Type.Object({ id: Type.String(), serverId: Type.String(), domain: Type.String(), minute: Type.Number(), requests: Type.Number(), uniqueRequests: Type.Number(), bandwidthIn: Type.Number(), bandwidthOut: Type.Number(), responseTime: Type.Number(), countries: Type.Union([numbers, Type.Null()]), createdAt: Type.String() });
export const AnalyticsServerSchemas = {
  serverBuckets: { action: "read", input: Type.Object({ domain: Type.String({ minLength: 1 }), from: Type.Optional(Type.String()), to: Type.Optional(Type.String()) }), output: Type.Array(ServerAnalyticsBucketSchema) },
  serverGeo: { action: "read", input: Type.Object({ domain: Type.String({ minLength: 1 }), day: Type.Optional(Type.String({ pattern: "^\\d{8}$" })) }), output: Type.Object({ countries: numbers, id: Type.Optional(Type.String()), serverId: Type.Optional(Type.String()), domain: Type.Optional(Type.String()), day: Type.Optional(Type.String()), visitors: Type.Optional(Type.Number()), paths: Type.Optional(Type.Union([numbers, Type.Null()])), statuses: Type.Optional(Type.Union([numbers, Type.Null()])), createdAt: Type.Optional(Type.String()) }) },
  serverLive: { action: "read", input: Type.Object({ domain: Type.String({ minLength: 1 }) }), output: object },
} as const satisfies Record<string, ResourceOperationSchema>;
export type AnalyticsRange = Static<typeof AnalyticsRangeSchema>;
export type AnalyticsSummary = Static<typeof AnalyticsSummarySchema>;
export type AnalyticsPeriod = Static<typeof AnalyticsPeriodSchema>;
export type ProjectUsage = Static<typeof ProjectUsageSchema>;
export type ProjectGeo = Static<typeof ProjectGeoSchema>;
export type UsageHistory = Static<typeof UsageHistorySchema>;
export interface AnalyticsOperations extends ResourceOperations<typeof AnalyticsProjectSchemas>, ResourceOperations<typeof AnalyticsServerSchemas>, ScopedOperations<typeof AnalyticsCollectionSchemas> {
  streamUsage(projectId: string, options?: { signal?: AbortSignal }): AsyncIterable<DeploymentEvent>;
}
