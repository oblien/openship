import { createDeploymentHandle, type DeploymentHandle } from "./deployment-handle";
import {
  UnauthorizedError,
  ValidationError,
  parseCreateDeploymentInput,
  type DeploymentOperations,
  type ProjectOperations,
  type SourceOperations,
  type ServiceOperations,
  type DomainOperations,
  type DnsOperations,
  type CredentialOperations,
  type ServerOperations,
  type SystemOperations,
  type AppOperations,
  type BackupDestinationOperations,
  type BackupOperations,
  type BillingOperations,
  type NoticeOperations,
  type GitHubOperations,
  type PermissionOperations,
  type TokenOperations,
  type WebhookOperations,
  type UpdateOperations,
  type AuditOperations,
  type UserSettingsOperations,
  type NotificationOperations,
  type IssueOperations,
  type AnalyticsOperations,
  type JobOperations,
} from "@repo/contracts";
import type {
  ExecutionContext,
  OperationResult,
  PlatformKernel,
  VerifiedIdentity,
} from "@repo/platform";
import { freezeContext } from "@repo/platform";
import {
  createNativePlatform,
  type NativePlatformOptions,
  type NativeOperator,
  type NativeCloseOptions,
} from "@repo/platform/native";
import {
  snapshotSourceInput,
  type DeploySourceInput,
  type SourceDeploymentResult,
} from "./source-input";
import { deploySourceWorkflow } from "./source-workflow";
import { parseSSEChunks } from "./events";

export type {
  NativePlatformOptions,
  NativeOperator,
  NativeCloseOptions,
  ExternalIdentityInput,
  ExternalIdentityResult,
} from "@repo/platform/native";

export type { VerifiedIdentity } from "@repo/platform";
export { iteratePages, type Page, type PageRequest, type PageIteratorOptions } from "./pagination";
export { OperationError } from "@repo/contracts";
export type * from "@repo/contracts";

/** Installed by the host, which must verify the assertion before returning an Openship identity. */
export interface IdentityAdapter<Assertion> {
  resolve(assertion: Assertion): Promise<VerifiedIdentity | null>;
}

export interface AttachedShipOptions<Assertion> {
  /** Caller-owned application composition. The facade does not start or close it. */
  platform: PlatformKernel;
  identity: IdentityAdapter<Assertion>;
  /** Attribution supplied by the trusted host, never an operation payload. */
  caller?: { source?: "api" | "cli"; userAgent?: string };
}

export type NativeShipOptions<Assertion> = NativePlatformOptions & {
  identity: IdentityAdapter<Assertion>;
  caller?: AttachedShipOptions<Assertion>["caller"];
};
export type CreateShipOptions<Assertion> =
  | AttachedShipOptions<Assertion>
  | NativeShipOptions<Assertion>;

export interface ScopedShip {
  readonly organizationId: string;
  readonly deployments: DeploymentOperations;
  readonly projects: ProjectOperations;
  readonly sources: SourceOperations;
  readonly services: ServiceOperations;
  readonly domains: DomainOperations;
  readonly dns: DnsOperations;
  readonly credentials: CredentialOperations;
  readonly servers: ServerOperations;
  readonly system: SystemOperations;
  readonly apps: AppOperations;
  readonly backupDestinations: BackupDestinationOperations;
  readonly backups: BackupOperations;
  readonly billing: BillingOperations;
  readonly notices: NoticeOperations;
  readonly github: GitHubOperations;
  readonly permissions: PermissionOperations;
  readonly tokens: TokenOperations;
  readonly webhooks: WebhookOperations;
  readonly updates: UpdateOperations;
  readonly audit: AuditOperations;
  readonly settings: UserSettingsOperations;
  readonly notifications: NotificationOperations;
  readonly issues: IssueOperations;
  readonly analytics: AnalyticsOperations;
  readonly jobs: JobOperations;
  deployment(id: string): DeploymentHandle;
  deploy(input: DeploySourceInput): Promise<SourceDeploymentResult>;
}

export interface Ship<Assertion> {
  scope(input: { identity: Assertion; organizationId: string }): Promise<ScopedShip>;
}

export interface OwnedShip<Assertion> extends Ship<Assertion> {
  readonly instanceId: string;
  readonly operator?: NativeOperator;
  start(): Promise<void>;
  close(options?: NativeCloseOptions): Promise<void>;
}

export function createShip<Assertion>(options: AttachedShipOptions<Assertion>): Ship<Assertion>;
export function createShip<Assertion>(
  options: NativeShipOptions<Assertion>,
): Promise<OwnedShip<Assertion>>;
export function createShip<Assertion>(
  options: CreateShipOptions<Assertion>,
): Ship<Assertion> | Promise<OwnedShip<Assertion>> {
  if (!options?.identity || typeof options.identity.resolve !== "function")
    throw new ValidationError("A trusted identity adapter is required");
  const caller = snapshotCaller(options.caller);
  if ("platform" in options) return createAttachedShip({ ...options, caller });
  const { identity, caller: _caller, ...configuration } = options;
  return createNativePlatform(configuration).then((platform) =>
    Object.freeze({
      ...createAttachedShip({ platform, identity, caller }),
      instanceId: platform.instanceId,
      operator: platform.operator,
      start: platform.start,
      close: platform.close,
    }),
  );
}

function snapshotCaller(caller: AttachedShipOptions<unknown>["caller"]) {
  if (caller === undefined) return Object.freeze({ source: undefined, userAgent: undefined });
  if (!caller || typeof caller !== "object" || Array.isArray(caller))
    throw new ValidationError("Invalid SDK caller attribution");
  const { source, userAgent } = caller;
  if (source !== undefined && source !== "api" && source !== "cli")
    throw new ValidationError("Invalid SDK caller source");
  if (userAgent !== undefined && (typeof userAgent !== "string" || userAgent.length > 1024))
    throw new ValidationError("Invalid SDK caller userAgent");
  return Object.freeze({ source, userAgent });
}

/**
 * Passive native facade: no server, fetch, database bootstrap, or ambient user.
 * The supplied platform owns its resources. A scope never owns or closes them.
 */
function createAttachedShip<Assertion>({
  platform,
  identity,
  caller,
}: AttachedShipOptions<Assertion>): Ship<Assertion> {
  const attribution = caller ?? {};
  return Object.freeze({
    async scope(input: { identity: Assertion; organizationId: string }): Promise<ScopedShip> {
      const { identity: assertion, organizationId } = input;
      if (typeof organizationId !== "string" || !organizationId.trim()) {
        throw new ValidationError("organizationId is required");
      }
      const initial = await identity.resolve(assertion);
      if (!initial) throw new UnauthorizedError("Invalid or expired identity");
      const pinned = await platform.resolveScope(initial, organizationId);

      async function resolveContext(): Promise<ExecutionContext> {
        const current = await identity.resolve(assertion);
        if (
          !current ||
          current.user?.id !== pinned.userId ||
          current.sessionId !== pinned.sessionId ||
          (current.principalKind ?? null) !== (pinned.principalKind ?? null) ||
          (current.tokenScope?.tokenId ?? null) !== (pinned.tokenScope?.tokenId ?? null)
        )
          throw new UnauthorizedError("The scoped identity is no longer valid");
        const resolved = await platform.resolveScope(current, organizationId);
        return freezeContext({ ...resolved, source: attribution.source ?? resolved.source, userAgent: attribution.userAgent ?? resolved.userAgent });
      }

      function bind<Args extends unknown[], Result>(
        operation: (ctx: ExecutionContext, ...args: Args) => Promise<OperationResult<Result>>,
      ): (...args: Args) => Promise<Result> {
        return async (...args) => {
          let snapshot: Args;
          try {
            snapshot = structuredClone(args);
          } catch {
            throw new ValidationError("Input must contain serializable data");
          }
          return (await operation(await resolveContext(), ...snapshot)).data;
        };
      }

      function bindGroup<
        Operations extends Record<
          string,
          (ctx: ExecutionContext, ...args: never[]) => Promise<OperationResult<unknown>>
        >,
      >(operations: Operations) {
        type Bound = {
          [K in keyof Operations]: Operations[K] extends (
            ctx: ExecutionContext,
            ...args: infer Args
          ) => Promise<OperationResult<infer Result>>
            ? (...args: Args) => Promise<Result>
            : never;
        };
        return Object.freeze(
          Object.fromEntries(
            Object.entries(operations).map(([name, operation]) => [
              name,
              bind(
                operation as (
                  ctx: ExecutionContext,
                  ...args: unknown[]
                ) => Promise<OperationResult<unknown>>,
              ),
            ]),
          ),
        ) as Bound;
      }

      const deployments = Object.freeze({
        async create(value) {
          // Snapshot before asynchronous identity checks, then revalidate at
          // the operation boundary. Both use the same runtime contract.
          const command = parseCreateDeploymentInput(value);
          // Re-read membership and credential restrictions on every call;
          // keeping a scoped view must not keep a revoked session or old role.
          const context = await resolveContext();
          return (await platform.deployments.create(context, command)).data;
        },
        get: bind(platform.deployments.get),
        sslStatus: bind(platform.deployments.sslStatus),
        renewSsl: bind(platform.deployments.renewSsl),
        containerInfo: bind(platform.deployments.containerInfo),
        containerUsage: bind(platform.deployments.containerUsage),
        pendingActions: bind(platform.deployments.pendingActions),
        list: bind(platform.deployments.list),
        logs: bind(platform.deployments.logs),
        buildStatus: bind(platform.deployments.buildStatus),
        restorePlan: bind(platform.deployments.restorePlan),
        cancel: bind(platform.deployments.cancel),
        respond: bind(platform.deployments.respond),
        rollback: bind(platform.deployments.rollback),
        redeploy: bind(platform.deployments.redeploy),
        pin: bind(platform.deployments.pin),
        keep: bind(platform.deployments.keep),
        reject: bind(platform.deployments.reject),
        remove: bind(platform.deployments.remove),
        restart: bind(platform.deployments.restart),
        skipPortCheck: bind(platform.deployments.skipPortCheck),
        prepare: bind(platform.deployments.prepare),
        buildAccess: bind(platform.deployments.buildAccess),
        start: bind(platform.deployments.start),
        async *events(id, options = {}) {
          const settings = { ...options };
          const context = await resolveContext();
          for await (const event of platform.deployments.events(context, id, settings)) {
            await resolveContext();
            yield event;
          }
        },
      } satisfies DeploymentOperations);
      const { streamRuntimeLogs, openServerLogStream, ...projectResources } = platform.projects;
      const projects = Object.freeze({
        ...bindGroup(projectResources),
        async *streamRuntimeLogs(id, input = {}, options = {}) {
          const command = structuredClone(input);
          const settings = { ...options };
          const context = await resolveContext();
          for await (const event of streamRuntimeLogs(context, id, command, settings)) {
            await resolveContext();
            yield event;
          }
        },
        async *streamServerLogs(id, input = {}, options = {}) {
          const command = structuredClone(input);
          const settings = { ...options };
          const context = await resolveContext();
          const source = await openServerLogStream(context, id, command, settings);
          for await (const event of parseSSEChunks(source.data)) {
            await resolveContext();
            yield event;
          }
        },
      } satisfies ProjectOperations);
      const { streamLogs, ...serviceResources } = platform.services;
      const services = Object.freeze({
        ...bindGroup(serviceResources),
        async *streamLogs(projectId, serviceId, input = {}, options = {}) {
          const command = structuredClone(input);
          const settings = { ...options };
          const context = await resolveContext();
          for await (const event of streamLogs(context, projectId, serviceId, command, settings)) {
            await resolveContext();
            yield event;
          }
        },
      } satisfies ServiceOperations);
      const sources = Object.freeze({
        open: bind(platform.sources.open),
        scan: bind(platform.sources.scan),
        reveal: bind(platform.sources.reveal),
        async stage(input, options = {}) {
          options.signal?.throwIfAborted();
          options.onStep?.("Staging source");
          const result = await bind(platform.sources.stage)(input);
          options.signal?.throwIfAborted();
          return result;
        },
      } satisfies SourceOperations);
      const { verifyStream, ...domainResources } = platform.domains;
      const domains = Object.freeze({
        ...bindGroup(domainResources),
        async *verifyStream(id, input = {}, options = {}) {
          const command = structuredClone(input);
          const settings = { ...options };
          const context = await resolveContext();
          for await (const event of verifyStream(context, id, command, settings)) {
            await resolveContext();
            yield event;
          }
        },
      } satisfies DomainOperations);
      const dns = bindGroup(platform.dns) satisfies DnsOperations;
      const credentials = bindGroup(platform.credentials) satisfies CredentialOperations;
      const { openInstallStream, openInstallEvents, openMonitor, openContainerApplyStream, openContainerApplyEvents, openManagedNetworkPreparationEvents, openManagedNetworkOperationEvents, openClusterEvents, ...serverResources } = platform.servers;
      const servers = Object.freeze({
        ...bindGroup(serverResources),
        async *managedNetworkPreparationEvents(id, options = {}) {
          const source = await openManagedNetworkPreparationEvents(await resolveContext(), id, { ...options });
          for await (const event of source.data) { await resolveContext(); yield event; }
        },
        async *managedNetworkOperationEvents(id, options = {}) {
          const source = await openManagedNetworkOperationEvents(await resolveContext(), id, { ...options });
          for await (const event of source.data) { await resolveContext(); yield event; }
        },
        async *clusterEvents(options = {}) {
          const source = await openClusterEvents(await resolveContext(), { ...options });
          for await (const event of source.data) { await resolveContext(); yield event; }
        },
        async *applyContainer(id, input, options = {}) {
          const command = structuredClone(input);
          const settings = { ...options };
          const source = await openContainerApplyStream(await resolveContext(), id, command, settings);
          for await (const event of source.data) { await resolveContext(); yield event; }
        },
        async *containerApplyEvents(id, input, options = {}) {
          const command = structuredClone(input);
          const settings = { ...options };
          const source = await openContainerApplyEvents(await resolveContext(), id, command, settings);
          for await (const event of source.data) { await resolveContext(); yield event; }
        },
        async *installComponents(id, input, options = {}) {
          const command = structuredClone(input);
          const settings = { ...options };
          const source = await openInstallStream(await resolveContext(), id, command, settings);
          for await (const event of source.data) { await resolveContext(); yield event; }
        },
        async *installEvents(input = {}, options = {}) {
          const command = structuredClone(input);
          const settings = { ...options };
          const source = await openInstallEvents(await resolveContext(), command, settings);
          for await (const event of source.data) { await resolveContext(); yield event; }
        },
        async *monitor(id, options = {}) {
          const settings = { ...options };
          const source = await openMonitor(await resolveContext(), id, settings);
          for await (const event of source.data) { await resolveContext(); yield event; }
        },
      } satisfies ServerOperations);
      const { openRunStream: openJobRunStream, ...jobResources } = platform.jobs;
      const jobs = Object.freeze({
        ...bindGroup(jobResources),
        async *streamRun(id, options = {}) {
          const source = await openJobRunStream(await resolveContext(), id, { ...options });
          for await (const event of source.data) { await resolveContext(); yield event; }
        },
      } satisfies JobOperations);
      const { openUsageStream: analyticsopenUsageStream, ...analyticsResources } = platform.analytics;
      const analytics = Object.freeze({
        ...bindGroup(analyticsResources),
        async *streamUsage(id, options = {}) {
          const source = await analyticsopenUsageStream(await resolveContext(), id, { ...options });
          for await (const event of source.data) { await resolveContext(); yield event; }
        },
      } satisfies AnalyticsOperations);
      const { openRunStream, openRestoreStream, ...backupResources } = platform.backups;
      const backups = Object.freeze({
        ...bindGroup(backupResources),
        async *streamRun(id, options = {}) {
          const source = await openRunStream(await resolveContext(), id, { ...options });
          for await (const event of source.data) { await resolveContext(); yield event; }
        },
        async *streamRestore(id, options = {}) {
          const source = await openRestoreStream(await resolveContext(), id, { ...options });
          for await (const event of source.data) { await resolveContext(); yield event; }
        },
      } satisfies BackupOperations);
      return Object.freeze({
        organizationId,
        deployments,
        projects,
        sources,
        services,
        domains,
        dns,
        credentials,
        servers,
        system: bindGroup(platform.system),
        apps: bindGroup(platform.apps),
        backupDestinations: bindGroup(platform.backupDestinations),
        backups,
        billing: bindGroup(platform.billing),
        notices: bindGroup(platform.notices),
        github: bindGroup(platform.github),
        permissions: bindGroup(platform.permissions),
        tokens: bindGroup(platform.tokens),
        webhooks: bindGroup(platform.webhooks),
        updates: bindGroup(platform.updates),
        audit: bindGroup(platform.audit),
        settings: bindGroup(platform.settings),
        notifications: bindGroup(platform.notifications),
        issues: bindGroup(platform.issues),
        analytics,
        jobs,
        deployment: (id: string) => createDeploymentHandle(deployments, id),
        deploy: (input: DeploySourceInput) =>
          deploySourceWorkflow({ deployments, projects, sources }, snapshotSourceInput(input)),
      });
    },
  });
}
