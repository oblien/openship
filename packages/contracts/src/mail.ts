import { Type, type Static } from "@sinclair/typebox";
import type { MailCertificateHealth, MailCertificateStatus } from "@repo/core";
import { MailRequestSchemas as input } from "./mail-inputs";
import { BackupPolicySchema, BackupRunSchema } from "./backups";
import { DomainDnsPlanSchema, DomainDnsApplySchema } from "./domains";
import type { DeploymentEvent } from "./deployment-resources";
import type {
  ResourceOperationSchema,
  ResourceOperations,
  ScopedOperations,
  ChildResourceOperations,
} from "./resource-operations";

const text = Type.String();
const count = Type.Number();
const optionalText = Type.Optional(text);
const nullableText = Type.Union([text, Type.Null()]);
const nullableCount = Type.Union([count, Type.Null()]);
const ok = Type.Object({ ok: Type.Literal(true) });
const status = Type.Union([
  Type.Literal("ok"),
  Type.Literal("warn"),
  Type.Literal("fail"),
  Type.Literal("unknown"),
]);
export const MailSetupStepSchema = Type.Object({
  id: count,
  key: text,
  label: text,
  description: text,
});
export const MailComponentStatusSchema = Type.Union([
  Type.Literal("active"),
  Type.Literal("inactive"),
  Type.Literal("failed"),
  Type.Literal("activating"),
  Type.Literal("deactivating"),
  Type.Literal("missing"),
  Type.Literal("unknown"),
]);
export const MailComponentDefinitionSchema = Type.Object({
  key: text,
  label: text,
  description: text,
  unit: text,
  severity: Type.Union([
    Type.Literal("required"),
    Type.Literal("advisory"),
    Type.Literal("informational"),
  ]),
});
const componentState = {
  status: MailComponentStatusSchema,
  subState: optionalText,
  activeSince: optionalText,
  detail: optionalText,
};
export const MailComponentHealthSchema = Type.Object({
  ...MailComponentDefinitionSchema.properties,
  ...componentState,
});
export const MailDeliveryHealthSchema = Type.Object({
  status,
  mode: Type.Union([Type.Literal("direct"), Type.Literal("relay")]),
  relayHost: optionalText,
  relayScope: Type.Optional(Type.Union([Type.Literal("all"), Type.Literal("selected")])),
  relayDomains: Type.Optional(Type.Array(text)),
  queued: count,
  sampled: Type.Boolean(),
  deferrals: Type.Array(
    Type.Object({
      kind: Type.Union([
        Type.Literal("auth"),
        Type.Literal("tls"),
        Type.Literal("network"),
        Type.Literal("rejected"),
        Type.Literal("other"),
      ]),
      count,
      reason: text,
    }),
  ),
  detail: optionalText,
});
export type MailDeliveryHealth = Static<typeof MailDeliveryHealthSchema>;
export const MailPortReachabilitySchema = Type.Object({
  hostname: text,
  address: nullableText,
  checkedAt: count,
  status: Type.Union([Type.Literal("ok"), Type.Literal("fail"), Type.Literal("unknown")]),
  detail: optionalText,
  ports: Type.Array(
    Type.Object({
      key: Type.Union([
        Type.Literal("smtp"),
        Type.Literal("smtps"),
        Type.Literal("submission"),
        Type.Literal("imaps"),
      ]),
      port: count,
      label: text,
      status: Type.Union([
        Type.Literal("reachable"),
        Type.Literal("blocked"),
        Type.Literal("not_listening"),
        Type.Literal("not_exposed"),
        Type.Literal("unknown"),
      ]),
      listening: Type.Union([Type.Boolean(), Type.Null()]),
      exposed: Type.Union([Type.Boolean(), Type.Null()]),
      reachable: Type.Union([Type.Boolean(), Type.Null()]),
      failure: Type.Optional(
        Type.Union([
          Type.Literal("timeout"),
          Type.Literal("refused"),
          Type.Literal("unresolved"),
          Type.Literal("no_route"),
          Type.Literal("error"),
        ]),
      ),
      detail: optionalText,
    }),
  ),
});
const certificateInfo = Type.Union([
  Type.Null(),
  Type.Object({ expiresAt: text, issuer: text, fingerprint: text }),
]);
/** Runtime validation for the core's shared public certificate type. */
export const MailCertificateHealthSchema = Type.Unsafe<MailCertificateHealth>(
  Type.Object({
    hostname: text,
    checkedAt: text,
    status,
    reason: Type.Optional(
      Type.Union([
        Type.Literal("expired"),
        Type.Literal("expiring"),
        Type.Literal("missing"),
        Type.Literal("untrusted"),
        Type.Literal("not_loaded"),
        Type.Literal("unavailable"),
      ]),
    ),
    detail: optionalText,
    certificate: certificateInfo,
    endpoints: Type.Array(
      Type.Object({
        protocol: Type.Union([Type.Literal("smtp"), Type.Literal("smtps"), Type.Literal("imap")]),
        port: count,
        certificate: certificateInfo,
        trusted: Type.Boolean(),
        detail: optionalText,
      }),
    ),
  }),
);
export const MailCertificateStatusSchema = Type.Unsafe<MailCertificateStatus>(
  Type.Object({
    serverId: text,
    hostname: text,
    autoRenew: Type.Boolean(),
    renewalJobEnabled: Type.Boolean(),
    desktop: Type.Boolean(),
    lastRenewalError: nullableText,
    health: Type.Union([MailCertificateHealthSchema, Type.Null()]),
  }),
);
export const MailHealthSchema = Type.Object({
  serverId: text,
  components: Type.Array(MailComponentHealthSchema),
  definitions: Type.Array(MailComponentDefinitionSchema),
  delivery: MailDeliveryHealthSchema,
  reachability: Type.Union([MailPortReachabilitySchema, Type.Null()]),
  certificate: Type.Union([MailCertificateHealthSchema, Type.Null()]),
});
export const MailCredentialsSchema = Type.Object(
  { username: text, smtpHost: text, smtpPort: count, imapHost: text, imapPort: count },
  { additionalProperties: false },
);
export const MailWebmailSummarySchema = Type.Object({
  serverId: Type.Optional(nullableText),
  workspaceId: Type.Optional(nullableText),
  installed: Type.Boolean(),
  hostname: text,
  url: text,
  routingUnknown: Type.Optional(Type.Boolean()),
  projectId: Type.Optional(nullableText),
  legacy: Type.Optional(Type.Boolean()),
});
export const MailWebmailRecoveryCandidateSchema = Type.Object({
  projectId: text,
  name: text,
  hostname: text,
  serverId: text,
});
export type MailWebmailRecoveryCandidate = Static<typeof MailWebmailRecoveryCandidateSchema>;
export const MailSetupStatusSchema = Type.Object({
  active: Type.Boolean(),
  serverId: optionalText,
  domain: optionalText,
  currentStep: Type.Optional(count),
  startedAt: Type.Optional(count),
  finishedAt: Type.Optional(count),
  dnsRecords: Type.Optional(Type.Record(text, Type.Unknown())),
  dnsAcknowledged: Type.Optional(Type.Boolean()),
  ptrAcknowledged: Type.Optional(Type.Boolean()),
  credentials: Type.Optional(MailCredentialsSchema),
  webmail: Type.Optional(MailWebmailSummarySchema),
  webmailRecoveryCandidates: Type.Optional(Type.Array(MailWebmailRecoveryCandidateSchema)),
  observationError: Type.Optional(text),
  engine: Type.Optional(
    Type.Object({
      flavor: Type.Union([Type.Literal("container"), Type.Literal("host"), Type.Literal("none")]),
      running: Type.Boolean(),
    }),
  ),
  steps: Type.Array(
    Type.Object({
      ...MailSetupStepSchema.properties,
      // The welcome response has only step definitions, before a session exists.
      status: Type.Optional(
        Type.Union([
          Type.Literal("pending"),
          Type.Literal("running"),
          Type.Literal("completed"),
          Type.Literal("failed"),
          Type.Literal("skipped"),
        ]),
      ),
      message: optionalText,
      warning: optionalText,
      data: Type.Optional(Type.Record(text, Type.Unknown())),
    }),
  ),
  logs: Type.Optional(
    Type.Array(
      Type.Object({
        stepId: count,
        level: Type.Union([Type.Literal("info"), Type.Literal("warn"), Type.Literal("error")]),
        message: text,
        ts: count,
      }),
    ),
  ),
  resumeStep: Type.Optional(count),
  errorMessage: optionalText,
});
export const MailDomainSchema = Type.Object({
  domain: text,
  description: text,
  mailboxes: count,
  aliases: count,
  maxMailboxes: count,
  maxAliases: count,
  defaultQuotaMB: count,
  active: Type.Boolean(),
  createdAt: text,
});
export const MailMailboxSchema = Type.Object(
  {
    username: text,
    name: text,
    domain: text,
    quotaMB: count,
    storagebasedirectory: text,
    storagenode: text,
    maildir: text,
    active: Type.Boolean(),
    isAdmin: Type.Boolean(),
    isGlobalAdmin: Type.Boolean(),
    createdAt: text,
    passwordLastChange: text,
    isPlatform: Type.Boolean(),
  },
  { additionalProperties: false },
);
export const MailAliasSchema = Type.Object({
  id: count,
  address: text,
  forwarding: text,
  domain: text,
  destDomain: text,
  isCatchAll: Type.Boolean(),
  active: Type.Boolean(),
});
export const MailDnsRecordSchema = Type.Object({
  type: text,
  name: text,
  value: text,
  priority: Type.Optional(count),
  required: Type.Optional(Type.Boolean()),
});
export const MailDomainDnsSchema = Type.Object({
  domain: text,
  records: Type.Object({
    mx: MailDnsRecordSchema,
    spf: MailDnsRecordSchema,
    dkim: MailDnsRecordSchema,
    dmarc: MailDnsRecordSchema,
  }),
  acknowledgedAt: nullableText,
  createdAt: text,
});
export const MailDnsScanSchema = Type.Object({
  domain: text,
  scannedAt: count,
  checks: Type.Array(
    Type.Object({
      key: text,
      label: text,
      description: text,
      queriedName: text,
      recordType: text,
      status: Type.Union([
        Type.Literal("pass"),
        Type.Literal("warn"),
        Type.Literal("fail"),
        Type.Literal("unknown"),
      ]),
      expected: text,
      actual: text,
      message: text,
    }),
  ),
});
export const MailStatsSchema = Type.Object({
  domains: Type.Object({ total: count, active: count }),
  mailboxes: Type.Object({ total: count, active: count }),
  aliases: Type.Object({ total: count }),
  storageBytes: count,
  messages: count,
});
const { password: _password, ...relayFields } = input.configureRelay.properties;
export const MailRelaySchema = Type.Object(
  {
    ...relayFields,
    enabled: Type.Boolean(),
    host: text,
    updatedAt: text,
    hasPassword: Type.Boolean(),
  },
  { additionalProperties: false },
);
export const MailInboundRuleSchema = Type.Object({
  id: text,
  name: text,
  scope: input.createInboundRule.properties.scope,
  target: nullableText,
  fromPattern: nullableText,
  subjectPattern: nullableText,
  maxSpamScore: nullableCount,
  channelIds: Type.Array(text),
  enabled: Type.Boolean(),
  pausedReason: nullableText,
  lastMatchedAt: nullableText,
  createdAt: text,
});
const webmailResult = Type.Object({ deploymentId: text, projectId: text });
export const MailScopedSchemas = {
  getSteps: {
    action: "read",
    output: Type.Object({ steps: Type.Array(MailSetupStepSchema), total: count }),
  },
  getStatus: {
    action: "read",
    input: input.status,
    optionalInput: true,
    output: MailSetupStatusSchema,
  },
  listServers: {
    action: "read",
    output: Type.Array(
      Type.Object({
        id: text,
        name: text,
        host: text,
        port: count,
        user: text,
        domain: nullableText,
        completed: Type.Boolean(),
        active: Type.Boolean(),
        resumeStep: nullableCount,
        resumeStepLabel: nullableText,
      }),
    ),
  },
  scan: {
    action: "read",
    input: input.server,
    output: Type.Object({
      serverId: text,
      iredmailInstalled: Type.Boolean(),
      hasState: Type.Boolean(),
      domain: nullableText,
      installComplete: Type.Boolean(),
      webmailPresent: Type.Boolean(),
      adoptable: Type.Boolean(),
    }),
  },
  adopt: {
    action: "write",
    input: input.server,
    output: Type.Object({
      success: Type.Literal(true),
      serverId: text,
      domain: text,
      completed: Type.Boolean(),
    }),
  },
  cancelSetup: {
    action: "write",
    output: Type.Object({ ok: Type.Literal(true), message: optionalText }),
  },
  acknowledgeDns: { action: "write", input: input.acknowledgeDns, output: ok },
  acknowledgePtr: { action: "write", input: input.server, output: ok },
  resetSetup: { action: "admin", input: input.server, output: ok },
  setPostmasterPassword: { action: "admin", input: input.postmasterPassword, output: ok },
  getWebmailTargets: {
    action: "read",
    input: input.server,
    output: Type.Array(
      Type.Object({
        kind: Type.Union([Type.Literal("mail"), Type.Literal("server"), Type.Literal("opshcloud")]),
        serverId: text,
        label: text,
        description: optionalText,
        disabled: Type.Optional(Type.Boolean()),
        disabledReason: optionalText,
      }),
    ),
  },
  deployWebmail: { action: "write", input: input.deployWebmail, output: webmailResult },
  deployExternalWebmail: {
    action: "write",
    input: input.deployExternalWebmail,
    output: webmailResult,
  },
} as const satisfies Record<string, ResourceOperationSchema>;

export const MailServerSchemas = {
  forget: { action: "admin", output: ok },
  getHealth: { action: "read", input: input.health, optionalInput: true, output: MailHealthSchema },
  getCertificate: { action: "read", output: MailCertificateStatusSchema },
  checkCertificate: { action: "read", output: MailCertificateStatusSchema },
  renewCertificate: { action: "admin", output: MailCertificateStatusSchema },
  updateCertificate: {
    action: "admin",
    input: input.certificate,
    output: MailCertificateStatusSchema,
  },
  listDomains: { action: "read", output: Type.Array(MailDomainSchema) },
  createDomain: {
    action: "write",
    input: input.createDomain,
    output: Type.Object({ domain: MailDomainSchema, dnsWarning: optionalText }),
  },
  pendingDomainDns: { action: "read", output: Type.Array(MailDomainDnsSchema) },
  listMailboxes: {
    action: "read",
    input: input.requiredDomain,
    output: Type.Array(MailMailboxSchema),
  },
  createMailbox: { action: "write", input: input.createMailbox, output: MailMailboxSchema },
  rotatePlatformMailbox: {
    action: "admin",
    output: Type.Object({ ok: Type.Literal(true), email: text, rotated: Type.Boolean() }),
  },
  listAliases: { action: "read", input: input.requiredDomain, output: Type.Array(MailAliasSchema) },
  createAlias: { action: "write", input: input.createAlias, output: MailAliasSchema },
  getStats: { action: "read", output: MailStatsSchema },
  getBackupPolicy: { action: "read", output: Type.Union([BackupPolicySchema, Type.Null()]) },
  saveBackupPolicy: { action: "admin", input: input.saveBackupPolicy, output: BackupPolicySchema },
  listBackupRuns: { action: "read", output: Type.Array(BackupRunSchema) },
  scanDns: {
    action: "read",
    input: input.domainFilter,
    optionalInput: true,
    output: MailDnsScanSchema,
  },
  getRelay: { action: "read", output: Type.Union([MailRelaySchema, Type.Null()]) },
  configureRelay: { action: "admin", input: input.configureRelay, output: MailRelaySchema },
  removeRelay: { action: "admin", output: ok },
  sendTestEmail: {
    action: "write",
    input: input.testEmail,
    output: Type.Object({ to: text, from: text, messageId: text, smtpResponse: text }),
  },
  restartComponents: {
    action: "admin",
    output: Type.Object({
      results: Type.Array(
        Type.Object({ key: text, unit: text, ok: Type.Boolean(), error: optionalText }),
      ),
    }),
  },
  listInboundRules: { action: "read", output: Type.Array(MailInboundRuleSchema) },
  createInboundRule: {
    action: "write",
    input: input.createInboundRule,
    output: MailInboundRuleSchema,
  },
  testInboundRules: {
    action: "read",
    output: Type.Object({
      read: count,
      matched: count,
      emitted: count,
      dropped: count,
      errors: Type.Array(text),
    }),
  },
} as const satisfies Record<string, ResourceOperationSchema>;

export const MailDomainSchemas = {
  getDomain: { action: "read", output: MailDomainSchema },
  updateDomain: { action: "write", input: input.updateDomain, output: MailDomainSchema },
  removeDomain: { action: "admin", input: input.deleteDomain, optionalInput: true, output: ok },
  domainDependents: { action: "read", output: Type.Object({ mailboxes: count, aliases: count }) },
  getDomainDns: { action: "read", output: MailDomainDnsSchema },
  acknowledgeDomainDns: { action: "write", output: ok },
  planDomainDns: { action: "read", output: DomainDnsPlanSchema },
  applyDomainDns: { action: "write", output: DomainDnsApplySchema },
} as const satisfies Record<string, ResourceOperationSchema>;
export const MailMailboxSchemas = {
  getMailbox: { action: "read", output: MailMailboxSchema },
  updateMailbox: { action: "write", input: input.updateMailbox, output: MailMailboxSchema },
  removeMailbox: {
    action: "admin",
    input: input.deleteMailbox,
    optionalInput: true,
    output: Type.Object({
      ok: Type.Literal(true),
      mode: Type.Union([Type.Literal("hard"), Type.Literal("soft")]),
    }),
  },
} as const satisfies Record<string, ResourceOperationSchema>;
export const MailAliasSchemas = {
  updateAlias: { action: "write", input: input.updateAlias, output: MailAliasSchema },
  removeAlias: { action: "admin", output: ok },
} as const satisfies Record<string, ResourceOperationSchema>;
export const MailInboundSchemas = {
  updateInboundRule: {
    action: "write",
    input: input.updateInboundRule,
    output: MailInboundRuleSchema,
  },
  removeInboundRule: { action: "write", output: ok },
} as const satisfies Record<string, ResourceOperationSchema>;
export const MailComponentSchemas = {
  componentLogs: {
    action: "read",
    input: input.logs,
    optionalInput: true,
    output: Type.Object({ key: text, unit: text, lines: Type.Array(text), source: text }),
  },
  componentAction: {
    action: "admin",
    input: input.componentAction,
    output: Type.Object({
      key: text,
      unit: text,
      action: input.componentAction.properties.action,
      output: text,
      settled: Type.Optional(Type.Object(componentState)),
    }),
  },
} as const satisfies Record<string, ResourceOperationSchema>;

/** Remote administration of an existing self-hosted mail controller. Server-side grants and ownership still apply. */
export interface MailOperations
  extends
    ScopedOperations<typeof MailScopedSchemas>,
    ResourceOperations<typeof MailServerSchemas>,
    ChildResourceOperations<typeof MailDomainSchemas>,
    ChildResourceOperations<typeof MailMailboxSchemas>,
    ChildResourceOperations<typeof MailAliasSchemas>,
    ChildResourceOperations<typeof MailInboundSchemas>,
    ChildResourceOperations<typeof MailComponentSchemas> {
  /** Explicitly start/resume once. DNS/PTR holds require acknowledgment and a new call; disconnects never restart setup. */
  setup(
    value: Static<typeof input.setup>,
    options?: { signal?: AbortSignal },
  ): AsyncIterable<DeploymentEvent>;
}
