/** Node worker entry, never imported by the public host facade. No HTTP application or listener. */
import { parentPort, workerData } from "node:worker_threads";
import type { NativePlatformOptions } from "./native-config";
import type { ExecutionContext } from "./context";
import type { ApplyServerContainerInput, ServerContainerInput } from "@repo/contracts";
import { JobCollectionSchemas, JobResourceSchemas } from "@repo/contracts";
import { AnalyticsProjectSchemas, AnalyticsServerSchemas, AnalyticsCollectionSchemas } from "@repo/contracts";
import { IssueCollectionSchemas, IssueJobSchemas } from "@repo/contracts";
import { NotificationCollectionSchemas, NotificationResourceSchemas } from "@repo/contracts";
import { UserSettingsSchemas } from "@repo/contracts";
import { AuditOperationSchemas } from "@repo/contracts";
import { UpdateCollectionSchemas, UpdateProjectSchemas } from "@repo/contracts";
import { WebhookProjectSchemas, WebhookResourceSchemas, WebhookCollectionSchemas } from "@repo/contracts";
import { TokenCollectionSchemas, TokenResourceSchemas } from "@repo/contracts";
import { PermissionCollectionSchemas, PermissionResourceSchemas } from "@repo/contracts";
import { GitHubCollectionSchemas, GitHubResourceSchemas } from "@repo/contracts";
import { NoticeCollectionSchemas } from "@repo/contracts";
import { BillingPublicSchemas, BillingOperationSchemas } from "@repo/contracts";
import { SystemOperationSchemas } from "@repo/contracts";
import { BackupProjectSchemas, BackupPolicySchemas, BackupRunSchemas, BackupRestoreSchemas } from "@repo/contracts";
import { AppCollectionSchemas, AppResourceSchemas, BackupDestinationCollectionSchemas, BackupDestinationResourceSchemas } from "@repo/contracts";
import { OperationError, ProjectControlSchemas, ServiceCollectionSchemas, ServiceResourceSchemas, DomainCollectionSchemas, DomainResourceSchemas, DomainScopedSchemas, DnsOperationSchemas, CredentialCollectionSchemas, CredentialResourceSchemas, ServerCollectionSchemas, ServerResourceSchemas, type ServerLogsInput, type InstallServerComponentsInput, type ServerInstallSessionInput } from "@repo/contracts";

if (!parentPort) throw new Error("The native engine must run in an owned worker");
const port = parentPort;
const { options } = workerData as { options: NativePlatformOptions };
type Command = { id: number; operation: string; args: unknown[] };

function failure(error: unknown) {
  const e = error as { message?: string; code?: string; statusCode?: number; details?: unknown };
  return {
    message: e?.message ?? "Native operation failed",
    code: e?.code,
    status: e?.statusCode,
    details: error instanceof OperationError ? error.details : undefined,
  };
}

let closeProviders: (() => Promise<void>) | undefined;
try {
  const [{ getPlatformKernel }, adapters, database, identities, { runWithOperationSource }] = await Promise.all([
    import("./engine/lib/platform"), import("@repo/adapters"), import("@repo/db"),
    import("./engine/native/identity"), import("./engine/lib/operation-source"),
  ]);
  closeProviders = async () => {
    const instance = adapters.peekPlatform();
    if (!instance) return;
    const errors: unknown[] = [];
    // All layers of this singleton belong to the worker. Per-operation cleanup
    // deliberately leaves them alone while other calls may still use them.
    for (const layer of new Set(Object.values(instance))) {
      if (layer && typeof layer === "object" && "dispose" in layer && typeof layer.dispose === "function") {
        try { await layer.dispose(); } catch (error) { errors.push(error); }
      }
    }
    if (errors.length) throw new AggregateError(errors, "Native provider cleanup failed");
    adapters.resetPlatform();
  };
  const { resolvePlatformConfig } = await import("./engine/lib/platform-config");
  const { configureNativeSourceRoots } = await import("./engine/native/source-policy");
  configureNativeSourceRoots(options.policy?.sourceRoots ?? []);
  await identities.bindInstallation(options.instanceId, options.encryptionKey);
  await database.repos.configurationSecrets.backfillLegacy();
  await adapters.initPlatform(resolvePlatformConfig());
  const kernel = getPlatformKernel();
  let started = false, draining = false, finalizing = false;
  let startPromise: Promise<void> | undefined, closePromise: Promise<void> | undefined;
  const inFlight = new Set<Promise<unknown>>();
  const streams = new Map<string, { iterator: AsyncIterator<unknown>; abort: AbortController }>();
  let streamSequence = 0;
  const { AppError } = await import("@repo/core");

  async function start() {
    if (draining) throw new AppError("The platform is closing", 503, "PLATFORM_CLOSING");
    return startPromise ??= (async () => {
      if (options.recovery === "exclusive") {
        // An exclusive PGlite lock proves the previous engine owner is gone.
        const { recoverNetworkSetups } = await import("./engine/modules/system/network-setup-lifecycle");
        await recoverNetworkSetups(true);
        await database.repos.backupRun.sweepStaleRuns("Native owner restarted while backup was in flight");
        await database.repos.backupRestore.sweepStaleRestores("Native owner restarted while restore was in flight");
        await database.repos.jobRun.failStaleRunning("Native owner restarted while job was in flight");
        await database.repos.notificationDelivery.failInterrupted("Native owner restarted before delivery outcome was recorded; verify the receiver before retrying");
        await database.repos.deployment.sweepStaleInFlight("Native owner restarted — redeploy to retry interrupted work.");
        const { migrationOrchestrator } = await import("./engine/modules/migration/migration.orchestrator");
        await migrationOrchestrator.recoverInterruptedMigrations();
      }
      if (options.jobs) {
        const [{ getJobRunner }, { backupOrchestrator }] = await Promise.all([
          import("./engine/lib/job-runner"), import("./engine/modules/backups/backup.orchestrator"),
        ]);
        await (await getJobRunner()).start({ processRun: id => backupOrchestrator.execute(id) });
        const { reconcileAllSchedules } = await import("./engine/modules/backups/triggers/cron");
        await reconcileAllSchedules();
        const { reconcileJobs } = await import("./engine/modules/jobs/job.service");
        await reconcileJobs();
        const { scheduleBillingAnniversary } = await import("./engine/modules/billing/billing-anniversary.cron");
        await scheduleBillingAnniversary();
        const { startNotificationRunner } = await import("./engine/lib/notification-workers");
        startNotificationRunner();
      }
      started = true;
    })().catch(error => { startPromise = undefined; throw error; });
  }

  async function close() {
    draining = true;
    return closePromise ??= (async () => {
      await Promise.allSettled([...inFlight]);
      const { stopNotificationRunner } = await import("./engine/lib/notification-workers");
      await stopNotificationRunner();
      const { shutdownJobRunner } = await import("./engine/lib/job-runner");
      await shutdownJobRunner(Infinity);
      const { stopAllContainerEventWatchers } = await import("./engine/modules/monitoring/container-events");
      await stopAllContainerEventWatchers({ closing: true });
      const { drainDeploymentExecutions } = await import("./engine/modules/deployments/deployment-cancellation");
      await drainDeploymentExecutions();
      const { drainServerInstallations } = await import("./engine/modules/system/server-install.operations");
      await drainServerInstallations();
      const { closeDeviceFlows } = await import("./engine/modules/github/github.local-auth");
      await closeDeviceFlows();
      const { drainBackgroundWork } = await import("./engine/lib/background-work");
      await drainBackgroundWork();
      finalizing = true;
      await Promise.allSettled([...inFlight]);
      for (const stream of streams.values()) stream.abort.abort();
      await Promise.allSettled([...streams.values()].map(s => s.iterator.return?.()));
      streams.clear();
      await drainBackgroundWork();
      const [{ closeSessionManager }, { shutdownCacheStores }, { sshManager }, { flushAudit }, { closeEncryption }, { takeAllFolderSessions }, { rm }] = await Promise.all([
        import("./engine/modules/deployments/session-manager"), import("./engine/lib/cache-store"),
        import("./engine/lib/ssh-manager"), import("./engine/lib/audit-emitter"), import("./engine/lib/encryption"),
        import("./engine/modules/projects/folder/session-store"), import("node:fs/promises"),
      ]);
      const cleanupErrors: unknown[] = [];
      const { closeSetupSessions } = await import("./engine/modules/system/setup-session");
      const { closeContainerApplySessions } = await import("./engine/lib/server-container-session");
      const { stopAllTunnels } = await import("./engine/lib/ssh-tunnel-manager");
      for (const cleanup of [
        async () => { closeSetupSessions(); closeContainerApplySessions(); },
        async () => { closeSessionManager(); }, shutdownCacheStores,
        stopAllTunnels,
        () => closeProviders!(),
        () => sshManager.destroy(), flushAudit,
        async () => { for (const source of takeAllFolderSessions()) if (source.stagingDir) await rm(source.stagingDir, { recursive: true, force: true }); },
        async () => { closeEncryption(); }, database.closeDb,
      ]) {
        try { await cleanup(); } catch (error) { cleanupErrors.push(error); }
      }
      if (cleanupErrors.length) throw new AggregateError(cleanupErrors, "Native resource cleanup failed");
    })().catch(error => { closePromise = undefined; throw error; });
  }

  async function dispatch(operation: string, args: unknown[]): Promise<unknown> {
    if (operation === "close") return close();
    if (finalizing) throw new AppError("The platform is closed", 503, "PLATFORM_CLOSED");
    if (operation === "start") return start();
    if (draining && !["scope", "system.info", "projects.get", "projects.list", "projects.listLocal", "projects.getHome", "deployments.get", "deployments.list", "deployments.logs", "deployments.buildStatus", "deployments.cancel", "deployments.respond", "deployments.containerInfo", "deployments.containerUsage", "deployments.pendingActions", "deployments.sslStatus", "stream.next", "stream.close", "servers.getInstallSession", "servers.respondToInstall",
      ...Object.entries(ProjectControlSchemas).filter(([, spec]) => spec.action === "read").map(([name]) => `projects.${name}`),
      ...Object.entries({ ...ServiceCollectionSchemas, ...ServiceResourceSchemas }).filter(([, spec]) => spec.action === "read").map(([name]) => `services.${name}`),
      ...Object.entries({ ...DomainCollectionSchemas, ...DomainResourceSchemas, ...DomainScopedSchemas }).filter(([, spec]) => spec.action === "read").map(([name]) => `domains.${name}`),
      ...Object.entries(DnsOperationSchemas).filter(([, spec]) => spec.action === "read").map(([name]) => `dns.${name}`),
      ...Object.entries({ ...CredentialCollectionSchemas, ...CredentialResourceSchemas }).filter(([, spec]) => spec.action === "read").map(([name]) => `credentials.${name}`),
      ...Object.entries({ ...ServerCollectionSchemas, ...ServerResourceSchemas }).filter(([, spec]) => spec.action === "read").map(([name]) => `servers.${name}`),
      ...Object.entries(SystemOperationSchemas).filter(([, spec]) => spec.action === "read").map(([name]) => `system.${name}`),
      ...Object.entries({ ...AppCollectionSchemas, ...AppResourceSchemas }).filter(([, spec]) => spec.action === "read").map(([name]) => `apps.${name}`),
      ...Object.entries({ ...BackupDestinationCollectionSchemas, ...BackupDestinationResourceSchemas }).filter(([, spec]) => spec.action === "read").map(([name]) => `backupDestinations.${name}`),
      ...Object.entries({ ...BackupProjectSchemas, ...BackupPolicySchemas, ...BackupRunSchemas, ...BackupRestoreSchemas }).filter(([, spec]) => spec.action === "read").map(([name]) => `backups.${name}`),
      ...Object.entries({ ...JobCollectionSchemas, ...JobResourceSchemas }).filter(([, spec]) => spec.action === "read").map(([name]) => `jobs.${name}`),
      ...Object.entries({ ...AnalyticsProjectSchemas, ...AnalyticsServerSchemas, ...AnalyticsCollectionSchemas }).filter(([, spec]) => spec.action === "read").map(([name]) => `analytics.${name}`),
      ...Object.entries({ ...IssueCollectionSchemas, ...IssueJobSchemas }).filter(([, spec]) => spec.action === "read").map(([name]) => `issues.${name}`),
      ...Object.entries({ ...NotificationCollectionSchemas, ...NotificationResourceSchemas }).filter(([, spec]) => spec.action === "read").map(([name]) => `notifications.${name}`),
      ...Object.entries({ ...UserSettingsSchemas }).filter(([, spec]) => spec.action === "read").map(([name]) => `settings.${name}`),
      ...Object.entries({ ...AuditOperationSchemas }).filter(([, spec]) => spec.action === "read").map(([name]) => `audit.${name}`),
      ...Object.entries({ ...UpdateCollectionSchemas, ...UpdateProjectSchemas }).filter(([, spec]) => spec.action === "read").map(([name]) => `updates.${name}`),
      ...Object.entries({ ...WebhookProjectSchemas, ...WebhookResourceSchemas, ...WebhookCollectionSchemas }).filter(([, spec]) => spec.action === "read").map(([name]) => `webhooks.${name}`),
      ...Object.entries({ ...TokenCollectionSchemas, ...TokenResourceSchemas }).filter(([, spec]) => spec.action === "read").map(([name]) => `tokens.${name}`),
      ...Object.entries({ ...PermissionCollectionSchemas, ...PermissionResourceSchemas }).filter(([, spec]) => spec.action === "read").map(([name]) => `permissions.${name}`),
      ...Object.entries({ ...GitHubCollectionSchemas, ...GitHubResourceSchemas }).filter(([, spec]) => spec.action === "read").map(([name]) => `github.${name}`),
      ...Object.entries({ ...NoticeCollectionSchemas }).filter(([, spec]) => spec.action === "read").map(([name]) => `notices.${name}`),
      ...Object.entries({ ...BillingPublicSchemas, ...BillingOperationSchemas }).filter(([, spec]) => spec.action === "read").map(([name]) => `billing.${name}`),
      "backups.cancelRestore", "backups.listRuns", "backups.listPolicies",
    ].includes(operation))
      throw new AppError("The platform is draining and no longer accepts new work", 503, "PLATFORM_CLOSING");
    if (operation === "scope") return kernel.resolveScope(args[0] as Parameters<typeof kernel.resolveScope>[0], args[1] as string);
    if (operation.startsWith("operator.")) {
      if (!options.administration) throw new AppError("Host administration is not enabled", 403, "HOST_ADMINISTRATION_DISABLED");
      if (operation.startsWith("operator.notices.")) {
        const { operatorNoticeOperations } = await import("./engine/modules/notices/notice.operations");
        const name = operation.slice("operator.notices.".length);
        if (Object.hasOwn(operatorNoticeOperations, name)) {
          const run = operatorNoticeOperations[name as keyof typeof operatorNoticeOperations] as (...input: unknown[]) => Promise<unknown>;
          return run(...args);
        }
      }
      const handlers = {
        "operator.ensureIdentity": identities.ensureExternalIdentity,
        "operator.resolveIdentity": identities.resolveExternalIdentity,
        "operator.ensureNamespace": identities.ensureExternalNamespace,
        "operator.setMembership": identities.setNativeMembership,
      };
      const handler = handlers[operation as keyof typeof handlers] as ((input: unknown) => Promise<unknown>) | undefined;
      if (handler) return handler(args[0]);
    }
    if (!started && operation !== "stream.next" && operation !== "stream.close") throw new AppError("Call start() before invoking platform operations", 409, "PLATFORM_NOT_STARTED");
    if (operation === "stream.open") {
      const abort = new AbortController();
      const [kind, context, ...input] = args;
      if (kind === "jobs.run") {
        const result = await kernel.jobs.openRunStream(context as ExecutionContext, input[0] as string, { signal: abort.signal });
        const streamId = String(++streamSequence);
        streams.set(streamId, { iterator: result.data[Symbol.asyncIterator](), abort });
        return { streamId, context: result.context };
      }
      if (kind === "analytics.streamUsage") {
        const result = await kernel.analytics.openUsageStream(context as ExecutionContext, input[0] as string, { signal: abort.signal });
        const streamId = String(++streamSequence);
        streams.set(streamId, { iterator: result.data[Symbol.asyncIterator](), abort });
        return { streamId, context: result.context };
      }
      if (kind === "backups.run" || kind === "backups.restore") {
        const result = await (kind === "backups.run" ? kernel.backups.openRunStream : kernel.backups.openRestoreStream)(context as ExecutionContext, input[0] as string, { signal: abort.signal });
        const streamId = String(++streamSequence);
        streams.set(streamId, { iterator: result.data[Symbol.asyncIterator](), abort });
        return { streamId, context: result.context };
      }
      if (kind === "projects.serverLogs") {
        const result = await kernel.projects.openServerLogStream(context as ExecutionContext, input[0] as string, input[1] as ServerLogsInput, { signal: abort.signal });
        const streamId = String(++streamSequence);
        streams.set(streamId, { iterator: result.data[Symbol.asyncIterator](), abort });
        return { streamId, context: result.context };
      }
      if (kind === "servers.managedNetworkPreparationEvents" || kind === "servers.managedNetworkOperationEvents" || kind === "servers.clusterEvents") {
        const result = kind === "servers.clusterEvents"
          ? await kernel.servers.openClusterEvents(context as ExecutionContext, { signal: abort.signal })
          : kind === "servers.managedNetworkPreparationEvents"
            ? await kernel.servers.openManagedNetworkPreparationEvents(context as ExecutionContext, input[0] as string, { signal: abort.signal })
            : await kernel.servers.openManagedNetworkOperationEvents(context as ExecutionContext, input[0] as string, { signal: abort.signal });
        const streamId = String(++streamSequence);
        streams.set(streamId, { iterator: result.data[Symbol.asyncIterator](), abort });
        return { streamId, context: result.context };
      }
      if (kind === "servers.installComponents" || kind === "servers.installEvents" || kind === "servers.monitor") {
        const result = kind === "servers.installComponents"
          ? await kernel.servers.openInstallStream(context as ExecutionContext, input[0] as string, input[1] as InstallServerComponentsInput, { signal: abort.signal })
          : kind === "servers.installEvents"
            ? await kernel.servers.openInstallEvents(context as ExecutionContext, input[0] as ServerInstallSessionInput, { signal: abort.signal })
            : await kernel.servers.openMonitor(context as ExecutionContext, input[0] as string, { signal: abort.signal });
        const streamId = String(++streamSequence);
        streams.set(streamId, { iterator: result.data[Symbol.asyncIterator](), abort });
        return { streamId, context: result.context };
      }
      if (kind === "servers.applyContainer" || kind === "servers.containerApplyEvents") {
        const result = kind === "servers.applyContainer"
          ? await kernel.servers.openContainerApplyStream(context as ExecutionContext, input[0] as string, input[1] as ApplyServerContainerInput, { signal: abort.signal })
          : await kernel.servers.openContainerApplyEvents(context as ExecutionContext, input[0] as string, input[1] as ServerContainerInput, { signal: abort.signal });
        const streamId = String(++streamSequence);
        streams.set(streamId, { iterator: result.data[Symbol.asyncIterator](), abort });
        return { streamId, context: result.context };
      }
      const stream = kind === "deployments.events"
        ? kernel.deployments.events(context as ExecutionContext, input[0] as string, { since: input[1] as number | undefined, signal: abort.signal })
        : kind === "projects.streamRuntimeLogs"
          ? kernel.projects.streamRuntimeLogs(context as ExecutionContext, input[0] as string, input[1] as { tail?: number }, { signal: abort.signal })
        : kind === "services.streamLogs"
          ? kernel.services.streamLogs(context as ExecutionContext, input[0] as string, input[1] as string, input[2] as { tail?: number }, { signal: abort.signal })
          : kind === "domains.verifyStream"
            ? kernel.domains.verifyStream(context as ExecutionContext, input[0] as string, input[1] as { force?: boolean }, { signal: abort.signal })
            : null;
      if (!stream) throw new AppError("Unknown native stream", 404, "OPERATION_NOT_FOUND");
      const iterator = stream[Symbol.asyncIterator]();
      const streamId = String(++streamSequence);
      streams.set(streamId, { iterator, abort });
      return streamId;
    }
    if (operation === "stream.next") return streams.get(args[0] as string)?.iterator.next() ?? { done: true };
    if (operation === "stream.close") {
      const stream = streams.get(args[0] as string);
      if (stream) { stream.abort.abort(); await stream.iterator.return?.(); streams.delete(args[0] as string); }
      return;
    }
    if (operation.startsWith("deployments.")) {
      const key = operation.slice("deployments.".length) as keyof typeof kernel.deployments;
      if (key !== "events" && Object.hasOwn(kernel.deployments, key)) {
        const fn = kernel.deployments[key] as (...args: unknown[]) => Promise<unknown>;
        return runWithOperationSource((args[0] as ExecutionContext).source ?? "api", () => fn(...args));
      }
    }
    if (operation.startsWith("projects.")) {
      const key = operation.slice("projects.".length) as keyof typeof kernel.projects;
      if (key !== "streamRuntimeLogs" && key !== "openServerLogStream" && Object.hasOwn(kernel.projects, key)) {
        const fn = kernel.projects[key] as (...args: unknown[]) => Promise<unknown>;
        return runWithOperationSource((args[0] as ExecutionContext).source ?? "api", () => fn(...args));
      }
    }
    if (operation.startsWith("sources.")) {
      const key = operation.slice("sources.".length) as keyof typeof kernel.sources;
      if (Object.hasOwn(kernel.sources, key)) {
        const fn = kernel.sources[key] as (...args: unknown[]) => Promise<unknown>;
        return runWithOperationSource((args[0] as ExecutionContext).source ?? "api", () => fn(...args));
      }
    }
    if (operation.startsWith("services.")) {
      const key = operation.slice("services.".length) as keyof typeof kernel.services;
      if (key !== "streamLogs" && Object.hasOwn(kernel.services, key)) {
        const fn = kernel.services[key] as (...args: unknown[]) => Promise<unknown>;
        return runWithOperationSource((args[0] as ExecutionContext).source ?? "api", () => fn(...args));
      }
    }
    for (const [prefix, operations] of Object.entries({ domains: kernel.domains, dns: kernel.dns, credentials: kernel.credentials, servers: kernel.servers, system: kernel.system, apps: kernel.apps, backupDestinations: kernel.backupDestinations, backups: kernel.backups, billing: kernel.billing, notices: kernel.notices, github: kernel.github, permissions: kernel.permissions, tokens: kernel.tokens, webhooks: kernel.webhooks, updates: kernel.updates, audit: kernel.audit, settings: kernel.settings, notifications: kernel.notifications, issues: kernel.issues, analytics: kernel.analytics, jobs: kernel.jobs })) {
      if (!operation.startsWith(`${prefix}.`)) continue;
      const key = operation.slice(prefix.length + 1);
      if (key !== "verifyStream" && Object.hasOwn(operations, key)) {
        const fn = (operations as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>)[key]!;
        return runWithOperationSource((args[0] as ExecutionContext).source ?? "api", () => fn(...args));
      }
    }
    throw new AppError("Unknown native operation", 404, "OPERATION_NOT_FOUND");
  }

  port.on("message", (command: Command) => {
    // Close waits only for ordinary invocations; a subscription can intentionally wait forever.
    const tracked = !["close", "stream.next", "stream.close"].includes(command.operation);
    const task = Promise.resolve().then(() => dispatch(command.operation, command.args));
    if (tracked) inFlight.add(task);
    task.then(data => port.postMessage({ id: command.id, data }), error => port.postMessage({ id: command.id, error: failure(error) }))
      .finally(() => { inFlight.delete(task); });
  });
  port.postMessage({ event: "ready" });
} catch (error) {
  // Import failures in the database factory already close partial connections.
  // A later provider/configuration failure must close the completed connection too.
  await closeProviders?.().catch(() => {});
  await import("@repo/db").then(db => db.closeDb()).catch(() => {});
  port.postMessage({ event: "failed", error: failure(error) });
  port.close();
}
