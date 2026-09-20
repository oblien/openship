/** Passive host facade. The engine is loaded only by an explicitly constructed worker. */
import { Worker } from "node:worker_threads";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { releaseExitedWorkerLock } from "@repo/db/lock";
import { AppError, OperationError, ValidationError, type DeploymentEvent } from "@repo/contracts";
import type { PlatformKernel } from "./index";
import type { PlatformDeploymentOperations } from "./deployments";
import type { PlatformProjectOperations } from "./projects";
import { ProjectControlSchemas, ServiceCollectionSchemas, ServiceResourceSchemas, DomainCollectionSchemas, DomainResourceSchemas, DomainScopedSchemas, DnsOperationSchemas, CredentialCollectionSchemas, CredentialResourceSchemas, ServerCollectionSchemas, ServerResourceSchemas } from "@repo/contracts";
import type { PlatformServiceOperations } from "./services";
import type { PlatformDomainOperations } from "./domains";
import type { PlatformDnsOperations } from "./dns";
import type { PlatformCredentialOperations } from "./credentials";
import type { PlatformServerOperations } from "./servers";
import { SystemOperationSchemas } from "@repo/contracts";
import type { PlatformSystemOperations } from "./system";
import type { PlatformAppOperations } from "./apps";
import type { PlatformBackupDestinationOperations } from "./backup-destinations";
import { JobCollectionSchemas, JobResourceSchemas } from "@repo/contracts";
import type { PlatformJobOperations } from "./jobs";
import { AnalyticsProjectSchemas, AnalyticsServerSchemas, AnalyticsCollectionSchemas } from "@repo/contracts";
import type { PlatformAnalyticsOperations } from "./analytics";
import { IssueCollectionSchemas, IssueJobSchemas } from "@repo/contracts";
import type { PlatformIssueOperations } from "./issues";
import { NotificationCollectionSchemas, NotificationResourceSchemas } from "@repo/contracts";
import type { PlatformNotificationOperations } from "./notifications";
import { UserSettingsSchemas } from "@repo/contracts";
import type { PlatformUserSettingsOperations } from "./settings";
import { AuditOperationSchemas } from "@repo/contracts";
import type { PlatformAuditOperations } from "./audit";
import { UpdateCollectionSchemas, UpdateProjectSchemas } from "@repo/contracts";
import type { PlatformUpdateOperations } from "./updates";
import { WebhookProjectSchemas, WebhookResourceSchemas, WebhookCollectionSchemas } from "@repo/contracts";
import type { PlatformWebhookOperations } from "./webhooks";
import { TokenCollectionSchemas, TokenResourceSchemas } from "@repo/contracts";
import type { PlatformTokenOperations } from "./tokens";
import { PermissionCollectionSchemas, PermissionResourceSchemas } from "@repo/contracts";
import type { PlatformPermissionOperations } from "./permissions";
import { GitHubCollectionSchemas, GitHubResourceSchemas } from "@repo/contracts";
import type { PlatformGitHubOperations } from "./github";
import { NoticeCollectionSchemas } from "@repo/contracts";
import type { PlatformNoticeOperations } from "./notices";
import { BillingPublicSchemas, BillingOperationSchemas } from "@repo/contracts";
import type { PlatformBillingOperations } from "./billing";
import type { PlatformBackupOperations } from "./backups";
import { BackupProjectSchemas, BackupPolicySchemas, BackupRunSchemas, BackupRestoreSchemas } from "@repo/contracts";
import { BackupDestinationCollectionSchemas, BackupDestinationResourceSchemas } from "@repo/contracts";
import { AppCollectionSchemas, AppResourceSchemas } from "@repo/contracts";
import type { ExecutionContext } from "./context";
import type { PlatformSourceOperations } from "./sources";
import type { TransferListItem } from "node:worker_threads";
import type { NativeCloseOptions, NativeOperator, NativePlatformOptions } from "./native-config";

export type { NativeCloseOptions, NativeOperator, NativePlatformOptions, ExternalIdentityInput, ExternalIdentityResult } from "./native-config";

export interface NativePlatform extends PlatformKernel {
  readonly instanceId: string;
  readonly operator?: NativeOperator;
  start(): Promise<void>;
  close(options?: NativeCloseOptions): Promise<void>;
}

interface Reply { id?: number; event?: "ready" | "failed"; data?: unknown; error?: { message: string; code?: string; status?: number; details?: unknown } }

const timeout = <T>(work: Promise<T>, ms?: number): Promise<T> => {
  if (ms === undefined) return work;
  if (!Number.isFinite(ms) || ms <= 0) return Promise.reject(new ValidationError("timeoutMs must be positive"));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new AppError("The platform is still draining owned work", 408, "DRAIN_TIMEOUT")), ms);
    work.then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
  });
};

function runtimeEntry(): string {
  // __filename is available in the CommonJS distribution; import.meta.url in ESM/source.
  const here = dirname(typeof __filename === "string" ? __filename : fileURLToPath(import.meta.url));
  const candidates = [
    join(here, "../native/engine-worker.mjs"), // public dist/sdk/
    join(here, "../dist/native/engine-worker.mjs"), // platform/src/
    join(here, "../../platform/dist/native/engine-worker.mjs"), // sdk/dist/
  ];
  const entry = candidates.find(existsSync);
  if (!entry) throw new AppError("Native engine assets are missing. Build packages/platform with build:native before workspace use.", 500, "NATIVE_ASSETS_MISSING");
  return entry;
}

export async function createNativePlatform(value: NativePlatformOptions): Promise<NativePlatform> {
  let options: NativePlatformOptions;
  try { options = structuredClone(value); }
  catch { throw new ValidationError("Native configuration must contain serializable values"); }
  if (!options || typeof options !== "object") throw new ValidationError("Native configuration is required");
  if (options.diagnostics !== undefined && !["inherit", "stderr", "silent"].includes(options.diagnostics))
    throw new ValidationError("Invalid diagnostics output");
  if (typeof options.instanceId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,95}$/.test(options.instanceId))
    throw new ValidationError("instanceId must be a stable identifier of at most 96 characters");
  if (typeof options.stateDirectory !== "string" || !isAbsolute(options.stateDirectory))
    throw new ValidationError("stateDirectory must be an explicit absolute path");
  if (typeof options.encryptionKey !== "string" || Buffer.byteLength(options.encryptionKey) < 32 || Buffer.byteLength(options.encryptionKey) > 4096)
    throw new ValidationError("encryptionKey must be a persistent UTF-8 secret of 32–4096 bytes");
  if (!["docker", "bare", "cloud"].includes(options.runtime)) throw new ValidationError("An explicit runtime is required");
  if (options.routing !== undefined && !["none", "managed"].includes(options.routing)) throw new ValidationError("Invalid routing mode");
  if (options.routing === "none" && options.runtime !== "bare") throw new ValidationError("routing: none requires the bare runtime");
  if (options.runtime !== "cloud" && options.routing !== "none" && options.policy?.allowHostExecution !== true)
    throw new ValidationError("Managed local routing requires policy.allowHostExecution; use bare runtime with routing: none for a platform without host setup");
  if (!options.storage || !["pglite", "postgres"].includes(options.storage.driver)) throw new ValidationError("An explicit storage configuration is required");
  if (options.storage.driver === "postgres" && !/^postgres(?:ql)?:\/\//.test(options.storage.url)) throw new ValidationError("A PostgreSQL URL is required");
  if (options.storage.driver === "pglite" && options.storage.dataDir !== "memory://" && (typeof options.storage.dataDir !== "string" || !isAbsolute(options.storage.dataDir)))
    throw new ValidationError("PGlite dataDir must be an absolute path or memory://");
  if (options.storage.migrations !== undefined && !["apply", "verify"].includes(options.storage.migrations)) throw new ValidationError("Invalid migration policy");
  if (options.recovery !== undefined && !["none", "exclusive"].includes(options.recovery)) throw new ValidationError("Invalid recovery policy");
  if (options.recovery === "exclusive" && (options.storage.driver !== "pglite" || options.storage.dataDir === "memory://"))
    throw new ValidationError("Exclusive recovery requires an owned file-backed PGlite database");
  if (options.runtime === "cloud" && (!options.cloud?.clientId || !options.cloud.clientSecret)) throw new ValidationError("Cloud runtime credentials are required");
  if (options.cloud?.hosted && (!options.cloud.redisUrl || options.storage.driver !== "postgres")) throw new ValidationError("Hosted cloud mode requires PostgreSQL and Redis");
  const reserved = /^(?:HOME|USERPROFILE|NODE_OPTIONS|NODE_ENV|DATABASE_URL|PGLITE_DATA_DIR|POSTGRES_|PG[A-Z]|BETTER_AUTH_SECRET|INTERNAL_TOKEN|CLOUD_MODE|DEPLOY_MODE|REDIS_URL|OPENSHIP_(?:NATIVE|DB_|INSTANCE_|DATA_DIR|MIGRATIONS_DIR|PGLITE_ASSETS_DIR|CACHE_STORE|JOB_RUNNER|REQUIRE_REDIS|DEV_LOCK_TAKEOVER|HOST_CONTROL))/;
  for (const [key, val] of Object.entries(options.environment ?? {})) {
    if (reserved.test(key) || !/^[A-Z][A-Z0-9_]*$/.test(key) || typeof val !== "string") throw new ValidationError(`Reserved or invalid native environment option: ${key}`);
  }
  const entry = runtimeEntry();
  const nativeDir = dirname(entry);
  const assets = existsSync(join(nativeDir, "pglite")) ? nativeDir : join(nativeDir, "../server");
  const state = join(resolve(options.stateDirectory), options.instanceId);
  await mkdir(state, { recursive: true, mode: 0o700 });
  const roots: string[] = [];
  for (const root of options.policy?.sourceRoots ?? []) {
    if (typeof root !== "string" || !isAbsolute(root)) throw new ValidationError("sourceRoots must contain absolute paths");
    roots.push(await realpath(root));
  }
  options = { ...options, stateDirectory: state, policy: { ...options.policy, sourceRoots: roots } };
  const ownerId = randomUUID();
  const environment: Record<string, string> = {};
  // OS tool locations are inherited; platform/provider credentials and configuration are explicit.
  for (const key of ["PATH", "HOME", "USERPROFILE", "SystemRoot", "WINDIR", "COMSPEC", "PATHEXT", "TMPDIR", "TMP", "TEMP", "LANG"]) {
    if (process.env[key]) environment[key] = process.env[key]!;
  }
  Object.assign(environment, options.environment, {
    NODE_ENV: "production", OPENSHIP_NATIVE: "true", OPENSHIP_INSTANCE_ID: options.instanceId,
    OPENSHIP_NATIVE_JOBS: String(options.jobs === true),
    OPENSHIP_INSTANCE_NAMESPACE: `openship:${options.instanceId}`, OPENSHIP_DATA_DIR: state,
    OPENSHIP_NATIVE_ALLOW_HOST_EXECUTION: String(options.policy?.allowHostExecution === true),
    OPENSHIP_NATIVE_ALLOW_LOCAL_FORWARDING: String(options.policy?.allowLocalForwarding === true),
    OPENSHIP_NATIVE_ROUTING: options.routing ?? "managed", OPENSHIP_HOST_CONTROL: String(options.policy?.allowHostExecution === true),
    OPENSHIP_AUTH_MODE: "local", OPENSHIP_REQUIRE_AUTH: "true", OPENSHIP_DEV_LOCK_TAKEOVER: "false",
    OPENSHIP_DB_LOCK_OWNER: ownerId, OPENSHIP_DB_MIGRATIONS: options.storage.migrations ?? (options.storage.driver === "postgres" ? "verify" : "apply"),
    PGLITE_DATA_DIR: options.storage.driver === "pglite" ? options.storage.dataDir : "",
    DATABASE_URL: options.storage.driver === "postgres" ? options.storage.url : "",
    BETTER_AUTH_SECRET: options.encryptionKey, INTERNAL_TOKEN: randomUUID() + randomUUID(),
    DEPLOY_MODE: options.runtime, CLOUD_MODE: String(options.cloud?.hosted === true),
    OBLIEN_CLIENT_ID: options.cloud?.clientId ?? "", OBLIEN_CLIENT_SECRET: options.cloud?.clientSecret ?? "",
    OPENSHIP_MIGRATIONS_DIR: join(assets, "migrations"), OPENSHIP_PGLITE_ASSETS_DIR: join(assets, "pglite"),
    MAIL_SERVER_ENGINE_DIR: join(assets, "engine"),
    OPENSHIP_GEOIP_DB: options.environment?.OPENSHIP_GEOIP_DB ?? join(assets, "assets/geoip/GeoLite2-Country.mmdb"),
    OPENSHIP_CACHE_STORE: options.cloud?.redisUrl ? "redis" : "memory",
    OPENSHIP_JOB_RUNNER: options.cloud?.redisUrl ? "bullmq" : "in-process",
    OPENSHIP_REQUIRE_REDIS: String(!!options.cloud?.redisUrl), REDIS_URL: options.cloud?.redisUrl ?? "redis://127.0.0.1:6379",
    GITHUB_AUTH_MODE: options.environment?.GITHUB_AUTH_MODE ?? "auto",
  });
  const worker = new Worker(pathToFileURL(entry), { workerData: { options }, env: environment, execArgv: [], name: `openship-${options.instanceId}`, stdout: true, stderr: true });
  if (options.diagnostics === "silent") { worker.stdout.resume(); worker.stderr.resume(); }
  else {
    worker.stdout.pipe(options.diagnostics === "stderr" ? process.stderr : process.stdout, { end: false });
    worker.stderr.pipe(process.stderr, { end: false });
  }
  let nextId = 0, stopped = false, closePromise: Promise<void> | undefined;
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: unknown): void }>();
  let readyResolve!: () => void, readyReject!: (error: unknown) => void;
  const ready = new Promise<void>((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  const decodeError = (error: NonNullable<Reply["error"]>) => new OperationError(error.message, error.status ?? 500, error.code ?? "NATIVE_OPERATION_FAILED", error.details && typeof error.details === "object" && !Array.isArray(error.details) ? error.details as Record<string, unknown> : undefined);
  const fail = (error: unknown) => { stopped = true; readyReject(error); for (const call of pending.values()) call.reject(error); pending.clear(); };
  worker.on("message", (message: Reply) => {
    if (message.event === "ready") { readyResolve(); return; }
    if (message.event === "failed") { readyReject(decodeError(message.error!)); return; }
    if (message.id === undefined) return;
    const call = pending.get(message.id);
    if (!call) return;
    pending.delete(message.id);
    if (message.error) call.reject(decodeError(message.error)); else call.resolve(message.data);
  });
  worker.on("error", fail);
  worker.on("exit", code => {
    if (options.storage.driver === "pglite" && options.storage.dataDir !== "memory://") releaseExitedWorkerLock(options.storage.dataDir, ownerId);
    fail(new AppError(`Native platform worker closed (${code})`, 503, "PLATFORM_CLOSED"));
  });
  function call<T>(operation: string, ...args: unknown[]): Promise<T> {
    if (stopped) return Promise.reject(new AppError("The platform is closed", 503, "PLATFORM_CLOSED"));
    return new Promise<T>((resolve, reject) => {
      const id = ++nextId;
      pending.set(id, { resolve: value => resolve(value as T), reject });
      try { worker.postMessage({ id, operation, args }, operation === "sources.upload" ? [args[3] as TransferListItem] : undefined); }
      catch (error) { pending.delete(id); reject(error); }
    });
  }
  try { await ready; } catch (error) { await worker.terminate(); throw error; }
  const methods = ["create", "get", "list", "logs", "buildStatus", "restorePlan", "cancel", "respond", "rollback", "redeploy", "pin", "keep", "reject", "remove", "restart", "skipPortCheck", "prepare", "buildAccess", "start", "containerInfo", "containerUsage", "pendingActions", "sslStatus", "renewSsl"] as const;
  const deployments = Object.fromEntries(methods.map(name => [name, (...args: unknown[]) => call(`deployments.${name}`, ...args)])) as Omit<PlatformDeploymentOperations, "events">;
  const projectResources = Object.fromEntries(["create", "ensure", "get", "list", "getHome", "update", "scanLocal", "importLocal", "listLocal", ...Object.keys(ProjectControlSchemas)].map(name => [name, (...args: unknown[]) => call(`projects.${name}`, ...args)])) as Omit<PlatformProjectOperations, "streamRuntimeLogs" | "openServerLogStream">;
  const sources: PlatformSourceOperations = {
    open: (...args) => call("sources.open", ...args), stage: (...args) => call("sources.stage", ...args),
    scan: (...args) => call("sources.scan", ...args), upload: (...args) => call("sources.upload", ...args), reveal: (...args) => call("sources.reveal", ...args),
  };
  const serviceResources = Object.fromEntries([...Object.keys(ServiceCollectionSchemas), ...Object.keys(ServiceResourceSchemas)].map(name => [name, (...args: unknown[]) => call(`services.${name}`, ...args)])) as Omit<PlatformServiceOperations, "streamLogs">;
  const domainResources = Object.fromEntries(Object.keys({ ...DomainCollectionSchemas, ...DomainResourceSchemas, ...DomainScopedSchemas }).map(name => [name, (...args: unknown[]) => call(`domains.${name}`, ...args)])) as Omit<PlatformDomainOperations, "verifyStream">;
  const dns = Object.fromEntries(Object.keys(DnsOperationSchemas).map(name => [name, (...args: unknown[]) => call(`dns.${name}`, ...args)])) as PlatformDnsOperations;
  const serverResources = Object.fromEntries([...Object.keys({ ...ServerCollectionSchemas, ...ServerResourceSchemas }), "getInstallSession", "respondToInstall"].map(name => [name, (...args: unknown[]) => call(`servers.${name}`, ...args)])) as Omit<PlatformServerOperations, "openInstallStream" | "openInstallEvents" | "openMonitor" | "openContainerApplyStream" | "openContainerApplyEvents" | "openManagedNetworkPreparationEvents" | "openManagedNetworkOperationEvents" | "openClusterEvents">;
  const credentials = Object.fromEntries(Object.keys({ ...CredentialCollectionSchemas, ...CredentialResourceSchemas }).map(name => [name, (...args: unknown[]) => call(`credentials.${name}`, ...args)])) as PlatformCredentialOperations;
  async function* streamValues<T>(streamId: string, signal?: AbortSignal): AsyncGenerator<T> {
    const abort = () => { void call("stream.close", streamId).catch(() => {}); };
    signal?.addEventListener("abort", abort, { once: true });
    try {
      if (signal?.aborted) { abort(); signal.throwIfAborted(); }
      for (;;) {
        const item = await call<IteratorResult<T>>("stream.next", streamId);
        signal?.throwIfAborted();
        if (item.done) return;
        yield item.value;
      }
    } finally {
      signal?.removeEventListener("abort", abort);
      await call("stream.close", streamId).catch(() => {});
    }
  }
  async function* streamEvents(kind: string, ctx: ExecutionContext, args: unknown[], signal?: AbortSignal): AsyncGenerator<DeploymentEvent> {
    signal?.throwIfAborted();
    const streamId = await call<string>("stream.open", kind, ctx, ...args);
    yield* streamValues<DeploymentEvent>(streamId, signal);
  }
  async function openStreamValues<T>(kind: string, ctx: ExecutionContext, args: unknown[], signal?: AbortSignal) {
    signal?.throwIfAborted();
    const result = await call<{ streamId: string; context: ExecutionContext }>("stream.open", kind, ctx, ...args);
    if (signal?.aborted) {
      await call("stream.close", result.streamId).catch(() => {});
      signal.throwIfAborted();
    }
    return { context: result.context, data: streamValues<T>(result.streamId, signal) };
  }
  const projects: PlatformProjectOperations = {
    ...projectResources,
    streamRuntimeLogs: (ctx, id, input = {}, options = {}) => streamEvents("projects.streamRuntimeLogs", ctx, [id, input], options.signal),
    async openServerLogStream(ctx, id, input = {}, options = {}) {
      return openStreamValues<Uint8Array>("projects.serverLogs", ctx, [id, input], options.signal);
    },
  };
  const events: PlatformDeploymentOperations["events"] = (ctx, id, settings = {}) => streamEvents("deployments.events", ctx, [id, settings.since], settings.signal);
  const services: PlatformServiceOperations = {
    ...serviceResources,
    streamLogs: (ctx, projectId, serviceId, input = {}, options = {}) => streamEvents("services.streamLogs", ctx, [projectId, serviceId, input], options.signal),
  };
  const domains: PlatformDomainOperations = {
    ...domainResources,
    verifyStream: (ctx, id, input = {}, settings = {}) => streamEvents("domains.verifyStream", ctx, [id, input], settings.signal),
  };
  const servers: PlatformServerOperations = {
    ...serverResources,
    openManagedNetworkPreparationEvents: (ctx, id, settings = {}) => openStreamValues<DeploymentEvent>("servers.managedNetworkPreparationEvents", ctx, [id], settings.signal),
    openManagedNetworkOperationEvents: (ctx, id, settings = {}) => openStreamValues<DeploymentEvent>("servers.managedNetworkOperationEvents", ctx, [id], settings.signal),
    openClusterEvents: (ctx, settings = {}) => openStreamValues<DeploymentEvent>("servers.clusterEvents", ctx, [], settings.signal),
    openContainerApplyStream: (ctx, id, input, settings = {}) => openStreamValues<DeploymentEvent>("servers.applyContainer", ctx, [id, input], settings.signal),
    openContainerApplyEvents: (ctx, id, input, settings = {}) => openStreamValues<DeploymentEvent>("servers.containerApplyEvents", ctx, [id, input], settings.signal),
    openInstallStream: (ctx, id, input, settings = {}) => openStreamValues<DeploymentEvent>("servers.installComponents", ctx, [id, input], settings.signal),
    openInstallEvents: (ctx, input = {}, settings = {}) => openStreamValues<DeploymentEvent>("servers.installEvents", ctx, [input], settings.signal),
    openMonitor: (ctx, id, settings = {}) => openStreamValues<DeploymentEvent>("servers.monitor", ctx, [id], settings.signal),
  };
  const operator: NativeOperator | undefined = options.administration ? Object.freeze<NativeOperator>({
    notices: Object.freeze<NativeOperator["notices"]>({
      listAll: () => call("operator.notices.listAll"),
      create: input => call("operator.notices.create", input),
      remove: id => call("operator.notices.remove", id),
    }),
    ensureIdentity: input => call("operator.ensureIdentity", input),
    resolveIdentity: input => call("operator.resolveIdentity", input),
    ensureNamespace: input => call("operator.ensureNamespace", input),
    setMembership: input => call("operator.setMembership", input),
  }) : undefined;
  const jobs: PlatformJobOperations = {
    ...Object.fromEntries(Object.keys({ ...JobCollectionSchemas, ...JobResourceSchemas }).map(name => [name, (...args: unknown[]) => call(`jobs.${name}`, ...args)])) as Omit<PlatformJobOperations, "openRunStream">,
    openRunStream: (ctx, id, settings = {}) => openStreamValues<DeploymentEvent>("jobs.run", ctx, [id], settings.signal),
  };
  const analytics: PlatformAnalyticsOperations = {
    ...Object.fromEntries(Object.keys({ ...AnalyticsProjectSchemas, ...AnalyticsServerSchemas, ...AnalyticsCollectionSchemas }).map(name => [name, (...args: unknown[]) => call(`analytics.${name}`, ...args)])) as Omit<PlatformAnalyticsOperations, "openUsageStream">,
    openUsageStream: (ctx, id, settings = {}) => openStreamValues<DeploymentEvent>("analytics.streamUsage", ctx, [id], settings.signal),
  };
  const backups: PlatformBackupOperations = {
    ...Object.fromEntries(Object.keys({ ...BackupProjectSchemas, ...BackupPolicySchemas, ...BackupRunSchemas, ...BackupRestoreSchemas }).map(name => [name, (...args: unknown[]) => call(`backups.${name}`, ...args)])) as Omit<PlatformBackupOperations, "openRunStream" | "openRestoreStream">,
    openRunStream: (ctx, id, settings = {}) => openStreamValues<DeploymentEvent>("backups.run", ctx, [id], settings.signal),
    openRestoreStream: (ctx, id, settings = {}) => openStreamValues<DeploymentEvent>("backups.restore", ctx, [id], settings.signal),
  };
  return Object.freeze({
    instanceId: options.instanceId, operator,
    resolveScope: (...args) => call("scope", ...args),
    deployments: Object.freeze({ ...deployments, events }),
    projects: Object.freeze(projects),
    sources: Object.freeze(sources),
    services: Object.freeze(services),
    domains: Object.freeze(domains),
    dns: Object.freeze(dns),
    credentials: Object.freeze(credentials),
    servers: Object.freeze(servers),
    backups: Object.freeze(backups),
    billing: Object.freeze(Object.fromEntries(Object.keys({ ...BillingPublicSchemas, ...BillingOperationSchemas }).map(name => [name, (...args: unknown[]) => call(`billing.${name}`, ...args)]))) as PlatformBillingOperations,
    notices: Object.freeze(Object.fromEntries(Object.keys({ ...NoticeCollectionSchemas }).map(name => [name, (...args: unknown[]) => call(`notices.${name}`, ...args)]))) as PlatformNoticeOperations,
    github: Object.freeze(Object.fromEntries(Object.keys({ ...GitHubCollectionSchemas, ...GitHubResourceSchemas }).map(name => [name, (...args: unknown[]) => call(`github.${name}`, ...args)]))) as PlatformGitHubOperations,
    permissions: Object.freeze(Object.fromEntries(Object.keys({ ...PermissionCollectionSchemas, ...PermissionResourceSchemas }).map(name => [name, (...args: unknown[]) => call(`permissions.${name}`, ...args)]))) as PlatformPermissionOperations,
    tokens: Object.freeze(Object.fromEntries(Object.keys({ ...TokenCollectionSchemas, ...TokenResourceSchemas }).map(name => [name, (...args: unknown[]) => call(`tokens.${name}`, ...args)]))) as PlatformTokenOperations,
    webhooks: Object.freeze(Object.fromEntries(Object.keys({ ...WebhookProjectSchemas, ...WebhookResourceSchemas, ...WebhookCollectionSchemas }).map(name => [name, (...args: unknown[]) => call(`webhooks.${name}`, ...args)]))) as PlatformWebhookOperations,
    updates: Object.freeze(Object.fromEntries(Object.keys({ ...UpdateCollectionSchemas, ...UpdateProjectSchemas }).map(name => [name, (...args: unknown[]) => call(`updates.${name}`, ...args)]))) as PlatformUpdateOperations,
    audit: Object.freeze(Object.fromEntries(Object.keys({ ...AuditOperationSchemas }).map(name => [name, (...args: unknown[]) => call(`audit.${name}`, ...args)]))) as PlatformAuditOperations,
    settings: Object.freeze(Object.fromEntries(Object.keys({ ...UserSettingsSchemas }).map(name => [name, (...args: unknown[]) => call(`settings.${name}`, ...args)]))) as PlatformUserSettingsOperations,
    notifications: Object.freeze(Object.fromEntries(Object.keys({ ...NotificationCollectionSchemas, ...NotificationResourceSchemas }).map(name => [name, (...args: unknown[]) => call(`notifications.${name}`, ...args)]))) as PlatformNotificationOperations,
    issues: Object.freeze(Object.fromEntries(Object.keys({ ...IssueCollectionSchemas, ...IssueJobSchemas }).map(name => [name, (...args: unknown[]) => call(`issues.${name}`, ...args)]))) as PlatformIssueOperations,
    analytics: Object.freeze(analytics),
    jobs: Object.freeze(jobs),
    system: Object.freeze(Object.fromEntries([...Object.keys(SystemOperationSchemas), "info"].map(name => [name, (...args: unknown[]) => call(`system.${name}`, ...args)]))) as PlatformSystemOperations,
    apps: Object.freeze(Object.fromEntries(Object.keys({ ...AppCollectionSchemas, ...AppResourceSchemas }).map(name => [name, (...args: unknown[]) => call(`apps.${name}`, ...args)]))) as PlatformAppOperations,
    backupDestinations: Object.freeze(Object.fromEntries(Object.keys({ ...BackupDestinationCollectionSchemas, ...BackupDestinationResourceSchemas }).map(name => [name, (...args: unknown[]) => call(`backupDestinations.${name}`, ...args)]))) as PlatformBackupDestinationOperations,
    start: () => call<void>("start"),
    close(settings: NativeCloseOptions = {}) {
      if (settings.mode !== undefined && settings.mode !== "drain") return Promise.reject(new ValidationError("Native close supports drain mode"));
      if (settings.timeoutMs !== undefined && (!Number.isFinite(settings.timeoutMs) || settings.timeoutMs <= 0))
        return Promise.reject(new ValidationError("timeoutMs must be positive"));
      closePromise ??= call<void>("close").then(async () => { await worker.terminate(); }).catch(error => {
        // Cleanup may fail transiently. Keep the worker available for another
        // drain attempt; a timeout only bounds the caller's wait below.
        closePromise = undefined;
        throw error;
      });
      return timeout(closePromise, settings.timeoutMs);
    },
  } satisfies NativePlatform);
}
