import { Type, type Static } from "@sinclair/typebox";

// Product telemetry, separate from customers' traffic/resource analytics.
// Only these fields may leave the Cloud control plane. Never accept arbitrary
// event properties, URLs, errors, request bodies, or provider metadata.
const id = Type.String({ minLength: 1, maxLength: 128, pattern: "^[A-Za-z0-9_.:-]+$" });
const uuid = Type.String({
  pattern: "^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$",
});
const label = Type.String({
  minLength: 1,
  maxLength: 80,
  pattern: "^[A-Za-z0-9][A-Za-z0-9 _.-]*$",
});
const kind = Type.Union([Type.Literal("subscription"), Type.Literal("topup")]);
const interval = Type.Union([Type.Literal("monthly"), Type.Literal("annual")]);
const count = Type.Number({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const object = <T extends Record<string, import("@sinclair/typebox").TSchema>>(fields: T) =>
  Type.Object(fields, { additionalProperties: false });

export const CLOUD_ANALYTICS_SCREENS = [
  "home",
  "login",
  "signup",
  "verify",
  "onboarding",
  "library",
  "create_project",
  "projects",
  "project_overview",
  "project_topology",
  "project_services",
  "project_environment",
  "project_domains",
  "project_deployments",
  "project_backups",
  "project_settings",
  "project_source",
  "deployment",
  "billing_overview",
  "billing_plans",
  "billing_other",
  "backups",
  "servers",
  "clusters",
  "monitoring",
  "settings_git",
  "settings_mcp",
  "settings",
  "other",
] as const;
const screen = Type.Union(CLOUD_ANALYTICS_SCREENS.map((value) => Type.Literal(value)));
export const CloudAttributionSchema = object({
  utm_source: Type.Optional(label),
  utm_medium: Type.Optional(label),
  utm_campaign: Type.Optional(label),
  referrer_host: Type.Optional(Type.String({ maxLength: 253, pattern: "^[a-z0-9.-]+$" })),
});
export type CloudAttribution = Static<typeof CloudAttributionSchema>;

export const CloudAnalyticsEventSchemas = {
  cloud_page_viewed: object({ screen, ...CloudAttributionSchema.properties }),
  cloud_checkout_clicked: object({
    kind,
    surface: Type.Union([Type.Literal("billing"), Type.Literal("onboarding")]),
  }),
  // A return is navigation only. It must never count as a payment.
  cloud_checkout_returned: object({
    kind,
    result: Type.Union([Type.Literal("success"), Type.Literal("cancelled")]),
  }),
  cloud_signup_completed: object({}),
  cloud_github_connected: object({
    method: Type.Union([Type.Literal("app"), Type.Literal("token")]),
  }),
  cloud_project_created: object({ project_id: id }),
  cloud_deployment_started: object({ project_id: id, deployment_id: id }),
  cloud_deployment_succeeded: object({
    project_id: id,
    deployment_id: id,
    duration_ms: Type.Optional(count),
  }),
  cloud_deployment_failed: object({
    project_id: id,
    deployment_id: id,
    duration_ms: Type.Optional(count),
  }),
  cloud_first_deployment_succeeded: object({ project_id: id, deployment_id: id }),
  cloud_backup_completed: object({ backup_id: id, bytes: Type.Optional(count) }),
  cloud_backup_failed: object({ backup_id: id }),
  cloud_backup_policy_created: object({ policy_id: id }),
  cloud_scaling_configured: object({
    project_id: id,
    action: Type.Union([Type.Literal("target"), Type.Literal("replicas")]),
  }),
  cloud_mcp_tool_called: object({
    tool: label,
    ok: Type.Boolean(),
    status: Type.Integer({ minimum: 100, maximum: 599 }),
  }),
  cloud_checkout_started: object({
    checkout_id: id,
    kind,
    plan: Type.Optional(label),
    interval: Type.Optional(interval),
    amount_cents: count,
    currency: Type.Literal("usd"),
  }),
  cloud_checkout_completed: object({ checkout_id: id, kind }),
  cloud_checkout_expired: object({ checkout_id: id, kind }),
  cloud_checkout_failed: object({ checkout_id: id, kind }),
  cloud_checkout_reversed: object({
    checkout_id: id,
    kind,
    status: Type.Union([
      Type.Literal("refunded"),
      Type.Literal("partially_refunded"),
      Type.Literal("disputed"),
    ]),
  }),
  cloud_payment_succeeded: object({
    payment_id: id,
    checkout_id: Type.Optional(id),
    kind,
    amount_cents: count,
    currency: Type.Literal("usd"),
  }),
  cloud_subscription_renewed: object({ payment_id: id }),
  cloud_subscription_changed: object({
    /** Assigned by the outbox transaction, never accepted from a browser. */
    revision: Type.Optional(Type.Integer({ minimum: 1 })),
    plan: label,
    billing_source: Type.Union([
      Type.Literal("subscription"),
      Type.Literal("complimentary"),
      Type.Literal("none"),
    ]),
    status: Type.Union([
      Type.Literal("active"),
      Type.Literal("trialing"),
      Type.Literal("past_due"),
      Type.Literal("unpaid"),
      Type.Literal("paused"),
      Type.Literal("canceled"),
      Type.Literal("none"),
    ]),
    interval: Type.Optional(interval),
    cancel_at_period_end: Type.Boolean(),
    paying: Type.Boolean(),
    // Null means an old provider contract has no verified price. Never infer it
    // from today's catalog or fold purchased credits into recurring revenue.
    mrr_cents: Type.Union([count, Type.Null()]),
    currency: Type.Literal("usd"),
  }),
  cloud_operation_failed: object({
    operation: Type.Union([
      Type.Literal("checkout"),
      Type.Literal("deployment"),
      Type.Literal("github"),
    ]),
    status: Type.Integer({ minimum: 400, maximum: 599 }),
    reason: Type.Union([
      Type.Literal("validation"),
      Type.Literal("access"),
      Type.Literal("conflict"),
      Type.Literal("provider"),
      Type.Literal("unavailable"),
      Type.Literal("unknown"),
    ]),
  }),
} as const;
export type CloudAnalyticsEvent = keyof typeof CloudAnalyticsEventSchemas;
export type CloudAnalyticsProperties<E extends CloudAnalyticsEvent> = Static<
  (typeof CloudAnalyticsEventSchemas)[E]
>;
export type CloudSubscriptionSnapshot = Omit<CloudAnalyticsProperties<"cloud_subscription_changed">, "revision">;

export const CloudBrowserEventSchema = Type.Union([
  object({
    event: Type.Literal("cloud_page_viewed"),
    properties: CloudAnalyticsEventSchemas.cloud_page_viewed,
  }),
  object({
    event: Type.Literal("cloud_checkout_clicked"),
    properties: CloudAnalyticsEventSchemas.cloud_checkout_clicked,
  }),
  object({
    event: Type.Literal("cloud_checkout_returned"),
    properties: CloudAnalyticsEventSchemas.cloud_checkout_returned,
  }),
]);
export type CloudBrowserEvent = Static<typeof CloudBrowserEventSchema>;
export const CloudBrowserCaptureSchema = object({
  id: uuid,
  anonymousId: uuid,
  // Used only to DROP stale requests at a login boundary, never to authenticate.
  expectedUserId: Type.Union([id, Type.Null()]),
  attribution: CloudAttributionSchema,
  data: CloudBrowserEventSchema,
});
export type CloudBrowserCapture = Static<typeof CloudBrowserCaptureSchema>;
