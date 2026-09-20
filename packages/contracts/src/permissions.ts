import { Type, type Static } from "@sinclair/typebox";
import { TokenSourceScopeSchema } from "./token-inputs";
import type { ResourceOperationSchema, ScopedOperations, ResourceOperations } from "./resource-operations";

export const MemberRoleSchema = Type.Union([Type.Literal("owner"), Type.Literal("admin"), Type.Literal("member"), Type.Literal("restricted")]);
export const PermissionGrantSchema = Type.Object({
  resourceType: Type.String({ minLength: 1, maxLength: 100 }),
  resourceId: Type.String({ minLength: 1, maxLength: 512 }),
  permissions: Type.Array(Type.Union([Type.Literal("read"), Type.Literal("write"), Type.Literal("admin"), Type.Literal("create")]), { maxItems: 4 }),
  scope: Type.Optional(Type.Union([TokenSourceScopeSchema, Type.Null()])),
});
export type PermissionGrantInput = Static<typeof PermissionGrantSchema>;
export const InviteWithGrantsBody = Type.Object({
  email: Type.String({ minLength: 3, maxLength: 254, pattern: "^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$" }),
  role: Type.Optional(MemberRoleSchema),
  grants: Type.Optional(Type.Array(PermissionGrantSchema, { maxItems: 1000 })),
  delivery: Type.Optional(Type.Union([Type.Literal("email"), Type.Literal("link")])),
});
export type InviteWithGrantsInput = Static<typeof InviteWithGrantsBody>;
const stringOrNull = Type.Union([Type.String(), Type.Null()]);
export const ResourceGrantSchema = Type.Composite([PermissionGrantSchema, Type.Object({
  id: Type.String(), organizationId: Type.String(), userId: Type.String(), grantedByUserId: stringOrNull, createdAt: Type.String(),
})]);
export const OrganizationMemberSchema = Type.Object({
  id: Type.String(), organizationId: Type.String(), userId: Type.String(), role: MemberRoleSchema, createdAt: Type.String(),
  user: Type.Optional(Type.Object({ id: Type.String(), email: Type.String(), name: stringOrNull, image: stringOrNull })),
});
const pendingInvitation = Type.Object({
  id: Type.String(), email: Type.String(), role: MemberRoleSchema, status: Type.String(), inviterId: Type.String(), expiresAt: Type.String(), createdAt: Type.String(),
  pendingGrants: Type.Array(PermissionGrantSchema),
});
export const PermissionCollectionSchemas = {
  orgMeta: { action: "read", output: Type.Object({ organizationId: Type.String(), isTeam: Type.Boolean(), memberCount: Type.Integer() }) },
  listResources: { action: "read", input: Type.Object({ type: Type.String({ minLength: 1, maxLength: 100 }), owner: Type.Optional(Type.String({ maxLength: 100 })) }), output: Type.Array(Type.Object({ id: Type.String(), label: Type.String(), meta: Type.Optional(Type.Record(Type.String(), Type.Unknown())) })) },
  createTeamOrg: { action: "write", input: Type.Object({ name: Type.String({ minLength: 1, maxLength: 200 }), slug: Type.Optional(Type.String({ minLength: 1, maxLength: 100, pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$" })) }), output: Type.Object({ id: Type.String(), name: Type.String(), isTeam: Type.Literal(true) }) },
  listGrants: { action: "read", input: Type.Object({ userId: Type.String({ minLength: 1, maxLength: 512 }) }), output: Type.Array(ResourceGrantSchema) },
  upsertGrant: { action: "write", input: Type.Composite([PermissionGrantSchema, Type.Object({ userId: Type.String({ minLength: 1, maxLength: 512 }) })]), output: Type.Union([ResourceGrantSchema, Type.Null()]) },
  replaceGrants: { action: "write", input: Type.Object({ userId: Type.String({ minLength: 1, maxLength: 512 }), grants: Type.Array(PermissionGrantSchema, { maxItems: 1000 }) }), output: Type.Array(ResourceGrantSchema) },
  listInvitations: { action: "read", output: Type.Array(pendingInvitation) },
  inviteWithGrants: { action: "write", input: InviteWithGrantsBody, output: Type.Object({ id: Type.String(), email: Type.String(), role: MemberRoleSchema, pendingGrantCount: Type.Integer() }) },
  listMembers: { action: "read", output: Type.Array(OrganizationMemberSchema) },
} as const satisfies Record<string, ResourceOperationSchema>;
export const PermissionResourceSchemas = {
  materializeInvitation: { action: "write", output: Type.Object({ materialized: Type.Integer() }) },
  deleteGrant: { action: "admin", output: Type.Object({ revoked: Type.Literal(true) }) },
  acceptInvitation: { action: "write", output: Type.Object({ organizationId: Type.String(), member: OrganizationMemberSchema, materialized: Type.Integer() }) },
  rejectInvitation: { action: "write", output: Type.Object({ rejected: Type.Literal(true) }) },
  cancelInvitation: { action: "write", output: Type.Object({ canceled: Type.Literal(true) }) },
  resendInvitation: { action: "write", input: Type.Object({ delivery: Type.Optional(Type.Union([Type.Literal("email"), Type.Literal("link")])) }), optionalInput: true, output: Type.Object({ id: Type.String(), email: Type.String(), role: MemberRoleSchema, pendingGrantCount: Type.Integer() }) },
  setMemberRole: { action: "write", input: Type.Object({ role: MemberRoleSchema }), output: OrganizationMemberSchema },
  removeMember: { action: "admin", output: Type.Object({ removed: Type.Literal(true) }) },
} as const satisfies Record<string, ResourceOperationSchema>;
export interface PermissionOperations extends ScopedOperations<typeof PermissionCollectionSchemas>, ResourceOperations<typeof PermissionResourceSchemas> {}
