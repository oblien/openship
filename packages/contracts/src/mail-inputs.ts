/** Shared inputs for mail administration and the resumable setup wizard. */
import { Type } from "@sinclair/typebox";
import { RELAY_PROVIDER_IDS } from "@repo/core";
import { ResourceIdSchema } from "./deployment-resources";
import { CreateBackupPolicySchema } from "./backups";

const optionalText = Type.Optional(Type.String());
const optionalCount = Type.Optional(Type.Integer({ minimum: 0 }));
const nullableText = Type.Union([Type.String(), Type.Null()]);
const provider = Type.Union(RELAY_PROVIDER_IDS.map(id => Type.Literal(id)));
const port = Type.Integer({ minimum: 1, maximum: 65535 });
const dkim = Type.Array(Type.Object({ name: Type.String(), value: Type.String() }));
const identity = { mailFromDomain: optionalText, sesDkim: Type.Optional(dkim) };
const password = Type.String({ minLength: 12, pattern: "^[^\\u0000-\\u001f\\u007f]*$" });
const domainFields = {
  description: optionalText,
  maxMailboxes: optionalCount,
  maxAliases: optionalCount,
  defaultQuotaMB: optionalCount,
};
const mailboxFields = {
  name: optionalText,
  quotaMB: optionalCount,
};
const inboundFields = {
  name: Type.String({ minLength: 1 }),
  scope: Type.Union([Type.Literal("mailbox"), Type.Literal("domain"), Type.Literal("all")]),
  target: Type.Optional(nullableText),
  channelIds: Type.Array(ResourceIdSchema),
  enabled: Type.Optional(Type.Boolean()),
  fromPattern: Type.Optional(nullableText),
  subjectPattern: Type.Optional(nullableText),
  maxSpamScore: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
};

export const MailRequestSchemas = {
  setup: Type.Object({
    serverId: ResourceIdSchema, domain: Type.String({ minLength: 1 }),
    startStep: Type.Optional(Type.Integer({ minimum: 1 })),
    config: Type.Optional(Type.Object({
      adminPassword: Type.Optional(password),
      storageBackend: Type.Optional(Type.Union([Type.Literal("mariadb"), Type.Literal("postgresql")])),
    }, { additionalProperties: false })),
  }, { additionalProperties: false }),
  postmasterPassword: Type.Object({ serverId: ResourceIdSchema, password }, { additionalProperties: false }),
  acknowledgeDns: Type.Object({ serverId: ResourceIdSchema, domain: optionalText }),
  requiredDomain: Type.Object({ domain: Type.String({ minLength: 1 }) }, { additionalProperties: false }),
  componentAction: Type.Object({ action: Type.Union([Type.Literal("start"), Type.Literal("stop"), Type.Literal("restart")]) }, { additionalProperties: false }),
  configureRelay: Type.Object({
    provider, scope: Type.Optional(Type.Union([Type.Literal("all"), Type.Literal("selected")])),
    domains: Type.Optional(Type.Array(Type.String())), addresses: Type.Optional(Type.Array(Type.String())),
    spfInclude: optionalText, region: optionalText, host: optionalText, port,
    username: Type.String(), password: optionalText, ...identity,
    identities: Type.Optional(Type.Record(Type.String(), Type.Object(identity))),
  }, { additionalProperties: false }),
  deployExternalWebmail: Type.Object({
    hostname: Type.String({ minLength: 1 }),
    backend: Type.Object({ provider, imapHost: Type.String({ minLength: 1 }), imapPort: port, smtpHost: Type.String({ minLength: 1 }), smtpPort: port }),
    target: Type.Union([
      Type.Object({ deployTarget: Type.Literal("server"), serverId: ResourceIdSchema }),
      Type.Object({ deployTarget: Type.Literal("cloud"), serverId: Type.Optional(ResourceIdSchema) }),
    ]),
  }, { additionalProperties: false }),
  server: Type.Object({ serverId: ResourceIdSchema }),
  status: Type.Object({ serverId: Type.Optional(ResourceIdSchema) }),
  health: Type.Object({ refreshReachability: Type.Optional(Type.Boolean()) }),
  certificate: Type.Object({ autoRenew: Type.Boolean() }, { additionalProperties: false }),
  domainFilter: Type.Object({ domain: optionalText }),
  logs: Type.Object({ lines: Type.Optional(Type.Integer({ minimum: 1 })) }),
  createDomain: Type.Object({ domain: Type.String({ minLength: 1 }), ...domainFields }),
  updateDomain: Type.Object({ ...domainFields, active: Type.Optional(Type.Boolean()) }),
  deleteDomain: Type.Object({ cascade: Type.Optional(Type.Boolean({ default: false })) }),
  createMailbox: Type.Object({
    localPart: Type.String({ minLength: 1 }),
    domain: Type.String({ minLength: 1 }),
    password: Type.String({ minLength: 1 }),
    ...mailboxFields,
  }),
  updateMailbox: Type.Object({
    ...mailboxFields,
    password: optionalText,
    active: Type.Optional(Type.Boolean()),
  }),
  deleteMailbox: Type.Object({ hard: Type.Optional(Type.Boolean({ default: false })) }),
  createAlias: Type.Object({
    domain: Type.String({ minLength: 1 }),
    localPart: optionalText,
    isCatchAll: Type.Optional(Type.Boolean()),
    destination: Type.String({ minLength: 1 }),
  }),
  updateAlias: Type.Object({ active: Type.Boolean() }),
  saveBackupPolicy: Type.Object({
    destinationId: ResourceIdSchema,
    messageData: Type.Optional(Type.Boolean({ default: false })),
    keys: Type.Optional(Type.Boolean({ default: true })),
    cronExpression: CreateBackupPolicySchema.properties.cronExpression,
    retainCount: CreateBackupPolicySchema.properties.retainCount,
    retainDays: CreateBackupPolicySchema.properties.retainDays,
  }),
  testEmail: Type.Object({ to: Type.String({ minLength: 1 }), fromDomain: optionalText }),
  createInboundRule: Type.Object(inboundFields),
  updateInboundRule: Type.Partial(Type.Object({ ...inboundFields, pausedReason: Type.Null() })),
  deployWebmail: Type.Object({
    mailServerId: ResourceIdSchema,
    hostname: Type.String({ minLength: 1 }),
    target: Type.Union([
      Type.Object({ kind: Type.Literal("self"), serverId: ResourceIdSchema }),
      Type.Object({ kind: Type.Literal("cloud"), serverId: Type.Optional(ResourceIdSchema) }),
    ]),
    replaceLegacy: Type.Optional(Type.Boolean({ default: false })),
    reconnectProjectId: Type.Optional(ResourceIdSchema),
  }),
} as const;
