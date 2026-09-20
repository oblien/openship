import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { DEPLOYMENT_HISTORY_STATUSES, type DeploymentHistoryFilter, type LogEntry, type PromptPayload } from "@repo/core";
import { DeploymentSchema, type Deployment, type CreateDeploymentResult } from "./deployments";
import type { DeploymentControlSchemas, DeploymentSslSchemas } from "./deployment-controls";
import type { ResourceOperations, ScopedOperations } from "./resource-operations";

export type { LogEntry, PromptPayload } from "@repo/core";

export const ResourceIdSchema = Type.String({ minLength: 1, maxLength: 512 });
export const DeploymentHistoryFilters = {
  status: Type.Optional(Type.Union(
    (Object.keys(DEPLOYMENT_HISTORY_STATUSES) as DeploymentHistoryFilter[]).map((status) => Type.Literal(status)),
  )),
  search: Type.Optional(Type.String({ maxLength: 200 })),
};
export const ListDeploymentsSchema = Type.Object({
  ...DeploymentHistoryFilters,
  projectId: Type.Optional(ResourceIdSchema),
  environment: Type.Optional(Type.Union([Type.Literal("production"), Type.Literal("preview")])),
  page: Type.Optional(Type.Integer({ minimum: 1 })),
  perPage: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
});
export const DeploymentLogsSchema = Type.Object({ tail: Type.Optional(Type.Integer({ minimum: 1, maximum: 100_000 })) });
export const RedeploySchema = Type.Object({ useExistingCommit: Type.Optional(Type.Boolean()) });
export const RespondSchema = Type.Object({ action: Type.String({ minLength: 1, maxLength: 256 }) });
export const PinSchema = Type.Object({ pinned: Type.Optional(Type.Boolean()) });
export const SkipPortCheckSchema = Type.Object({ target: Type.Union([Type.String({ minLength: 1 }), Type.Integer({ minimum: 1, maximum: 65535 })]) });

export type ListDeploymentsInput = Static<typeof ListDeploymentsSchema>;
export interface DeploymentPage {
  data: Deployment[];
  total: number;
  page: number;
  perPage: number;
  /** Global history's project options, independent of the current page. */
  projects?: Array<{ id: string; name: string }>;
}
export interface CancellationResult {
  success: boolean;
  pending: boolean;
  status: "cancelling" | "cancelled";
  message: string;
}
/** Stable status fields; providers may add capability-specific diagnostics. */
export interface DeploymentBuildStatus {
  success: boolean;
  deployment_id: string;
  project_id: string;
  status: string;
  deploymentStatus: string;
  is_active: boolean;
  cancellationPending: boolean;
  decisionPending: boolean;
  pendingPrompt: PromptPayload | null;
  errorMessage?: string | null;
  warningMessage?: string | null;
  errorCode?: string;
  errorDetails?: Record<string, unknown>;
  lastEventId?: number;
  [diagnostic: string]: unknown;
}
export interface DeploymentRestorePlan {
  mode: string;
  needsRepository: boolean;
  rebuildServices: string[];
  untouchedServices: string[];
  env?: unknown;
  code?: string;
  reason?: string;
}
/** Application event envelope. The data preserves the deployed server protocol. */
export interface DeploymentEvent {
  event: string;
  data: string;
  id?: string;
}
export interface DeploymentEventOptions {
  since?: number;
  signal?: AbortSignal;
}
export interface DeploymentResourceOperations extends ResourceOperations<typeof DeploymentControlSchemas>, ScopedOperations<typeof DeploymentSslSchemas> {
  get(id: string): Promise<Deployment>;
  list(input?: ListDeploymentsInput): Promise<DeploymentPage>;
  logs(id: string, input?: Static<typeof DeploymentLogsSchema>): Promise<LogEntry[]>;
  buildStatus(id: string): Promise<DeploymentBuildStatus>;
  restorePlan(id: string): Promise<DeploymentRestorePlan>;
  cancel(id: string): Promise<CancellationResult>;
  respond(id: string, input: Static<typeof RespondSchema>): Promise<{ success: boolean }>;
  rollback(id: string): Promise<Deployment>;
  redeploy(id: string, input?: Static<typeof RedeploySchema>): Promise<CreateDeploymentResult>;
  pin(id: string, input?: Static<typeof PinSchema>): Promise<Deployment>;
  keep(id: string): Promise<{ success: boolean; deployment: Deployment }>;
  reject(id: string): Promise<{ success: boolean; restoredDeploymentId: string | null }>;
  remove(id: string): Promise<{ success: boolean; message: string }>;
  restart(id: string): Promise<Deployment>;
  skipPortCheck(id: string, input: Static<typeof SkipPortCheckSchema>): Promise<{ success: boolean }>;
  events(id: string, options?: DeploymentEventOptions): AsyncIterable<DeploymentEvent>;
}

export const DeploymentPageSchema = Type.Object({
  data: Type.Array(DeploymentSchema), total: Type.Integer({ minimum: 0 }),
  page: Type.Integer({ minimum: 1 }), perPage: Type.Integer({ minimum: 1 }),
  projects: Type.Optional(Type.Array(Type.Object({ id: ResourceIdSchema, name: Type.String() }))),
});
export const LogEntrySchema = Type.Object({
  timestamp: Type.String(), message: Type.String(),
  level: Type.Union([Type.Literal("info"), Type.Literal("warn"), Type.Literal("error")]),
});
const BuildStatusSchema = Type.Object({
  success: Type.Boolean(), deployment_id: ResourceIdSchema, project_id: ResourceIdSchema,
  status: Type.String(), deploymentStatus: Type.String(), is_active: Type.Boolean(),
  cancellationPending: Type.Boolean(), decisionPending: Type.Boolean(),
  pendingPrompt: Type.Union([Type.Null(), Type.Object({
    promptId: Type.String(), title: Type.String(), message: Type.String(),
    actions: Type.Array(Type.Object({ id: Type.String(), label: Type.String(), variant: Type.Optional(Type.String()) })),
    expiresAt: Type.Optional(Type.String()),
  })]),
});
const RestorePlanSchema = Type.Object({
  mode: Type.String(), needsRepository: Type.Boolean(), rebuildServices: Type.Array(Type.String()),
  untouchedServices: Type.Array(Type.String()),
});
const CancellationSchema = Type.Object({
  success: Type.Boolean(), pending: Type.Boolean(), message: Type.String(),
  status: Type.Union([Type.Literal("cancelling"), Type.Literal("cancelled")]),
});
export const isDeploymentPage = (value: unknown): value is DeploymentPage => Value.Check(DeploymentPageSchema, value);
export const isDeploymentLogs = (value: unknown): value is LogEntry[] => Value.Check(Type.Array(LogEntrySchema), value);
export const isDeploymentBuildStatus = (value: unknown): value is DeploymentBuildStatus => Value.Check(BuildStatusSchema, value);
export const isDeploymentRestorePlan = (value: unknown): value is DeploymentRestorePlan => Value.Check(RestorePlanSchema, value);
export const isCancellationResult = (value: unknown): value is CancellationResult => Value.Check(CancellationSchema, value);
