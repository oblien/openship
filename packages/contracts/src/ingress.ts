import { Type, type Static } from "@sinclair/typebox";
const Id = Type.String({ minLength: 1, maxLength: 100, pattern: "^[a-zA-Z0-9_-]+$" });
const CloudflareId = Type.String({ minLength: 1, maxLength: 64, pattern: "^[a-zA-Z0-9-]+$" });
export const IngressDiscoverBody = Type.Object(
  {
    credentialId: Id,
    accountId: Type.Optional(CloudflareId),
    includePolicies: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);
export const IngressConnectBody = Type.Object(
  {
    serverId: Id,
    credentialId: Id,
    accountId: CloudflareId,
    name: Type.String({ minLength: 1, maxLength: 80 }),
    tunnelId: Type.Optional(CloudflareId),
    connector: Type.Union([Type.Literal("existing"), Type.Literal("managed")]),
    edgePort: Type.Optional(Type.Integer({ minimum: 1, maximum: 65535 })),
    defaultForDomains: Type.Boolean(),
    defaultAccessPolicyId: Type.Optional(CloudflareId),
  },
  { additionalProperties: false },
);
export const IngressUpdateBody = Type.Object(
  {
    id: Id,
    defaultForDomains: Type.Boolean(),
    defaultAccessPolicyId: Type.Union([CloudflareId, Type.Null()]),
  },
  { additionalProperties: false },
);
export const IngressUpdateHttpBody = Type.Omit(IngressUpdateBody, ["id"]);
export type IngressUpdateInput = Static<typeof IngressUpdateBody>;
export const IngressDomainBody = Type.Object(
  {
    domainId: Id,
    connectionId: Type.Union([Id, Type.Null()]),
    accessPolicyId: Type.Optional(Type.Union([CloudflareId, Type.Null()])),
  },
  { additionalProperties: false },
);
export const IngressDomainHttpBody = Type.Omit(IngressDomainBody, ["domainId"]);
export const IngressListBody = Type.Object(
  { serverId: Type.Optional(Id) },
  { additionalProperties: false },
);
export const IngressDomainQuery = Type.Object({ domainId: Id }, { additionalProperties: false });
export const IngressConnectionSchema = Type.Object(
  {
    id: Id,
    serverId: Id,
    credentialId: Id,
    accountId: Type.String(),
    tunnelId: Type.Union([Type.String(), Type.Null()]),
    name: Type.String(),
    connector: Type.Union([Type.Literal("existing"), Type.Literal("managed")]),
    edgePort: Type.Integer(),
    managedTunnel: Type.Boolean(),
    defaultForDomains: Type.Boolean(),
    defaultAccessPolicyId: Type.Union([Type.String(), Type.Null()]),
    status: Type.String(),
    error: Type.Union([Type.String(), Type.Null()]),
  },
  { additionalProperties: false },
);
export const IngressHostnameSchema = Type.Object(
  {
    id: Id,
    domainId: Type.Union([Id, Type.Null()]),
    connectionId: Id,
    hostname: Type.String(),
    accessPolicyId: Type.Union([Type.String(), Type.Null()]),
    status: Type.String(),
    phase: Type.String(),
    error: Type.Union([Type.String(), Type.Null()]),
  },
  { additionalProperties: false },
);
export const IngressDiscoverySchema = Type.Object({
  accounts: Type.Array(Type.Object({ id: Type.String(), name: Type.String() })),
  tunnels: Type.Array(
    Type.Object({
      id: Type.String(),
      name: Type.String(),
      remote: Type.Boolean(),
      status: Type.String(),
    }),
  ),
  policies: Type.Array(
    Type.Object({ id: Type.String(), name: Type.String(), decision: Type.String() }),
  ),
  policiesError: Type.Union([Type.String(), Type.Null()]),
});
export type IngressConnection = Static<typeof IngressConnectionSchema>;
export type IngressHostname = Static<typeof IngressHostnameSchema>;
export type IngressConnectInput = Static<typeof IngressConnectBody>;
export type IngressDomainInput = Static<typeof IngressDomainBody>;
export type IngressDiscovery = Static<typeof IngressDiscoverySchema>;
