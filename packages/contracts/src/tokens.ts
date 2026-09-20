import { Type, type Static } from "@sinclair/typebox";
import { CreateTokenBody, AuthorizeMcpClientBody, TokenGrantSchema } from "./token-inputs";
import type { ResourceOperationSchema, ScopedOperations, ResourceOperations } from "./resource-operations";
export * from "./token-inputs";

const nullableString = Type.Union([Type.String(), Type.Null()]);
export const PersonalAccessTokenSchema = Type.Object({
  id: Type.String(), name: Type.String(), tokenPrefix: Type.String(), readOnly: Type.Boolean(), scoped: Type.Boolean(),
  expiresAt: nullableString, lastUsedAt: nullableString, useCount: Type.Integer(), revokedAt: nullableString, createdAt: Type.String(),
});
export const McpClientSchema = Type.Object({
  clientId: nullableString, name: Type.String(), organizationId: nullableString, organizationName: nullableString,
  readOnly: Type.Boolean(), scoped: Type.Boolean(), grantCount: Type.Integer(), authorizedAt: Type.String(), lastUsedAt: nullableString,
  useCount: Type.Integer(), expiresAt: Type.Optional(nullableString), auditClientId: Type.String(), grants: Type.Optional(Type.Array(TokenGrantSchema)),
});
export const TokenCollectionSchemas = {
  list: { action: "read", output: Type.Array(PersonalAccessTokenSchema) },
  create: { action: "write", input: CreateTokenBody, output: Type.Composite([PersonalAccessTokenSchema, Type.Object({ token: Type.String() })]) },
  authorizeMcpClient: { action: "write", input: AuthorizeMcpClientBody, output: Type.Object({ ok: Type.Literal(true), scoped: Type.Boolean(), readOnly: Type.Boolean() }) },
  listMcpClients: { action: "read", output: Type.Array(McpClientSchema) },
} as const satisfies Record<string, ResourceOperationSchema>;
export const TokenResourceSchemas = {
  revoke: { action: "write", output: Type.Object({ revoked: Type.Literal(true) }) },
  getMcpClient: { action: "read", output: Type.Composite([McpClientSchema, Type.Object({ grants: Type.Array(TokenGrantSchema) })]) },
  disconnectMcpClient: { action: "write", output: Type.Object({ ok: Type.Literal(true) }) },
} as const satisfies Record<string, ResourceOperationSchema>;
export type PersonalAccessToken = Static<typeof PersonalAccessTokenSchema>;
export type McpClient = Static<typeof McpClientSchema>;
export interface TokenOperations extends ScopedOperations<typeof TokenCollectionSchemas>, ResourceOperations<typeof TokenResourceSchemas> {}
