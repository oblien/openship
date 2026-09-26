import { Type, type Static } from "@sinclair/typebox";
import { AddDomainBody, PreviewDomainBody, UploadCertBody } from "./domain-inputs";
import { ResourceIdSchema, type DeploymentEvent } from "./deployment-resources";
import type { StreamOptions } from "./services";
import type { ResourceOperations, ResourceOperationSchema, ScopedOperations } from "./resource-operations";

const nullableString = Type.Union([Type.String(), Type.Null()]);
const nullableNumber = Type.Union([Type.Number(), Type.Null()]);

/** A failed check stays failed while waiting for its scheduled retry. */
export const DomainDiagnosticsSchema = Type.Object({
  state: Type.Union([Type.Literal("pending"), Type.Literal("failed"), Type.Literal("waiting")]),
  reason: Type.Union([
    Type.Literal("verification"),
    Type.Literal("certificate"),
    Type.Literal("deployment"),
    Type.Literal("disabled"),
    Type.Literal("removing"),
    Type.Literal("manual_certificate"),
    Type.Literal("managed_certificate"),
    Type.Literal("manual_dns"),
  ]),
  retryAction: Type.Union([Type.Literal("verify"), Type.Literal("verify_ssl"), Type.Null()]),
  nextRetryAt: nullableString,
  automaticRetry: Type.Union([
    Type.Literal("scheduled"),
    Type.Literal("disabled"),
    Type.Literal("unavailable"),
    Type.Literal("not_applicable"),
  ]),
});
export type DomainDiagnostics = Static<typeof DomainDiagnosticsSchema>;

/** Domain state contains verification guidance, never private certificate material. */
export const DomainSchema = Type.Object({
  id: Type.String(), ownerType: Type.String(), projectId: nullableString,
  webhookSourceId: nullableString, serviceId: nullableString,
  hostname: Type.String(), targetPort: nullableNumber, targetPath: nullableString,
  domainType: nullableString, isPrimary: Type.Boolean(), redirectTo: nullableString,
  redirectStatus: nullableNumber, externalIngress: Type.Boolean(), manualSsl: Type.Boolean(),
  status: Type.String(), verificationToken: nullableString, verified: Type.Boolean(),
  verifiedAt: nullableString, verifyAttempts: Type.Integer(), lastVerifyError: nullableString,
  lastCheckedAt: nullableString, sslStatus: Type.String(), sslChallenge: Type.String(),
  sslDnsMode: Type.Optional(Type.Union([Type.Literal("automatic"), Type.Literal("manual")])),
  sslIssuer: nullableString, sslExpiresAt: nullableString,
  createdAt: Type.String(), updatedAt: Type.String(),
  diagnostics: Type.Optional(Type.Union([DomainDiagnosticsSchema, Type.Null()])),
});
export type Domain = Static<typeof DomainSchema>;

export const DomainRecordsSchema = Type.Object({
  mode: Type.Union([Type.Literal("cloud"), Type.Literal("selfhosted"), Type.Literal("external")]),
  records: Type.Array(Type.Object({
    type: Type.Union([Type.Literal("A"), Type.Literal("CNAME"), Type.Literal("TXT")]),
    host: Type.String(), name: Type.String(), value: Type.String(),
  })),
});
export type DomainRecords = Static<typeof DomainRecordsSchema>;
export const CreateDomainInputSchema = Type.Omit(AddDomainBody, ["projectId"]);
export const CreateDomainResultSchema = Type.Object({
  domain: DomainSchema,
  records: DomainRecordsSchema,
  www: Type.Optional(Type.Object({ id: Type.String(), hostname: Type.String() })),
  wwwError: Type.Optional(Type.String()),
  preexistingEdgeSite: Type.Optional(Type.Object({
    hostname: Type.String(), hostnames: Type.Array(Type.String()),
    kind: Type.Union([Type.Literal("proxy"), Type.Literal("static")]),
    target: Type.String(), ssl: Type.Boolean(), source: Type.Optional(Type.String()),
  })),
});
export type CreateDomainInput = Static<typeof CreateDomainInputSchema>;
export type CreateDomainResult = Static<typeof CreateDomainResultSchema>;

export const VerifyDomainInputSchema = Type.Object({
  force: Type.Optional(Type.Boolean()),
}, { additionalProperties: false });
export type VerifyDomainInput = Static<typeof VerifyDomainInputSchema>;
export const DomainVerificationSchema = Type.Object({
  verified: Type.Boolean(), cnameVerified: Type.Boolean(), txtVerified: Type.Boolean(),
  message: Type.Optional(Type.String()), recordVerified: Type.Optional(Type.Boolean()),
  attempts: Type.Optional(Type.Integer()), sslStatus: Type.Optional(Type.String()),
});
export type DomainVerification = Static<typeof DomainVerificationSchema>;
export const DomainSslSchema = Type.Object({
  domain: Type.String(), sslStatus: Type.String(), expiresAt: Type.Optional(nullableString),
  issuer: Type.Optional(nullableString), verified: Type.Optional(Type.Boolean()),
  message: Type.Optional(Type.String()),
});
export type DomainSsl = Static<typeof DomainSslSchema>;
export const DomainDnsTargetSchema = Type.Object({
  serverId: Type.Optional(ResourceIdSchema),
}, { additionalProperties: false });

const recordAction = Type.Union([
  Type.Literal("create"), Type.Literal("update"), Type.Literal("adopt"),
  Type.Literal("in-sync"), Type.Literal("conflict"),
]);

/** Safe, durable progress for a DNS-01 certificate order. No key/CSR/account material. */
export const DomainDnsChallengeSchema = Type.Object({
  id: ResourceIdSchema,
  domainId: ResourceIdSchema,
  mode: Type.Union([Type.Literal("automatic"), Type.Literal("manual")]),
  status: Type.Union([
    Type.Literal("preparing"), Type.Literal("waiting"), Type.Literal("checking"),
    Type.Literal("installing"), Type.Literal("cancelling"), Type.Literal("completed"),
    Type.Literal("failed"), Type.Literal("cancelled"), Type.Literal("expired"),
  ]),
  record: Type.Union([Type.Object({ type: Type.Literal("TXT"), name: Type.String(), value: Type.String() }, { additionalProperties: false }), Type.Null()]),
  expiresAt: Type.String(),
  logs: Type.String(),
  error: nullableString,
  createdAt: Type.String(),
  updatedAt: Type.String(),
}, { additionalProperties: false });
export type DomainDnsChallenge = Static<typeof DomainDnsChallengeSchema>;
export const StartDomainDnsChallengeSchema = Type.Object({
  mode: Type.Union([Type.Literal("automatic"), Type.Literal("manual")], { description: "Use the connected DNS provider, or prepare a TXT record for the operator to add manually. Manual certificates also need a fresh TXT confirmation at renewal." }),
  force: Type.Optional(Type.Boolean({ description: "Request a new certificate even when one is still comfortably valid." })),
}, { additionalProperties: false });
export type StartDomainDnsChallenge = Static<typeof StartDomainDnsChallengeSchema>;
export const DomainDnsChallengeAttemptSchema = Type.Object({
  attemptId: ResourceIdSchema,
}, { additionalProperties: false });
export const DomainDnsPlanSchema = Type.Object({
  status: Type.Union([Type.Literal("matched"), Type.Literal("none"), Type.Literal("unavailable"), Type.Literal("unauthorized")]),
  provider: Type.Optional(Type.String()), zoneName: Type.Optional(Type.String()),
  reason: Type.Optional(Type.String()),
  records: Type.Array(Type.Object({
    name: Type.String(), type: Type.String(), action: recordAction,
    desired: Type.String(), current: Type.Optional(Type.String()),
  })),
});
export const DomainDnsApplySchema = Type.Object({
  provisioned: Type.Boolean(), reason: Type.Optional(Type.String()),
  records: Type.Array(Type.Object({
    name: Type.String(), type: Type.String(), action: Type.Optional(recordAction),
    outcome: Type.Union([Type.Literal("applied"), Type.Literal("skipped"), Type.Literal("failed")]),
    error: Type.Optional(Type.String()),
  })),
});
export const VerifyPendingDomainsInputSchema = Type.Object({
  minAgeMinutes: Type.Optional(Type.Number({ minimum: 0, maximum: 525_600 })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000 })),
}, { additionalProperties: false });
export const PendingDomainVerificationSchema = Type.Object({
  verified: Type.Integer(), stillPending: Type.Integer(), failed: Type.Integer(), total: Type.Integer(),
  sslIssued: Type.Optional(Type.Integer()), sslRetrying: Type.Optional(Type.Integer()),
  details: Type.Array(Type.Object({
    hostname: Type.String(),
    status: Type.Union([Type.Literal("verified"), Type.Literal("still_pending"), Type.Literal("failed")]),
    message: Type.Optional(Type.String()), error: Type.Optional(Type.String()),
  })),
});

export const DomainCollectionSchemas = {
  list: { action: "read", output: Type.Array(DomainSchema) },
  create: { action: "write", input: CreateDomainInputSchema, output: CreateDomainResultSchema },
} as const satisfies Record<string, ResourceOperationSchema>;
export const DomainResourceSchemas = {
  get: { action: "read", output: DomainSchema },
  remove: { action: "admin", output: Type.Object({ message: Type.Literal("domain removed") }) },
  verify: { action: "write", input: VerifyDomainInputSchema, optionalInput: true, output: DomainVerificationSchema },
  records: { action: "read", input: DomainDnsTargetSchema, optionalInput: true, output: DomainRecordsSchema },
  dnsPlan: { action: "read", input: DomainDnsTargetSchema, optionalInput: true, output: DomainDnsPlanSchema },
  dnsApply: { action: "write", input: DomainDnsTargetSchema, optionalInput: true, output: DomainDnsApplySchema },
  dnsChallenge: { action: "read", output: Type.Union([DomainDnsChallengeSchema, Type.Null()]) },
  startDnsChallenge: { action: "write", input: StartDomainDnsChallengeSchema, output: DomainDnsChallengeSchema },
  checkDnsChallenge: { action: "write", input: DomainDnsChallengeAttemptSchema, output: DomainDnsChallengeSchema },
  cancelDnsChallenge: { action: "write", input: DomainDnsChallengeAttemptSchema, output: DomainDnsChallengeSchema },
  setPrimary: { action: "write", output: DomainSchema },
  renewSsl: { action: "write", output: DomainSslSchema },
  verifySsl: { action: "write", output: DomainSslSchema },
  uploadCert: { action: "write", input: UploadCertBody, output: DomainSslSchema },
} as const satisfies Record<string, ResourceOperationSchema>;
export const DomainScopedSchemas = {
  preview: { action: "read", input: PreviewDomainBody, output: DomainRecordsSchema },
  renewAllSsl: { action: "write", output: Type.Object({
    renewed: Type.Integer(), results: Type.Array(Type.Object({
      domain: Type.String(), status: Type.String(), error: Type.Optional(Type.String()),
    })),
  }) },
  verifyPending: { action: "write", input: VerifyPendingDomainsInputSchema, optionalInput: true, output: PendingDomainVerificationSchema },
} as const satisfies Record<string, ResourceOperationSchema>;

export interface DomainOperations extends
  ResourceOperations<typeof DomainCollectionSchemas>,
  ResourceOperations<typeof DomainResourceSchemas>,
  ScopedOperations<typeof DomainScopedSchemas> {
  verifyStream(id: string, input?: VerifyDomainInput, options?: StreamOptions): AsyncIterable<DeploymentEvent>;
}
