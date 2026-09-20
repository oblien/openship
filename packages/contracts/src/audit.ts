import { Type, type Static } from "@sinclair/typebox";
import type { ResourceOperationSchema, ScopedOperations } from "./resource-operations";

const nullableString = Type.Union([Type.String(), Type.Null()]);
const filterText = Type.Optional(Type.String({ maxLength: 2048 }));
export const AuditQuerySchema = Type.Object({
  category: filterText, eventType: filterText, actorUserId: filterText, resourceType: filterText, resourceId: filterText,
  source: filterText, sourceClientId: filterText, from: filterText, to: filterText, q: filterText,
  cursor: Type.Optional(Type.String({ maxLength: 2048 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
  page: Type.Optional(Type.Integer({ minimum: 1 })), perPage: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
});
const actor = Type.Object({ id: Type.String(), email: Type.String(), name: nullableString });
export const AuditEventSchema = Type.Object({
  id: Type.String(), organizationId: Type.String(), actorUserId: nullableString, eventType: Type.String(), resourceType: nullableString, resourceId: nullableString,
  before: Type.Unknown(), after: Type.Unknown(), ipAddress: nullableString, userAgent: nullableString, source: nullableString, sourceClientId: nullableString, createdAt: Type.String(),
  actor: Type.Union([actor, Type.Null()]), resourceName: nullableString, sourceClientName: nullableString,
});
export const AuditSettingsSchema = Type.Object({ enabled: Type.Boolean(), retentionDays: Type.Integer() });
export const AuditSettingsInput = Type.Partial(Type.Object({ enabled: Type.Boolean(), retentionDays: Type.Union(([7, 30, 90, 180, 365] as const).map(value => Type.Literal(value))) }));
export const AuditOperationSchemas = {
  list: { action: "read", input: AuditQuerySchema, optionalInput: true, output: Type.Union([
    Type.Object({ items: Type.Array(AuditEventSchema), total: Type.Integer(), page: Type.Integer(), perPage: Type.Integer() }),
    Type.Object({ items: Type.Array(AuditEventSchema), pageInfo: Type.Object({ hasNextPage: Type.Boolean(), endCursor: nullableString }) }),
  ]) },
  facets: { action: "read", input: AuditQuerySchema, optionalInput: true, output: Type.Object({
    total: Type.Integer(), categories: Type.Array(Type.Object({ id: Type.String(), label: Type.String(), description: Type.String(), count: Type.Number() })),
    sources: Type.Array(Type.Object({ source: nullableString, count: Type.Number() })), clients: Type.Array(Type.Object({ id: Type.String(), name: nullableString, count: Type.Number() })),
    actors: Type.Array(Type.Object({ ...actor.properties, image: nullableString })), settings: AuditSettingsSchema, canManage: Type.Boolean(),
  }) },
  getSettings: { action: "read", output: Type.Object({ ...AuditSettingsSchema.properties, canManage: Type.Boolean() }) },
  updateSettings: { action: "write", input: AuditSettingsInput, output: Type.Object({ ...AuditSettingsSchema.properties, canManage: Type.Boolean() }) },
} as const satisfies Record<string, ResourceOperationSchema>;
export type AuditQuery = Static<typeof AuditQuerySchema>;
export type AuditEvent = Static<typeof AuditEventSchema>;
export type AuditOperations = ScopedOperations<typeof AuditOperationSchemas>;
