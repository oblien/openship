import { Type, type Static } from "@sinclair/typebox";
import type { RouteRuleSpec } from "@repo/core";
import { CreateDomainResultSchema } from "./domains";
import { ResourceIdSchema } from "./deployment-resources";
import type { ResourceOperationSchema } from "./resource-operations";

const nullableString = Type.Union([Type.String(), Type.Null()]);
const list = Type.Optional(Type.Array(Type.String()));
export const RouteRuleSpecSchema = Type.Object({
  rateLimit: Type.Optional(Type.Object({ rps: Type.Number(), burst: Type.Number(), key: Type.Optional(Type.Literal("ip")), status: Type.Optional(Type.Number()) })),
  ban: Type.Optional(Type.Object({ ips: list, cidrs: list, countries: list, userAgents: list, emptyUserAgent: Type.Optional(Type.Boolean()) })),
  access: Type.Optional(Type.Object({ allowCidrs: list, denyCidrs: list, allowCountries: list, methods: list })),
  hotlink: Type.Optional(Type.Object({ allowReferers: list, allowEmpty: Type.Optional(Type.Boolean()) })),
  block: Type.Optional(Type.Object({ status: Type.Optional(Type.Number()) })),
});
export const RouteRuleSchema = Type.Object({
  id: Type.String(), organizationId: Type.String(), projectId: Type.String(),
  domainId: nullableString, pathPrefix: nullableString, spec: RouteRuleSpecSchema,
  enabled: Type.Boolean(), createdAt: Type.String(), updatedAt: Type.String(),
});
export type RouteRule = Static<typeof RouteRuleSchema>;
export const RouteRuleInputSchema = Type.Object({
  domainId: Type.Optional(nullableString), pathPrefix: Type.Optional(nullableString),
  // The retained edge sanitizer bounds lists, clamps values, and drops unsupported
  // fields. It remains the one normalization boundary for existing rule inputs.
  spec: Type.Optional(Type.Unsafe<RouteRuleSpec>(Type.Unknown())),
  enabled: Type.Optional(Type.Boolean()),
}, { additionalProperties: false });
export const UpdateRouteRuleInputSchema = Type.Composite([
  RouteRuleInputSchema, Type.Object({ ruleId: ResourceIdSchema }),
], { additionalProperties: false });

export const ServiceIncidentSchema = Type.Object({
  id: Type.String(), organizationId: Type.String(), projectId: nullableString, serviceId: nullableString,
  serviceKey: Type.String(), serviceName: Type.String(), serverId: nullableString, containerId: nullableString,
  kind: Type.Union([Type.Literal("unhealthy"), Type.Literal("crash_loop"), Type.Literal("down"), Type.Literal("server_unreachable")]),
  status: Type.String(), reason: nullableString, exitCode: Type.Union([Type.Integer(), Type.Null()]),
  restartCount: Type.Integer(), oomKilled: Type.Boolean(), confirmations: Type.Integer(), notifyCount: Type.Integer(),
  notifiedAt: nullableString, logExcerpt: nullableString, openedAt: Type.String(), resolvedAt: nullableString,
  lastSeenAt: Type.String(), createdAt: Type.String(), updatedAt: Type.String(),
});
export const ProjectIncidentsSchema = Type.Object({
  open: Type.Array(ServiceIncidentSchema), resolved: Type.Array(ServiceIncidentSchema),
  historyDays: Type.Integer(), serverUnreachable: Type.Union([ServiceIncidentSchema, Type.Null()]), watching: Type.Boolean(),
});
export const ConnectProjectDomainInputSchema = Type.Object({
  domain: Type.String({ minLength: 1, maxLength: 253 }), includeWww: Type.Optional(Type.Boolean()),
  externalIngress: Type.Optional(Type.Boolean()), sslChallenge: Type.Optional(Type.Union([Type.Literal("http-01"), Type.Literal("dns-01")])),
}, { additionalProperties: false });
export const ProjectRoutingSchemas = {
  listRouteRules: { action: "read", output: Type.Array(RouteRuleSchema) },
  createRouteRule: { action: "write", input: RouteRuleInputSchema, output: RouteRuleSchema },
  updateRouteRule: { action: "write", input: UpdateRouteRuleInputSchema, output: RouteRuleSchema },
  removeRouteRule: { action: "write", input: ResourceIdSchema, output: Type.Object({ success: Type.Literal(true) }) },
  getIncidents: { action: "read", output: ProjectIncidentsSchema },
  connectDomain: { action: "write", input: ConnectProjectDomainInputSchema, output: Type.Composite([CreateDomainResultSchema, Type.Object({ success: Type.Literal(true) })]) },
} as const satisfies Record<string, ResourceOperationSchema>;
