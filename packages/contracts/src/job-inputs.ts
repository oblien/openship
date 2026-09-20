/**
 * Job validation schemas — TypeBox for Hono route validation.
 *
 * A custom job runs a command on one or more servers. It can be scheduled by
 * cron (recurring), fired once at a time (once), or driven only by Run-now /
 * dependencies / event triggers (manual). Advanced policies (retry, env,
 * secrets, dependencies, triggers, per-job notifications) live alongside.
 */

import { Type, type Static } from "@sinclair/typebox";

/** { maxAttempts, backoffSeconds } — retry a failed run up to N times. */
const RetryConfig = Type.Object({
  maxAttempts: Type.Integer({ minimum: 1, maximum: 10 }),
  backoffSeconds: Type.Integer({ minimum: 0, maximum: 3600 }),
});

/** Plain env vars injected into the command (non-secret). */
const EnvMap = Type.Record(Type.String(), Type.String());

/** Per-job notification override — which channels fire on which run states.
 *  Absent → fall back to the global Settings→Notifications subscriptions. */
const NotifyConfig = Type.Object({
  channels: Type.Array(Type.String({ minLength: 1 }), { maxItems: 50 }),
  states: Type.Array(
    Type.Union([Type.Literal("running"), Type.Literal("success"), Type.Literal("failed")]),
    { maxItems: 3 },
  ),
});

const ScheduleType = Type.Union([
  Type.Literal("recurring"),
  Type.Literal("once"),
  Type.Literal("manual"),
]);

// Validated by the retained scheduler as well; no process-global TypeBox format registry.
const RunAt = Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}[Tt]\\d{2}:\\d{2}:\\d{2}(?:\\.\\d+)?(?:[Zz]|[+-]\\d{2}:\\d{2})$" });

/** Update a job — cron/enabled (any job) plus, for custom jobs, the full config.
 *  System jobs reject everything but cronExpression/enabled (guarded in the
 *  service). All fields optional (partial patch). */
export const UpdateJobBody = Type.Object({
  label: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
  cronExpression: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
  enabled: Type.Optional(Type.Boolean()),
  scheduleType: Type.Optional(ScheduleType),
  runAt: Type.Optional(RunAt),
  serverId: Type.Optional(Type.String({ minLength: 1 })),
  serverIds: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { maxItems: 50 })),
  command: Type.Optional(Type.String({ minLength: 1, maxLength: 10_000 })),
  timeoutMs: Type.Optional(Type.Number({ minimum: 1000, maximum: 86_400_000 })),
  retry: Type.Optional(RetryConfig),
  env: Type.Optional(EnvMap),
  /** Plaintext secret env vars — encrypted at rest. Full replacement map. */
  secrets: Type.Optional(EnvMap),
  dependsOn: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { maxItems: 50 })),
  triggerEvents: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { maxItems: 50 })),
  notifyConfig: Type.Optional(Type.Union([NotifyConfig, Type.Null()])),
});

export type TUpdateJobBody = Static<typeof UpdateJobBody>;

/** Create a custom command job. Runs on `serverId`/`serverIds`; scheduled by
 *  cron (recurring), once at `runAt`, or manual. May be a plain shell command
 *  or `docker run --rm <image> <cmd>`. */
export const CreateJobBody = Type.Object({
  label: Type.String({ minLength: 1, maxLength: 120 }),
  serverId: Type.Optional(Type.String({ minLength: 1 })),
  serverIds: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { maxItems: 50 })),
  command: Type.String({ minLength: 1, maxLength: 10_000 }),
  scheduleType: Type.Optional(ScheduleType),
  cronExpression: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
  runAt: Type.Optional(RunAt),
  timeoutMs: Type.Optional(Type.Number({ minimum: 1000, maximum: 86_400_000 })),
  retry: Type.Optional(RetryConfig),
  env: Type.Optional(EnvMap),
  secrets: Type.Optional(EnvMap),
  dependsOn: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { maxItems: 50 })),
  triggerEvents: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { maxItems: 50 })),
  notifyConfig: Type.Optional(NotifyConfig),
});

export type TCreateJobBody = Static<typeof CreateJobBody>;
