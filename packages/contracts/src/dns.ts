import {
  IngressDiscoverBody,
  IngressConnectBody,
  IngressUpdateBody,
  IngressDomainBody,
  IngressListBody,
  IngressDomainQuery,
  IngressConnectionSchema,
  IngressHostnameSchema,
  IngressDiscoverySchema,
} from "./ingress";
import { Type, type Static } from "@sinclair/typebox";
import { AddDnsCredentialBody, VerifyZoneBody } from "./dns-inputs";
import { ResourceIdSchema } from "./deployment-resources";
import type { ResourceOperationSchema, ScopedOperations } from "./resource-operations";

export const DnsCredentialSchema = Type.Object(
  {
    id: Type.String(),
    organizationId: Type.String(),
    provider: Type.String(),
    name: Type.String(),
    status: Type.String(),
    tokenMasked: Type.String(),
    lastVerifiedAt: Type.Union([Type.String(), Type.Null()]),
    createdAt: Type.String(),
    updatedAt: Type.String(),
  },
  { additionalProperties: false },
);
export type DnsCredential = Static<typeof DnsCredentialSchema>;
export const DnsProviderSchema = Type.Object({
  name: Type.String(),
  displayName: Type.String(),
  description: Type.String(),
  requiredScopes: Type.Array(Type.String()),
  tokenUrl: Type.Optional(Type.String()),
});
export const DnsZoneLookupSchema = Type.Union([
  Type.Object({
    matched: Type.Literal(true),
    status: Type.Literal("matched"),
    provider: Type.String(),
    credentialId: Type.String(),
    zoneName: Type.String(),
    zoneId: Type.String(),
  }),
  Type.Object({
    matched: Type.Literal(false),
    status: Type.Literal("unauthorized"),
    credentialId: Type.String(),
    message: Type.String(),
  }),
  Type.Object({
    matched: Type.Literal(false),
    status: Type.Union([Type.Literal("unavailable"), Type.Literal("none")]),
    message: Type.String(),
  }),
]);
export type DnsZoneLookup = Static<typeof DnsZoneLookupSchema>;
export const DnsOperationSchemas = {
  listIngressConnections: {
    action: "read",
    input: IngressListBody,
    output: Type.Array(IngressConnectionSchema),
  },
  discoverIngress: { action: "admin", input: IngressDiscoverBody, output: IngressDiscoverySchema },
  connectIngress: { action: "admin", input: IngressConnectBody, output: IngressConnectionSchema },
  updateIngress: { action: "admin", input: IngressUpdateBody, output: IngressConnectionSchema },
  retryIngress: { action: "admin", input: ResourceIdSchema, output: IngressConnectionSchema },
  removeIngress: {
    action: "admin",
    input: ResourceIdSchema,
    output: Type.Object({ success: Type.Literal(true) }),
  },
  getDomainIngress: {
    action: "read",
    input: IngressDomainQuery,
    output: Type.Union([IngressHostnameSchema, Type.Null()]),
  },
  setDomainIngress: {
    action: "admin",
    input: IngressDomainBody,
    output: Type.Union([IngressHostnameSchema, Type.Null()]),
  },
  listProviders: { action: "read", output: Type.Array(DnsProviderSchema) },
  listCredentials: { action: "read", output: Type.Array(DnsCredentialSchema) },
  getCredential: { action: "read", input: ResourceIdSchema, output: DnsCredentialSchema },
  addCredential: { action: "admin", input: AddDnsCredentialBody, output: DnsCredentialSchema },
  removeCredential: {
    action: "admin",
    input: ResourceIdSchema,
    output: Type.Object({ success: Type.Literal(true) }),
  },
  verifyZone: { action: "read", input: VerifyZoneBody, output: DnsZoneLookupSchema },
} as const satisfies Record<string, ResourceOperationSchema>;
export type DnsOperations = ScopedOperations<typeof DnsOperationSchemas>;
