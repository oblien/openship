import { Type, type Static } from "@sinclair/typebox";
import type { ResourceOperationSchema } from "./resource-operations";

const nullableString = Type.Union([Type.String(), Type.Null()]);
const nullableBoolean = Type.Union([Type.Boolean(), Type.Null()]);
const confirmed = Type.Object({ confirm: Type.Literal(true) }, { additionalProperties: false });
const revision = Type.String({ pattern: "^[a-f0-9]{64}$" });
const workloadId = Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$" });
const tail = Type.Integer({ minimum: 1, maximum: 500 });
const proxyHost = Type.String({ minLength: 7, maxLength: 15, pattern: "^[0-9]+(?:\\.[0-9]+){3}$" });
const proxyProtocol = Type.Union([Type.Literal("http"), Type.Literal("https")]);
const proxyCredential = Type.String({
  minLength: 1,
  maxLength: 256,
  pattern: "^[\\x21-\\x7e]+$",
  not: { pattern: "[:@/?]" },
});

export const ManagedOutboundSchema = Type.Object(
  {
    mode: Type.Union([Type.Literal("managed"), Type.Literal("custom"), Type.Null()]),
    ip: nullableString,
    countryCode: nullableString,
    proxy: Type.Union([
      Type.Object(
        {
          host: proxyHost,
          port: Type.Integer({ minimum: 1, maximum: 65535 }),
          protocol: proxyProtocol,
          hasCredentials: Type.Boolean(),
        },
        { additionalProperties: false },
      ),
      Type.Null(),
    ]),
    /** Missing provider version or incomplete observation: inspect, but do not edit. */
    revision: Type.Union([revision, Type.Null()]),
  },
  { additionalProperties: false },
);

const outboundReview = { expectedRevision: revision, confirm: Type.Literal(true) };
const customProxy = {
  host: proxyHost,
  port: Type.Integer({ minimum: 1, maximum: 65535 }),
  protocol: proxyProtocol,
};

export const ManagedServerInfoSchema = Type.Object(
  {
    workspaceId: Type.String(),
    image: Type.String(),
    state: Type.String(),
    mode: nullableString,
    operatingSystem: nullableString,
    restartPolicy: nullableString,
    resources: Type.Object(
      {
        cpuCores: Type.Number({ minimum: 0 }),
        memoryMb: Type.Number({ minimum: 0 }),
        diskMb: Type.Number({ minimum: 0 }),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

export const ManagedSshStatusSchema = Type.Object(
  {
    enabled: nullableBoolean,
    keyConfigured: nullableBoolean,
    passwordConfigured: nullableBoolean,
    requiresIdentityAccess: Type.Boolean(),
    connection: Type.Union([
      Type.Object(
        {
          user: Type.String(),
          host: Type.String(),
          bastion: Type.String(),
          command: Type.String(),
        },
        { additionalProperties: false },
      ),
      Type.Null(),
    ]),
  },
  { additionalProperties: false },
);
export const ManagedSshResultSchema = Type.Object(
  {
    status: ManagedSshStatusSchema,
    /** The provider returns an initial password only once; never persist it. */
    initialPassword: nullableString,
  },
  { additionalProperties: false },
);
export const ManagedRuntimeStatusSchema = Type.Object(
  {
    enabled: nullableBoolean,
    running: nullableBoolean,
  },
  { additionalProperties: false },
);
export const ManagedRuntimeCredentialSchema = Type.Object(
  {
    endpoint: Type.String(),
    token: Type.String({ minLength: 1 }),
    revision,
    expiresAt: nullableString,
  },
  { additionalProperties: false },
);

export const ManagedWorkloadSchema = Type.Object(
  {
    id: workloadId,
    name: Type.String(),
    state: Type.String(),
    restartPolicy: nullableString,
    source: Type.Union([Type.Literal("manual"), Type.Literal("project"), Type.Literal("system")]),
    projectId: nullableString,
    manageable: Type.Boolean(),
  },
  { additionalProperties: false },
);
const logs = Type.Object(
  {
    logs: Type.String(),
    truncated: Type.Boolean(),
  },
  { additionalProperties: false },
);

/** These controls belong to a single managed server. Never accept provider
 * workspace IDs, namespace tokens, arbitrary provider paths or raw config. */
export const ManagedServerResourceSchemas = {
  managedOutbound: { action: "read", output: ManagedOutboundSchema },
  managedOutboundOptions: {
    action: "read",
    output: Type.Object(
      {
        ips: Type.Array(
          Type.Object(
            { ip: proxyHost, countryCode: nullableString },
            { additionalProperties: false },
          ),
        ),
      },
      { additionalProperties: false },
    ),
  },
  setManagedOutbound: {
    action: "admin",
    input: Type.Union([
      Type.Object(
        { ...outboundReview, mode: Type.Literal("managed"), ip: Type.Optional(proxyHost) },
        { additionalProperties: false },
      ),
      Type.Object(
        {
          ...outboundReview,
          mode: Type.Literal("custom"),
          proxy: Type.Union([
            Type.Object(customProxy, { additionalProperties: false }),
            Type.Object(
              { ...customProxy, username: proxyCredential, password: proxyCredential },
              { additionalProperties: false },
            ),
          ]),
        },
        { additionalProperties: false },
      ),
    ]),
    output: ManagedOutboundSchema,
  },
  managedInfo: { action: "read", output: ManagedServerInfoSchema },
  managedBootLogs: {
    action: "admin",
    input: Type.Object({ tail }, { additionalProperties: false }),
    output: logs,
  },
  managedSshStatus: { action: "read", output: ManagedSshStatusSchema },
  setManagedSsh: {
    action: "admin",
    input: Type.Object(
      { enabled: Type.Boolean(), expectedEnabled: Type.Boolean(), confirm: Type.Literal(true) },
      { additionalProperties: false },
    ),
    output: ManagedSshResultSchema,
  },
  setManagedSshKey: {
    action: "admin",
    input: Type.Object(
      { publicKey: Type.String({ minLength: 30, maxLength: 16384 }), confirm: Type.Literal(true) },
      { additionalProperties: false },
    ),
    output: ManagedSshStatusSchema,
  },
  setManagedSshPassword: {
    action: "admin",
    input: Type.Object(
      {
        password: Type.String({ minLength: 12, maxLength: 128, pattern: "^[^\\x00\\r\\n]+$" }),
        confirm: Type.Literal(true),
      },
      { additionalProperties: false },
    ),
    output: ManagedSshStatusSchema,
  },
  managedSshConnection: {
    action: "admin",
    input: confirmed,
    output: Type.Object(
      {
        host: Type.String(),
        port: Type.Integer({ minimum: 1, maximum: 65535 }),
        username: Type.String(),
        password: Type.String({ minLength: 1 }),
        hostKeyFingerprint: Type.String(),
        expiresAt: Type.String(),
      },
      { additionalProperties: false },
    ),
  },
  managedRuntimeStatus: { action: "read", output: ManagedRuntimeStatusSchema },
  enableManagedRuntime: { action: "admin", input: confirmed, output: ManagedRuntimeStatusSchema },
  managedRuntimeCredential: {
    action: "admin",
    input: confirmed,
    output: ManagedRuntimeCredentialSchema,
  },
  rotateManagedRuntimeCredential: {
    action: "admin",
    input: Type.Object(
      { expectedRevision: revision, confirm: Type.Literal(true) },
      { additionalProperties: false },
    ),
    output: ManagedRuntimeCredentialSchema,
  },
  managedWorkloads: {
    action: "read",
    output: Type.Object(
      { workloads: Type.Array(ManagedWorkloadSchema), truncated: Type.Boolean() },
      { additionalProperties: false },
    ),
  },
  managedWorkloadLogs: {
    action: "admin",
    input: Type.Object({ workloadId, tail }, { additionalProperties: false }),
    output: logs,
  },
  createManagedWorkload: {
    action: "admin",
    input: Type.Object(
      {
        idempotencyKey: Type.String({ pattern: "^[A-Za-z0-9_-]{16,64}$" }),
        name: Type.String({ minLength: 1, maxLength: 80, pattern: "\\S" }),
        command: Type.String({ minLength: 1, maxLength: 16384, pattern: "^[^\\x00]+$" }),
        workingDirectory: Type.String({
          minLength: 1,
          maxLength: 1024,
          pattern: "^/[^\\x00\\r\\n]*$",
        }),
        environment: Type.Array(
          Type.String({ maxLength: 8192, pattern: "^[A-Za-z_][A-Za-z0-9_]*=[^\\x00\\r\\n]*$" }),
          { maxItems: 100 },
        ),
        restartPolicy: Type.Union([
          Type.Literal("never"),
          Type.Literal("on-failure"),
          Type.Literal("always"),
        ]),
        confirm: Type.Literal(true),
      },
      { additionalProperties: false },
    ),
    output: ManagedWorkloadSchema,
  },
  controlManagedWorkload: {
    action: "admin",
    input: Type.Object(
      {
        workloadId,
        action: Type.Union([Type.Literal("start"), Type.Literal("stop"), Type.Literal("delete")]),
        confirm: Type.Literal(true),
      },
      { additionalProperties: false },
    ),
    output: Type.Object(
      { ok: Type.Literal(true), workload: Type.Union([ManagedWorkloadSchema, Type.Null()]) },
      { additionalProperties: false },
    ),
  },
} as const satisfies Record<string, ResourceOperationSchema>;

export type ManagedServerInfo = Static<typeof ManagedServerInfoSchema>;
export type ManagedSshStatus = Static<typeof ManagedSshStatusSchema>;
export type ManagedWorkload = Static<typeof ManagedWorkloadSchema>;
export type ManagedOutbound = Static<typeof ManagedOutboundSchema>;
