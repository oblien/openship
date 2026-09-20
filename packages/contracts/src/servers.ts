import { NetworkCollectionSchemas, ComputeClusterCollectionSchemas, ServerInfrastructureSchema } from "./infrastructure-resources";
import { Type, type Static } from "@sinclair/typebox";
import { AgentExecBody } from "./exec";
import { ServerClusterCollectionSchemas, NetworkHostObservationSchema } from "./server-clusters";
import { ServerTunnelSchema, SaveServerTunnelInputSchema, ServerTunnelInputSchema, StartServerTunnelResultSchema } from "./server-tunnels";
import { AgentExecResultSchema } from "./services";
import type { DeploymentEvent } from "./deployment-resources";
import type { ResourceOperationSchema, ResourceOperations, ScopedOperations } from "./resource-operations";
import {
  ServerContainerInputSchema, ApplyAllServerContainersInputSchema, ServerContainerStatusSchema, ServerContainerViewSchema,
  ServerContainerGroupSchema, ServerContainerIssuesSchema, ApplyingServerContainersSchema, ApplyAllServerContainersResultSchema,
  ServerContainerApplySessionSchema, type ServerContainerInput, type ApplyServerContainerInput,
} from "./server-containers";

const nullableString = Type.Union([Type.String(), Type.Null()]);
const connectionFields = {
  name: Type.Optional(nullableString),
  sshHost: Type.Optional(nullableString),
  sshPort: Type.Optional(Type.Union([Type.Integer({ minimum: 1, maximum: 65535 }), Type.Null()])),
  sshUser: Type.Optional(nullableString),
  sshAuthMethod: Type.Optional(Type.Union([Type.Literal("password"), Type.Literal("key"), Type.Literal("agent"), Type.Literal(""), Type.Null()])),
  sshPassword: Type.Optional(nullableString),
  sshKeyPath: Type.Optional(nullableString),
  sshPrivateKey: Type.Optional(nullableString),
  sshKeyPassphrase: Type.Optional(nullableString),
  sshJumpHost: Type.Optional(nullableString),
  sshArgs: Type.Optional(nullableString),
};
export const CreateServerInputSchema = Type.Object({
  ...connectionFields,
  sshHost: Type.String({ minLength: 1 }),
}, { additionalProperties: false });
export const UpdateServerInputSchema = Type.Object(connectionFields, { additionalProperties: false });
export type CreateServerInput = Static<typeof CreateServerInputSchema>;
export type UpdateServerInput = Static<typeof UpdateServerInputSchema>;

export const HostChannelSchema = Type.Object({
  ok: Type.Boolean(), code: Type.String(),
  host: Type.Optional(Type.String()), port: Type.Optional(Type.Number()),
  target: Type.Optional(Type.String()), hint: Type.Optional(Type.String()),
  rule: Type.Optional(Type.String()), cause: Type.Optional(Type.String()),
  forwarding: Type.Optional(Type.Union([Type.Literal("ok"), Type.Literal("blocked"), Type.Literal("unknown")])),
}, { additionalProperties: false });

const serverFields = {
  id: Type.String(), name: nullableString, isLocal: Type.Boolean(), sshHost: Type.String(),
  sshPort: Type.Union([Type.Number(), Type.Null()]), sshUser: nullableString,
  sshAuthMethod: nullableString, sshKeyPath: nullableString, hasStoredKeyMaterial: Type.Boolean(),
  sshJumpHost: nullableString, sshArgs: nullableString, createdAt: Type.String(), country: nullableString,
};
/** Explicitly excludes password, private-key material and passphrase, including ciphertext. */
export const ServerSchema = Type.Object(serverFields, { additionalProperties: false });
export const ServerDetailSchema = Type.Object({
  ...serverFields, projectCount: Type.Integer({ minimum: 0 }),
  hostChannel: Type.Union([HostChannelSchema, Type.Null()]),
}, { additionalProperties: false });
export type PublicServer = Static<typeof ServerSchema>;
export type ServerDetail = Static<typeof ServerDetailSchema>;
export const ServerReachabilitySchema = Type.Object({
  reachable: Type.Boolean(), code: Type.String(), target: nullableString,
  port: Type.Union([Type.Number(), Type.Null()]), hint: nullableString, rule: nullableString,
  channel: Type.Union([HostChannelSchema, Type.Null()]),
});

export const ServerDeletionPreviewSchema = Type.Object({
  ok: Type.Literal(true),
  preview: Type.Object({
    serverId: Type.String(), serverName: nullableString, sshHost: Type.String(), isLocal: Type.Boolean(),
    workloads: Type.Array(Type.Object({
      id: Type.String(), name: Type.String(), slug: Type.String(),
      environmentName: nullableString, environmentSlug: nullableString, groupName: nullableString,
      isApp: Type.Boolean(), isControlPlane: Type.Boolean(), activeDeploymentId: nullableString,
    })),
    projectCount: Type.Integer({ minimum: 0 }), appCount: Type.Integer({ minimum: 0 }),
    alsoRemoved: Type.Object({ mailConfigured: Type.Boolean(), tunnels: Type.Integer({ minimum: 0 }), githubRegistration: Type.Boolean() }),
    alsoUnbound: Type.Object({ backupDestinations: Type.Integer({ minimum: 0 }) }),
    reachable: Type.Union([Type.Boolean(), Type.Null()]),
  }),
});
export const RemoveServerInputSchema = Type.Object({
  destroyOnSource: Type.Optional(Type.Boolean()),
}, { additionalProperties: false });
const removalFields = {
  destroyOnSource: Type.Boolean(),
  workloads: Type.Array(Type.Object({
    id: Type.String(), name: Type.String(), ok: Type.Boolean(),
    orphaned: Type.Optional(Type.Integer({ minimum: 0 })), error: Type.Optional(Type.String()),
  })),
};
export const RemoveServerResultSchema = Type.Union([
  Type.Object({ ...removalFields, ok: Type.Literal(true), serverRemoved: Type.Literal(true), removed: Type.Integer({ minimum: 0 }) }),
  Type.Object({ ...removalFields, ok: Type.Literal(false), serverRemoved: Type.Literal(false), code: Type.Literal("SERVER_WORKLOAD_TEARDOWN_FAILED"), error: Type.String() }),
]);
export type RemoveServerResult = Static<typeof RemoveServerResultSchema>;

export const ServerModuleConsentSchema = Type.Object({ id: Type.String(), version: Type.String(), warning: Type.Optional(Type.String()) });
export const ServerModuleViewSchema = Type.Object({
  module: Type.String(), installed: Type.Boolean(), installedVersion: nullableString,
  migrationVersion: nullableString, availableVersion: nullableString, behind: Type.Boolean(),
  pendingConsent: Type.Array(ServerModuleConsentSchema), autoPending: Type.Array(Type.String()),
  catalogAvailable: Type.Boolean(), note: Type.Optional(Type.String()),
});
export const ServerModuleStatusSchema = Type.Object({
  id: Type.String(), organizationId: nullableString, serverId: Type.String(), moduleName: Type.String(),
  installedVersion: nullableString, migrationVersion: nullableString, availableVersion: nullableString,
  behind: Type.Boolean(), latestInProgress: Type.Boolean(), currentLabel: nullableString, latestLabel: nullableString,
  detail: Type.Union([Type.Object({
    pendingConsent: Type.Optional(Type.Array(ServerModuleConsentSchema)),
    autoPending: Type.Optional(Type.Array(Type.String())), catalogAvailable: Type.Optional(Type.Boolean()),
    note: Type.Optional(Type.String()),
  }), Type.Null()]), checkedAt: Type.String(), createdAt: Type.String(), updatedAt: Type.String(),
});
export const ServerModuleApplySchema = Type.Object({
  module: Type.String(), fromVersion: Type.String(), toVersion: Type.String(),
  appliedSteps: Type.Array(Type.String()), pendingConsent: Type.Array(ServerModuleConsentSchema),
  skipped: Type.Array(Type.String()), changed: Type.Boolean(), ok: Type.Boolean(), error: Type.Optional(Type.String()),
});
export const ServerRateLimitSchema = Type.Object({
  rps: Type.Number(), burst: Type.Number(), whitelist: Type.Array(Type.String()),
});
export const UpdateServerRateLimitSchema = Type.Partial(ServerRateLimitSchema, { additionalProperties: false });

export const ServerComponentSchema = Type.Object({
  name: Type.String(), label: Type.String(), description: Type.String(), installable: Type.Boolean(),
  removable: Type.Optional(Type.Boolean()), removeSupported: Type.Optional(Type.Boolean()), removeBlockedReason: Type.Optional(Type.String()),
  installed: Type.Boolean(), version: Type.Optional(Type.String()), availableVersion: Type.Optional(Type.String()),
  updateAvailable: Type.Optional(Type.Boolean()), running: Type.Optional(Type.Boolean()), healthy: Type.Boolean(),
  message: Type.String(), optional: Type.Optional(Type.Boolean()),
});
export const CheckServerInputSchema = Type.Object({ components: Type.Optional(Type.Array(Type.String())) }, { additionalProperties: false });
export const CheckServerResultSchema = Type.Object({ components: Type.Array(ServerComponentSchema), ready: Type.Boolean(), missing: Type.Array(Type.String()) });
export const ServerInstallerConfigSchema = Type.Object({
  acmeEmail: Type.Optional(Type.String()), domain: Type.Optional(Type.String()), reinstall: Type.Optional(Type.Boolean()),
  // Kept for HTTP compatibility; the engine always replaces it with its own pinned image.
  edgeImage: Type.Optional(Type.String()),
  edgePolicy: Type.Optional(Type.Object({
    mode: Type.Literal("takeover"),
    stopTargets: Type.Array(Type.Object({
      port: Type.Optional(Type.Integer({ minimum: 1, maximum: 65535 })),
      unit: Type.Optional(Type.String()), pid: Type.Optional(Type.Integer({ minimum: 1 })),
      container: Type.Optional(Type.String()), label: Type.Optional(Type.String()),
    }, { additionalProperties: false })),
  }, { additionalProperties: false })),
}, { additionalProperties: false });
export const ServerComponentInputSchema = Type.Object({
  component: Type.String({ minLength: 1 }), config: Type.Optional(ServerInstallerConfigSchema),
}, { additionalProperties: false });
export const InstallServerComponentsInputSchema = Type.Object({
  components: Type.Array(Type.String(), { minItems: 1 }), config: Type.Optional(ServerInstallerConfigSchema),
}, { additionalProperties: false });
export type InstallServerComponentsInput = Static<typeof InstallServerComponentsInputSchema>;
export const ServerComponentResultSchema = Type.Object({
  component: Type.String(), success: Type.Boolean(), version: Type.Optional(Type.String()),
  error: Type.Optional(Type.String()), logs: Type.Optional(Type.Array(Type.String())),
});
export const ServerConnectionTestResultSchema = Type.Object({
  ok: Type.Boolean(), message: Type.String(), code: Type.Optional(Type.String()),
});
export const ServerPortScanSchema = Type.Object({
  listeners: Type.Array(Type.Object({
    proto: Type.Union([Type.Literal("tcp"), Type.Literal("udp")]),
    family: Type.Union([Type.Literal("ipv4"), Type.Literal("ipv6")]),
    address: Type.String(), port: Type.Number(), exposed: Type.Boolean(),
    pid: Type.Union([Type.Number(), Type.Null()]), process: nullableString, service: nullableString,
    required: Type.Optional(Type.Boolean()), sensitive: Type.Optional(Type.Boolean()),
    reachable: Type.Optional(Type.Union([Type.Boolean(), Type.Null()])),
  })),
  totalCount: Type.Number(), exposedCount: Type.Number(), source: Type.Union([Type.Literal("ss"), Type.Literal("procfs")]),
  scanned: Type.Boolean(), reachabilityProbed: Type.Optional(Type.Boolean()), reachableCount: Type.Optional(Type.Number()),
});

export const ServerInstallSessionInputSchema = Type.Object({ sessionId: Type.Optional(Type.String({ minLength: 1 })) }, { additionalProperties: false });
export type ServerInstallSessionInput = Static<typeof ServerInstallSessionInputSchema>;
export const ServerInstallResponseInputSchema = Type.Object({
  sessionId: Type.Optional(Type.String({ minLength: 1 })), action: Type.String({ minLength: 1 }),
}, { additionalProperties: false });
export type ServerInstallResponseInput = Static<typeof ServerInstallResponseInputSchema>;
export const ServerInstallSessionSchema = Type.Union([
  Type.Object({ active: Type.Literal(false) }),
  Type.Object({
    active: Type.Literal(true), sessionId: Type.String(), serverId: Type.String(),
    status: Type.Union([Type.Literal("running"), Type.Literal("completed"), Type.Literal("failed")]),
    components: Type.Array(Type.Object({
      name: Type.String(), label: Type.String(),
      status: Type.Union([Type.Literal("pending"), Type.Literal("installing"), Type.Literal("installed"), Type.Literal("failed")]),
      error: Type.Optional(Type.String()),
    })), startedAt: Type.Number(), finishedAt: Type.Optional(Type.Number()),
  }),
]);
export type ServerInstallSession = Static<typeof ServerInstallSessionSchema>;
export const ServerInstallSessionSchemas = {
  getInstallSession: { action: "read", input: ServerInstallSessionInputSchema, optionalInput: true, output: ServerInstallSessionSchema },
  respondToInstall: { action: "admin", input: ServerInstallResponseInputSchema, output: Type.Object({ ok: Type.Literal(true) }) },
} as const satisfies Record<string, ResourceOperationSchema>;

export const ServerCollectionSchemas = {
  ...ServerClusterCollectionSchemas,
  ...NetworkCollectionSchemas,
  ...ComputeClusterCollectionSchemas,
  listAllContainers: { action: "read", output: Type.Array(ServerContainerGroupSchema) },
  scanAllContainers: { action: "write", output: Type.Array(ServerContainerGroupSchema) },
  containersBehind: { action: "read", output: Type.Object({ servers: Type.Number(), components: Type.Number() }) },
  containerIssues: { action: "read", output: ServerContainerIssuesSchema },
  applyingContainers: { action: "read", output: ApplyingServerContainersSchema },
  applyAllContainers: { action: "write", input: ApplyAllServerContainersInputSchema, optionalInput: true, output: ApplyAllServerContainersResultSchema },
  list: { action: "read", output: Type.Array(ServerDetailSchema) },
  create: { action: "write", input: CreateServerInputSchema, output: ServerSchema },
  testConnection: { action: "write", input: CreateServerInputSchema, output: ServerConnectionTestResultSchema },
} as const satisfies Record<string, ResourceOperationSchema>;
export const ServerResourceSchemas = {
  infrastructure: { action: "read", output: ServerInfrastructureSchema },
  inspectNetwork: { action: "admin", output: NetworkHostObservationSchema },
  githubStatus: { action: "read", output: Type.Object({
    mode: Type.Union([Type.String(), Type.Null()]), connected: Type.Boolean(), deployKeyCount: Type.Integer(),
    tokenSource: Type.Optional(Type.Union([Type.String(), Type.Null()])), tokenLogin: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    serverKeyPublic: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    deployKeys: Type.Optional(Type.Array(Type.Object({ owner: Type.String(), repo: Type.String(), createdAt: Type.String() }))),
  }) },
  connectGitHub: { action: "write", output: Type.Object({ userCode: Type.String(), verificationUri: Type.String(), expiresIn: Type.Number(), interval: Type.Number() }) },
  pollGitHubConnection: { action: "read", output: Type.Union([Type.Null(), Type.Object({ status: Type.Union([Type.Literal("waiting"), Type.Literal("complete"), Type.Literal("error")]), error: Type.Optional(Type.String()) })]) },
  setGitHubToken: { action: "write", input: Type.Object({ token: Type.String({ minLength: 1, maxLength: 4096 }) }), output: Type.Object({ login: Type.String() }) },
  generateGitHubKey: { action: "write", output: Type.Object({ publicKey: Type.String() }) },
  useGitHubDeployKeys: { action: "write", output: Type.Object({ ok: Type.Literal(true) }) },
  disconnectGitHub: { action: "write", output: Type.Object({ ok: Type.Literal(true) }) },
  listTunnels: { action: "read", output: Type.Array(ServerTunnelSchema) },
  saveTunnel: { action: "write", input: SaveServerTunnelInputSchema, output: ServerTunnelSchema },
  startTunnel: { action: "write", input: ServerTunnelInputSchema, output: StartServerTunnelResultSchema },
  stopTunnel: { action: "write", input: ServerTunnelInputSchema, output: ServerTunnelSchema },
  removeTunnel: { action: "write", input: ServerTunnelInputSchema, output: Type.Object({ ok: Type.Literal(true) }) },
  listContainers: { action: "read", output: Type.Array(ServerContainerStatusSchema) },
  scanContainers: { action: "write", output: Type.Object({ ok: Type.Literal(true), containers: Type.Array(ServerContainerViewSchema) }) },
  containerApplySession: { action: "read", input: ServerContainerInputSchema, output: ServerContainerApplySessionSchema },
  get: { action: "read", output: ServerDetailSchema },
  reachability: { action: "read", output: ServerReachabilitySchema },
  update: { action: "write", input: UpdateServerInputSchema, output: ServerSchema },
  deletionPreview: { action: "read", output: ServerDeletionPreviewSchema },
  remove: { action: "admin", input: RemoveServerInputSchema, optionalInput: true, output: RemoveServerResultSchema },
  exec: { action: "admin", input: AgentExecBody, output: AgentExecResultSchema },
  listModules: { action: "read", output: Type.Array(ServerModuleStatusSchema) },
  scanModules: { action: "write", output: Type.Object({ ok: Type.Literal(true), modules: Type.Array(ServerModuleViewSchema) }) },
  applyModule: { action: "write", input: Type.Object({ module: Type.String({ minLength: 1 }) }, { additionalProperties: false }), output: ServerModuleApplySchema },
  getRateLimit: { action: "read", output: Type.Object({ config: ServerRateLimitSchema }) },
  updateRateLimit: { action: "admin", input: UpdateServerRateLimitSchema, output: Type.Object({ success: Type.Literal(true), config: ServerRateLimitSchema }) },
  check: { action: "admin", input: CheckServerInputSchema, optionalInput: true, output: CheckServerResultSchema },
  installComponent: { action: "admin", input: ServerComponentInputSchema, output: ServerComponentResultSchema },
  removeComponent: { action: "admin", input: ServerComponentInputSchema, output: ServerComponentResultSchema },
  scanPorts: { action: "read", output: ServerPortScanSchema },
} as const satisfies Record<string, ResourceOperationSchema>;
export interface ServerOperations extends ScopedOperations<typeof ServerCollectionSchemas>, ResourceOperations<typeof ServerResourceSchemas> {
  managedNetworkPreparationEvents(id: string, options?: { signal?: AbortSignal }): AsyncIterable<DeploymentEvent>;
  managedNetworkOperationEvents(id: string, options?: { signal?: AbortSignal }): AsyncIterable<DeploymentEvent>;
  clusterEvents(options?: { signal?: AbortSignal }): AsyncIterable<DeploymentEvent>;
  applyContainer(id: string, input: ApplyServerContainerInput, options?: { signal?: AbortSignal }): AsyncIterable<DeploymentEvent>;
  containerApplyEvents(id: string, input: ServerContainerInput, options?: { signal?: AbortSignal }): AsyncIterable<DeploymentEvent>;
  getInstallSession(input?: ServerInstallSessionInput): Promise<ServerInstallSession>;
  respondToInstall(input: ServerInstallResponseInput): Promise<{ ok: true }>;
  installComponents(id: string, input: InstallServerComponentsInput, options?: { signal?: AbortSignal }): AsyncIterable<DeploymentEvent>;
  installEvents(input?: ServerInstallSessionInput, options?: { signal?: AbortSignal }): AsyncIterable<DeploymentEvent>;
  monitor(id: string, options?: { signal?: AbortSignal }): AsyncIterable<DeploymentEvent>;
}
