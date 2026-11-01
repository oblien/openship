import { AppError, generateId, NotFoundError, safeErrorMessage } from "@repo/core";
import { diagnostics } from "@repo/core/diagnostics";
import { withErrorContext } from "@repo/core/diagnostics/node";
import { audit, operationAuditContext } from "../../lib/audit-emitter";
import { repos, type IngressConnection, type IngressHostname } from "@repo/db";
import type {
  IngressConnection as PublicConnection,
  IngressHostname as PublicHostname,
  IngressConnectInput,
  IngressDomainInput,
  IngressUpdateInput,
  IngressDiscovery,
} from "@repo/contracts";
import type { ExecutionContext } from "../../../context";
import { listProviderCredentials } from "../credentials/credential.service";
import { cloudflareList } from "../../lib/cloudflare-api";
import { createProvisionLock, tryWithProvisionLock } from "../../lib/provision-lock";
import {
  withLiveProjectRuntimeMutation,
  withProjectRuntimeLock,
} from "../../lib/project-runtime-lock";
import { withServerExecution } from "../../lib/server-execution";
import { assertNativeJobs } from "../../native/execution-policy";
import { deferBackgroundWork } from "../../lib/background-work";
import { withServerInventoryLock } from "../../lib/server-inventory-lock";
import { assertSelfHosted, assertServerExecution } from "../system/server-access";
import { authorization } from "../../lib/authorization";
import { CloudflareIngress } from "./cloudflare";
import { manageConnector } from "./connector";
export const publicConnection = (c: IngressConnection): PublicConnection => ({
  id: c.id,
  serverId: c.serverId,
  credentialId: c.credentialId,
  accountId: c.accountId,
  tunnelId: c.tunnelId,
  name: c.managedTunnel ? c.name.replace(` (Openship ${c.id})`, "") : c.name,
  connector: c.connector,
  edgePort: c.edgePort,
  managedTunnel: c.managedTunnel,
  defaultForDomains: c.defaultForDomains,
  defaultAccessPolicyId: c.defaultAccessPolicyId,
  status: c.status,
  error: c.error,
});
export const publicHostname = (h: IngressHostname): PublicHostname => ({
  id: h.id,
  domainId: h.domainId,
  connectionId: h.connectionId,
  hostname: h.hostname,
  accessPolicyId: h.accessPolicyId,
  status: h.status,
  phase: h.phase,
  error: h.error,
});
const lockKey = (c: IngressConnection) => `ingress:cloudflare:${c.accountId}:${c.tunnelId ?? c.id}`;
async function token(organizationId: string, credentialId: string) {
  const credential = (await listProviderCredentials(organizationId, "cloudflare")).find(
    (c) => c.id === credentialId,
  );
  if (!credential?.readable || !credential.secrets.apiToken)
    throw new AppError(
      "Reconnect the saved Cloudflare credential, then retry.",
      409,
      "INGRESS_CREDENTIAL_REQUIRED",
    );
  return credential.secrets.apiToken;
}
async function provider(c: IngressConnection) {
  return new CloudflareIngress(await token(c.organizationId, c.credentialId), c.accountId);
}
async function authorizeServer(ctx: ExecutionContext, id: string) {
  await authorization.authorize(
    { ...ctx, scopeMode: "fixed" },
    { resourceType: "server", resourceId: id, action: "admin" },
  );
}
async function connection(ctx: ExecutionContext, id: string) {
  const row = await repos.ingress.get(ctx.organizationId, id);
  if (!row) throw new NotFoundError("Ingress connection", id);
  await authorizeServer(ctx, row.serverId);
  return row;
}
async function domainOwner(ctx: ExecutionContext, domainId: string) {
  const domain = await repos.domain.findById(domainId);
  const project = domain?.projectId ? await repos.project.findById(domain.projectId) : undefined;
  if (!domain || !project || project.organizationId !== ctx.organizationId)
    throw new NotFoundError("Domain", domainId);
  await authorization.authorize(
    { ...ctx, scopeMode: "fixed" },
    { resourceType: "domain", resourceId: domain.id, action: "read" },
  );
  return { domain, project };
}
export async function listConnections(ctx: ExecutionContext, input: { serverId?: string }) {
  return (await repos.ingress.list(ctx.organizationId, input.serverId)).map(publicConnection);
}
export async function discover(
  ctx: ExecutionContext,
  input: { credentialId: string; accountId?: string; includePolicies?: boolean },
): Promise<IngressDiscovery> {
  const apiToken = await token(ctx.organizationId, input.credentialId);
  // Zone Read is already required. Derive account choices from those zones so
  // discovery does not demand broad Account Settings permission.
  const zones = await cloudflareList<{ account: { id: string; name: string } }>(
    apiToken,
    "/zones?status=active",
  );
  const accounts = [
    ...new Map(zones.filter((z) => z.account?.id).map((z) => [z.account.id, z.account])).values(),
  ];
  const api = input.accountId ? new CloudflareIngress(apiToken, input.accountId) : null;
  const tunnels = api ? await api.tunnels() : [];
  let policies: IngressDiscovery["policies"] = [],
    policiesError: string | null = null;
  if (api && input.includePolicies) {
    try {
      policies = (await api.policies())
        .filter((p) => ["allow", "non_identity"].includes(p.decision))
        .map((p) => ({ id: p.id, name: p.name, decision: p.decision }));
    } catch (error) {
      diagnostics.warn("ingress/discovery", "Could not list Cloudflare Access policies", error);
      policiesError = safeErrorMessage(error);
    }
  }
  return {
    accounts: accounts.map((a) => ({ id: a.id, name: a.name })),
    tunnels: tunnels.map((t) => ({
      id: t.id,
      name: t.name,
      remote: t.config_src === "cloudflare" || t.remote_config === true,
      status: t.status ?? "unknown",
    })),
    policies,
    policiesError,
  };
}
export async function connect(ctx: ExecutionContext, input: IngressConnectInput) {
  assertNativeJobs();
  const server = await repos.server.getInOrganization(input.serverId, ctx.organizationId);
  if (!server || server.purpose !== "deployment")
    throw new NotFoundError("Deployment server", input.serverId);
  // Managed Cloud routing stays on its provider. This integration targets the
  // user's own edge, including SSH destinations managed from Desktop.
  if (server.workspaceId)
    throw new AppError(
      "Cloudflare Tunnel setup requires a connected self-hosted server.",
      400,
      "INGRESS_SELF_HOSTED_REQUIRED",
    );
  await authorizeServer(ctx, server.id);
  await token(ctx.organizationId, input.credentialId);
  assertSelfHosted();
  await assertServerExecution(server);
  return withServerInventoryLock(ctx.organizationId, async () => {
    if (!(await repos.server.getInOrganization(input.serverId, ctx.organizationId)))
      throw new NotFoundError("Server", input.serverId);
    if (await repos.ingress.byServer(input.serverId))
      throw new AppError(
        "This server already has an ingress connection. Disconnect it before choosing another tunnel.",
        409,
        "INGRESS_ALREADY_CONNECTED",
      );
    const id = generateId("igc");
    const created = await repos.ingress.create({
      id,
      organizationId: ctx.organizationId,
      serverId: input.serverId,
      credentialId: input.credentialId,
      accountId: input.accountId,
      tunnelId: input.tunnelId ?? null,
      name: input.tunnelId ? input.name : `${input.name} (Openship ${id})`,
      managedTunnel: !input.tunnelId,
      connector: input.connector,
      edgePort: input.edgePort ?? 80,
      defaultForDomains: input.defaultForDomains,
      defaultAccessPolicyId: input.defaultAccessPolicyId ?? null,
    });
    audit.recordAsync(operationAuditContext(ctx), {
      eventType: "ingress.connection_created",
      resourceType: "ingress_connection",
      resourceId: created.id,
      after: {
        serverId: created.serverId,
        accountId: created.accountId,
        connector: created.connector,
        defaultForDomains: created.defaultForDomains,
      },
    });
    void deferBackgroundWork(() => reconcileConnection(created));
    return publicConnection(created);
  });
}
export async function update(ctx: ExecutionContext, input: IngressUpdateInput) {
  assertNativeJobs();
  const row = await connection(ctx, input.id);
  return createProvisionLock(`ingress-connection:${row.id}`).run(async () => {
    const current = await repos.ingress.get(ctx.organizationId, row.id);
    if (!current || current.status === "removing")
      throw new AppError(
        "Finish disconnecting this tunnel before changing its settings.",
        409,
        "INGRESS_REMOVING",
      );
    if (
      input.defaultAccessPolicyId &&
      input.defaultAccessPolicyId !== current.defaultAccessPolicyId &&
      !(await (await provider(current)).policies()).some(
        (p) =>
          p.id === input.defaultAccessPolicyId && ["allow", "non_identity"].includes(p.decision),
      )
    )
      throw new AppError(
        "Choose an Allow or Service Auth reusable Access policy.",
        400,
        "INGRESS_ACCESS_POLICY",
      );
    const updated = await repos.ingress.update(row.id, {
      defaultForDomains: input.defaultForDomains,
      defaultAccessPolicyId: input.defaultAccessPolicyId,
    });
    audit.recordAsync(operationAuditContext(ctx), {
      eventType: "ingress.defaults_updated",
      resourceType: "ingress_connection",
      resourceId: updated.id,
      after: {
        defaultForDomains: updated.defaultForDomains,
        defaultAccessPolicyId: updated.defaultAccessPolicyId,
      },
    });
    return publicConnection(updated);
  });
}
export async function retry(ctx: ExecutionContext, id: string) {
  assertNativeJobs();
  const row = await connection(ctx, id);
  const updated = await createProvisionLock(`ingress-connection:${id}`).run(async () => {
    const current = await repos.ingress.get(ctx.organizationId, id);
    if (!current) throw new NotFoundError("Ingress connection", id);
    return repos.ingress.update(id, {
      status: current.status === "removing" ? "removing" : "pending",
      error: null,
      nextAttemptAt: new Date(),
    });
  });
  audit.recordAsync(operationAuditContext(ctx), {
    eventType: "ingress.retry_requested",
    resourceType: "ingress_connection",
    resourceId: updated.id,
  });
  void deferBackgroundWork(() => reconcileConnection(updated));
  return publicConnection(updated);
}
export async function disconnect(ctx: ExecutionContext, id: string) {
  assertNativeJobs();
  const row = await connection(ctx, id);
  // Disabling enrollment precedes cleanup; new deployments cannot add work while removing.
  const updated = await createProvisionLock(`ingress-connection:${id}`).run(async () => {
    if (!(await repos.ingress.get(ctx.organizationId, id)))
      throw new NotFoundError("Ingress connection", id);
    return repos.ingress.update(row.id, {
      status: "removing",
      defaultForDomains: false,
      error: null,
      nextAttemptAt: new Date(),
    });
  });
  audit.recordAsync(operationAuditContext(ctx), {
    eventType: "ingress.disconnection_requested",
    resourceType: "ingress_connection",
    resourceId: updated.id,
  });
  void deferBackgroundWork(() => reconcileConnection(updated));
  return { success: true as const };
}
export async function getDomain(ctx: ExecutionContext, input: { domainId: string }) {
  await domainOwner(ctx, input.domainId);
  const row = await repos.ingress.forDomain(input.domainId);
  return row ? publicHostname(row) : null;
}
export async function setDomain(ctx: ExecutionContext, input: IngressDomainInput) {
  assertNativeJobs();
  const { domain, project } = await domainOwner(ctx, input.domainId);
  await authorization.authorize(
    { ...ctx, scopeMode: "fixed" },
    { resourceType: "domain", resourceId: domain.id, action: "write" },
  );
  const saved = await withLiveProjectRuntimeMutation(project.id, async () => {
    const existing = await repos.ingress.forDomain(domain.id);
    if (input.connectionId === null) {
      if (!existing) return null;
      await connection(ctx, existing.connectionId);
      const row = await repos.ingress.updateHost(existing.id, {
        status: "removing",
        nextAttemptAt: new Date(),
        error: null,
      });
      return row;
    }
    const c = await connection(ctx, input.connectionId);
    if (c.status === "removing" || c.serverId !== project.serverId || project.workspaceId)
      throw new AppError(
        "Choose the tunnel connected to this project's deployment server.",
        409,
        "INGRESS_TARGET_MISMATCH",
      );
    if (domain.domainType !== "custom" || domain.hostname.startsWith("*."))
      throw new AppError(
        "Use an exact custom hostname with Cloudflare Tunnel.",
        400,
        "INGRESS_CUSTOM_DOMAIN_REQUIRED",
      );
    if (existing && existing.connectionId !== c.id)
      throw new AppError(
        "Disconnect the hostname from its current tunnel and wait for cleanup before moving it.",
        409,
        "INGRESS_HOST_BUSY",
      );
    const row = await repos.ingress.bindDomain(domain.id, c.id, input.accessPolicyId ?? null);
    return row;
  });
  if (saved === undefined)
    throw new AppError(
      "This project is being removed. Wait for cleanup to finish.",
      409,
      "INGRESS_PROJECT_BUSY",
    );
  if (saved) {
    audit.recordAsync(operationAuditContext(ctx), {
      eventType: input.connectionId
        ? "ingress.hostname_saved"
        : "ingress.hostname_disconnect_requested",
      resourceType: "domain",
      resourceId: domain.id,
      after: { connectionId: input.connectionId, accessPolicyId: saved.accessPolicyId },
    });
    void deferBackgroundWork(() => reconcileHostname(saved));
  }
  return saved ? publicHostname(saved) : null;
}
export async function reconcileConnection(snapshot: IngressConnection): Promise<void> {
  await withErrorContext(
    {
      organizationId: snapshot.organizationId,
      serverId: snapshot.serverId,
      resourceType: "ingress_connection",
      resourceId: snapshot.id,
      attempt: snapshot.attempts + 1,
    },
    () =>
      tryWithProvisionLock(`ingress-connection:${snapshot.id}`, async () => {
        let c = await repos.ingress.get(snapshot.organizationId, snapshot.id);
        if (!c || c.status === "ready" || c.nextAttemptAt.getTime() > Date.now()) return;
        try {
          const api = await provider(c);
          if (c.status === "removing") {
            // Creation may have succeeded before its response or DB receipt was lost.
            // Recover by the setup's unique name without creating a tunnel during cleanup.
            if (c.managedTunnel && !c.tunnelId) {
              const found = await api.findTunnel(c.name);
              if (found) c = await repos.ingress.update(c.id, { tunnelId: found.id });
            }
            for (const host of await repos.ingress.hosts(c.id))
              if (host.status !== "removing" || host.nextAttemptAt.getTime() <= Date.now())
                await reconcileHostname({ ...host, status: "removing" });
            const remaining = await repos.ingress.hosts(c.id);
            if (remaining.length) {
              await repos.ingress.update(c.id, {
                error: remaining.find((h) => h.error)?.error ?? "Waiting for hostname cleanup.",
              });
              return;
            }
            if (c.connector === "managed" && c.tunnelId)
              await withServerExecution(
                c.organizationId,
                c.serverId,
                (exec) => manageConnector(exec, c!, null, true),
                { mutation: true, scope: "ingress" },
              );
            if (c.managedTunnel && c.tunnelId)
              await createProvisionLock(lockKey(c)).run(() =>
                api.deleteTunnel(c!.tunnelId!, c!.name),
              );
            await repos.ingress.remove(c.id);
            return;
          }
          if (!c.tunnelId) {
            const tunnel = await api.createTunnel(c.name);
            c = await repos.ingress.update(c.id, { tunnelId: tunnel.id });
          }
          const tunnel = await api.tunnel(c.tunnelId!);
          if (c.managedTunnel) {
            if (tunnel.name !== c.name)
              throw new AppError(
                "This tunnel was renamed outside Openship. Review it in Cloudflare before retrying.",
                409,
                "INGRESS_PROVIDER_CONFLICT",
              );
            await createProvisionLock(lockKey(c)).run(() => api.initializeTunnel(c!.tunnelId!));
          }
          if (
            c.defaultAccessPolicyId &&
            !(await api.policies()).some(
              (p) =>
                p.id === c!.defaultAccessPolicyId && ["allow", "non_identity"].includes(p.decision),
            )
          )
            throw new AppError(
              "Choose an Allow or Service Auth reusable Access policy.",
              400,
              "INGRESS_ACCESS_POLICY",
            );
          if (c.connector === "managed")
            await withServerExecution(
              c.organizationId,
              c.serverId,
              async (exec) => manageConnector(exec, c!, await api.tokenForTunnel(c!.tunnelId!)),
              { mutation: true, scope: "ingress" },
            );
          const observed = await api.tunnel(tunnel.id);
          if (!["healthy", "degraded"].includes(observed.status ?? ""))
            throw new AppError(
              c.connector === "existing"
                ? "No active connector was found. Start cloudflared on this server with this tunnel, then retry."
                : "The connector is installed but has not connected yet. Check outbound connectivity, then retry.",
              409,
              "INGRESS_CONNECTOR_OFFLINE",
            );
          await repos.ingress.update(c.id, { status: "ready", error: null, attempts: 0 });
          for (const host of await repos.ingress.hosts(c.id))
            await repos.ingress.updateHost(host.id, { nextAttemptAt: new Date() });
        } catch (error) {
          diagnostics.warn("ingress/connection", "Tunnel setup or cleanup did not complete", error);
          await repos.ingress.update(c.id, {
            status: c.status === "removing" ? "removing" : "error",
            error: safeErrorMessage(error).slice(0, 1000),
            attempts: c.attempts + 1,
            nextAttemptAt: new Date(
              Date.now() + Math.min(30_000 * 2 ** Math.min(c.attempts, 7), 3_600_000),
            ),
          });
        }
      }),
  );
}
export async function reconcileHostname(snapshot: IngressHostname): Promise<void> {
  const row = await repos.ingress.host(snapshot.id);
  if (!row) return;
  const c = await repos.ingress.listForHost(row.id);
  if (!c) return;
  const work = async () =>
    withErrorContext(
      {
        organizationId: c.organizationId,
        serverId: c.serverId,
        resourceType: "ingress_hostname",
        resourceId: row.id,
        attempt: row.attempts + 1,
      },
      () =>
        createProvisionLock(lockKey(c)).run(async () => {
          let host = await repos.ingress.host(row.id);
          if (!host) return;
          const currentConnection = await repos.ingress.get(c.organizationId, c.id);
          if (!currentConnection) return;
          const domain = host.domainId ? await repos.domain.findById(host.domainId) : undefined;
          const project = domain?.projectId
            ? await repos.project.findById(domain.projectId)
            : undefined;
          const removing =
            !domain ||
            !project ||
            project.deletionInProgress ||
            Boolean(project.deletedAt) ||
            host.status === "removing" ||
            snapshot.status === "removing" ||
            currentConnection.status === "removing" ||
            domain.hostname !== host.hostname;
          if (
            !removing &&
            host.nextAttemptAt.getTime() > Date.now() &&
            host.nextAttemptAt.getTime() !== snapshot.nextAttemptAt.getTime()
          )
            return;
          const ownership = structuredClone(host.ownership);
          const save = async (value: typeof ownership, phase: string) => {
            await repos.ingress.updateHost(host!.id, { ownership: structuredClone(value), phase });
          };
          try {
            const api = await provider(c);
            if (removing) {
              // Leave Access in place until both publication paths have been removed.
              if (ownership.zoneId || ownership.dnsId || ownership.dnsIntent)
                await api.dns(host, c, ownership, save, true);
              if (c.tunnelId && (ownership.rule || ownership.nextRule))
                await api.rule(host, c, ownership, save, true);
              await api.removeAccess(host, ownership, save);
              await repos.ingress.removeHost(host.id);
              return;
            }
            if (currentConnection.status !== "ready" || !c.tunnelId)
              throw new AppError(
                "Finish connecting the server's Cloudflare Tunnel, then retry.",
                409,
                "INGRESS_CONNECTION_PENDING",
              );
            if (
              !project ||
              project.organizationId !== c.organizationId ||
              project.serverId !== c.serverId
            )
              throw new AppError(
                "The project's deployment server changed. Disconnect this hostname, then connect the tunnel on its new server.",
                409,
                "INGRESS_TARGET_CHANGED",
              );
            if (!domain.externalIngress)
              throw new AppError(
                "This hostname no longer uses external ingress. Disconnect it before changing its routing mode.",
                409,
                "INGRESS_MODE_CHANGED",
              );
            ownership.zoneId ??= (await api.zone(host.hostname)).id;
            await save(ownership, "access");
            await api.access(host, ownership, save);
            const warnings: string[] = [];
            if (!project.activeDeploymentId)
              throw new AppError(
                "Deploy the project to finish connecting this hostname.",
                409,
                "INGRESS_DEPLOYMENT_REQUIRED",
              );
            if (host.status !== "ready")
              await (
                await import("../domains/project-route.service")
              ).reapplyProjectLiveRoutes(project, [], { onWarning: (m) => warnings.push(m) });
            if (warnings.length)
              throw new AppError(
                "The project's edge route is not ready. Retry routing in the project, then retry this connection.",
                409,
                "INGRESS_EDGE_PENDING",
              );
            await api.rule(host, c, ownership, save);
            await api.dns(host, c, ownership, save);
            if (!host.accessPolicyId) await api.removeAccess(host, ownership, save);
            await repos.ingress.completeHostname(host.id, domain.id);
          } catch (error) {
            diagnostics.warn("ingress/hostname", "Hostname reconciliation did not complete", error);
            if (!removing && domain && !domain.verified)
              await repos.domain.recordVerifyFailure(
                domain.id,
                safeErrorMessage(error).slice(0, 1000),
              );
            await repos.ingress.updateHost(host.id, {
              status: removing ? "removing" : "error",
              error: safeErrorMessage(error).slice(0, 1000),
              attempts: host.attempts + 1,
              nextAttemptAt: new Date(
                Date.now() + Math.min(30_000 * 2 ** Math.min(host.attempts, 7), 3_600_000),
              ),
            });
          }
        }),
    );
  // Project lock always precedes the shared tunnel lock. Deletion and route edits
  // cannot race publication. Orphans have no project left to lock.
  const domain = row.domainId ? await repos.domain.findById(row.domainId) : undefined;
  if (domain?.projectId) await withProjectRuntimeLock(domain.projectId, work);
  else await work();
}
