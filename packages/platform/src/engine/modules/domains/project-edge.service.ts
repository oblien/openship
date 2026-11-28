import { reportCaughtError as observeCaughtError } from "@repo/core/diagnostics";
import { repos } from "@repo/db";
import { isLoopbackHost, mapConcurrent, safeErrorMessage } from "@repo/core";
import { isIP } from "node:net";
import {
  COMPONENT_INSTALLERS,
  type CommandExecutor,
  ensureEdge,
  ourEdgeContainerRunning,
  recoverInterruptedTakeover,
  scanRunningOpenshipEdge,
  type PromptPayload,
  type PromptUserFn,
  type SystemLog,
} from "@repo/adapters";
import type { ExecutionContext } from "../../../context";
import { isArtifactRef, usableRef } from "../../lib/container-ref";
import { pickProjectPortOwner } from "../../lib/project-service-upstream";
import { buildServiceRouteDomains } from "../../lib/routing-domains";
import { resolveRouteStrategy } from "../../lib/upstream-url";
import { findActiveDeployment } from "../../lib/active-deployment";
import {
  disposeRuntime,
  resolveDeploymentRuntimeForRead,
  usesManagedRouting,
  withDeploymentPlatform,
} from "../../lib/deployment-runtime";
import { platform } from "../../lib/platform-config";
import { ensureEdgeChallengeReady } from "../../lib/edge-challenge";
import { repairEdgeVhosts } from "../../lib/edge-vhost-repair";
import { pinnedEdgeImage, withPinnedEdgeImage } from "../../lib/edge-image";
import { deliverManagedImage } from "../../lib/deliver-managed-image";
import { resolveEdgeProviderOptions } from "../../lib/edge-provider-options";
import { manageDomainSsl, tlsIssuedElsewhere } from "../../lib/domain-ssl";
import { withLiveProjectRuntimeMutation } from "../../lib/project-runtime-lock";
import { createProvisionLock } from "../../lib/provision-lock";
import { sshManager } from "../../lib/ssh-manager";
import { canRouteSelfApp } from "../../lib/self-app-routing";
import { findLocalServer } from "../../lib/startup/self-server";
import { resolveProjectLiveDeployTarget } from "../projects/project-deploy-target";
import { applyProjectRouting } from "./routing-apply.service";
import { reapplyProjectLiveRoutes } from "./project-route.service";
import { reuseServerCertForDomain, verifyDomain } from "./domain.service";

/** Resolve the serving box from the active deployment, including desktop → SSH. */
export async function resolveProjectServer(
  projectId: string,
  organizationId: string,
): Promise<
  | {
      project: NonNullable<Awaited<ReturnType<typeof repos.project.findById>>>;
      serverId: string;
      isLocal: boolean;
    }
  | { error: string; status: 400 | 404; managed?: "cloud" }
> {
  const project = await repos.project.findById(projectId);
  if (!project || project.organizationId !== organizationId)
    return { error: "Project not found", status: 404 };
  let { deployTarget, serverId } = await resolveProjectLiveDeployTarget(project);
  if (deployTarget === "cloud")
    return {
      error: "Cloud projects manage routing at the edge automatically",
      status: 400,
      managed: "cloud",
    };
  if (!project.activeDeploymentId)
    return { error: "Deploy the project before setting up its edge", status: 400 };
  if (!serverId && deployTarget === "local")
    serverId = (await findLocalServer().catch((diagnosticFailure) => { observeCaughtError(diagnosticFailure, "platform/engine/modules/domains/project-edge.service"); return null; }))?.id ?? null;
  if (!serverId) return { error: "Project is not deployed to a server", status: 400 };
  const server = await repos.server.getInOrganization(serverId, organizationId).catch((diagnosticFailure) => { observeCaughtError(diagnosticFailure, "platform/engine/modules/domains/project-edge.service"); return null; });
  if (!server) return { error: "Project deployment server was not found", status: 400 };
  return { project, serverId, isLocal: Boolean(server.isLocal) };
}

/**
 * Report proven address drift on direct bridge-IP routes. The supported retry
 * operation owns every write, including route locking and TLS preservation.
 */
export async function staleProjectEdgeUpstreams(
  project: NonNullable<Awaited<ReturnType<typeof repos.project.findById>>>,
  executor: CommandExecutor,
  edgeContainer: string,
): Promise<string[]> {
  if (resolveRouteStrategy(project.routeStrategy) !== "container-ip") return [];
  const deployment = await findActiveDeployment(project);
  if (!deployment) return [];
  const { deployTarget } = await resolveProjectLiveDeployTarget(project, deployment);
  if (!deployTarget || deployTarget === "cloud") return [];
  const managedRouting = usesManagedRouting(platform().target, deployTarget);

  const [domains, defs, rows] = await Promise.all([
    repos.domain.listByProject(project.id),
    repos.service.listByProject(project.id),
    repos.service.listByDeployment(deployment.id),
  ]);
  const topologyHosts = new Set(project.compositeRoutes?.map((route) => route.hostname.toLowerCase()));
  const domainByHostname = new Map(domains.map((domain) => [domain.hostname.toLowerCase(), domain]));
  const rowByService = new Map(rows.map((row) => [row.serviceId, row]));

  const serviceRoutes = new Map<string, { serviceId: string; containerPort: number }>();
  for (const service of defs) {
    if (!service.enabled) continue;
    for (const route of buildServiceRouteDomains({
      project,
      service,
      domainByHostname,
      runtimeName: "docker",
      usesManagedRouting: managedRouting,
    })) {
      const hostname = route.hostname.toLowerCase();
      if (route.targetPort && !route.redirectTo && domainByHostname.get(hostname)?.serviceId === service.id) {
        serviceRoutes.set(hostname, { serviceId: service.id, containerPort: route.targetPort });
      }
    }
  }

  const candidates = domains.flatMap((domain) => {
    const hostname = domain.hostname.toLowerCase();
    if (topologyHosts.has(hostname) || domain.redirectTo || domain.targetPath) return [];
    const port = domain.targetPort ?? (defs.length ? null : project.port);
    const owner = domain.serviceId
      ? serviceRoutes.get(hostname)
      : port
        ? pickProjectPortOwner({ port, services: defs, rowByService, domainRows: domains })
        : null;
    const containerPort = owner?.containerPort ?? port;
    const containerId = usableRef(
      owner ? rowByService.get(owner.serviceId)?.containerId : !domain.serviceId ? deployment.containerId : null,
    );
    return containerPort && containerId && !isArtifactRef(containerId)
      ? [{ hostname, containerId, containerPort }]
      : [];
  });
  if (!candidates.length) return [];

  const { runtime } = await resolveDeploymentRuntimeForRead(deployment);
  try {
    if (runtime.name !== "docker" || !runtime.supports("containerInfo") || !runtime.getContainerInfo) return [];
    const inspect = runtime.getContainerInfo.bind(runtime);
    const { sites } = await scanRunningOpenshipEdge(executor, edgeContainer);
    const byHostname = new Map(sites.flatMap((site) =>
      site.serverNames.map((hostname) => [hostname.toLowerCase(), site] as const),
    ));
    const lookups = new Map<string, ReturnType<typeof inspect>>();
    const stale = await mapConcurrent(candidates, 4, async ({ hostname, containerId, containerPort }) => {
      try {
        const site = byHostname.get(hostname);
        if (site?.target.kind !== "proxy" || (site.routes?.length ?? 0) > 1) return null;
        const upstream = new URL(site.target.url);
        const current = upstream.hostname;
        const currentPort = Number(upstream.port || (upstream.protocol === "https:" ? 443 : 80));
        if (currentPort !== containerPort || isIP(current) !== 4 || isLoopbackHost(current))
          return null;
        let live = lookups.get(containerId);
        if (!live) {
          live = inspect(containerId);
          lookups.set(containerId, live);
        }
        const { ip, status } = await live;
        return status === "running" && ip && isIP(ip) === 4 && ip !== current ? hostname : null;
      } catch (error) {
        observeCaughtError(error, "platform/engine/modules/domains/project-edge.service");
        return null;
      }
    });
    return [...new Set(stale.filter((hostname): hostname is string => hostname !== null))].sort();
  } finally {
    disposeRuntime(runtime);
  }
}

/** The same consent/install path for migration and the project's Set up edge action. */
export async function prepareServerEdge(
  serverId: string,
  organizationId: string,
  opts: { onLog: (log: SystemLog) => void; promptUser?: PromptUserFn; projectId?: string },
): Promise<void> {
  const server = await repos.server.getInOrganization(serverId, organizationId);
  if (!server) throw new Error("Server not found");
  let promptUser = opts.promptUser;
  if (opts.projectId && promptUser) {
    const project = await repos.project.findById(opts.projectId);
    if (!project || project.organizationId !== organizationId) throw new Error("Project not found");
    const domains = await repos.domain.listByProject(project.id);
    const services = await repos.service.listByProject(project.id);
    const assignments = new Map(
      domains.flatMap((domain) => {
        const service = services.find((row) => row.id === domain.serviceId);
        return service
          ? [[domain.hostname.toLowerCase(), `${project.name} / ${service.name}`] as const]
          : [];
      }),
    );
    const ask = promptUser;
    promptUser = (prompt: PromptPayload) => {
      const sites = prompt.details?.sites;
      if (!Array.isArray(sites)) return ask(prompt);
      return ask({
        ...prompt,
        details: {
          ...prompt.details,
          sites: sites.map((site) => ({
            ...site,
            projectServices: Array.isArray(site.serverNames)
              ? [
                  ...new Set(
                    site.serverNames.flatMap(
                      (host: string) => assignments.get(host.toLowerCase()) ?? [],
                    ),
                  ),
                ]
              : [],
          })),
        },
      });
    };
  }
  const scope = server.isLocal ? "provision:local" : `provision:server:${serverId}`;
  await createProvisionLock(scope).run(() =>
    sshManager.withExecutor(serverId, async (executor) => {
      await recoverInterruptedTakeover(executor, opts.onLog);
      await deliverManagedImage({
        kind: "edge",
        image: pinnedEdgeImage(),
        targetExecutor: executor,
        onLog: opts.onLog,
      });
      const edge = await ensureEdge(
        executor,
        (promptUser) =>
          COMPONENT_INSTALLERS.edge(executor, opts.onLog, withPinnedEdgeImage({ promptUser })),
        {
          onLog: opts.onLog,
          promptUser,
          nginx: await resolveEdgeProviderOptions(server),
          edgeImage: pinnedEdgeImage(),
        },
      );
      if (edge.migrated && !edge.ok)
        throw new Error("Edge takeover failed. Check the setup log for rollback details.");
      if (!(await ourEdgeContainerRunning(executor)))
        throw new Error("The server's edge container is not running after setup.");
    }),
  );
}

/** Reconcile the complete live route table, then retry verification against the ready edge. */
export async function applyProjectEdgeRoutes(
  ctx: ExecutionContext,
  projectId: string,
  opts: {
    onLog: (message: string, level?: "info" | "warn" | "error") => void;
    previousHostnames?: string[];
  },
): Promise<string[]> {
  const warnings: string[] = [];
  const warn = (message: string) => {
    if (warnings.includes(message)) return;
    warnings.push(message);
    opts.onLog(message, "warn");
  };
  const applied = await withLiveProjectRuntimeMutation(projectId, async (project) => {
    const target = await resolveProjectServer(projectId, ctx.organizationId);
    if ("error" in target) throw new Error(target.error);
    const deployment = await findActiveDeployment(project);
    if (!deployment) throw new Error("The active deployment no longer exists");
    await withDeploymentPlatform(deployment, async ({ routing }) => {
      await ensureEdgeChallengeReady(ctx.organizationId, routing, {
        serverId: target.serverId,
        onLog: (message) => opts.onLog(message.trim()),
      });
      await repairEdgeVhosts(routing, {
        onLog: (message, level) => opts.onLog(message.trim(), level),
      });
    }).catch((error) => { observeCaughtError(error, "platform/engine/modules/domains/project-edge.service"); return warn(`Edge preparation: ${safeErrorMessage(error)}`); });
    // Per-domain writes first, topology overlays last. Reversing these erases fan-out.
    await reapplyProjectLiveRoutes(project, opts.previousHostnames ?? [], {
      isSelfApp: await canRouteSelfApp(ctx, projectId),
      onWarning: warn,
    }).catch((error) => { observeCaughtError(error, "platform/engine/modules/domains/project-edge.service"); return warn(`Route apply: ${safeErrorMessage(error)}`); });
    await applyProjectRouting(projectId, { onWarning: warn }).catch((error) =>
      { observeCaughtError(error, "platform/engine/modules/domains/project-edge.service"); return warn(`Route apply: ${safeErrorMessage(error)}`); },
    );
    return true;
  });
  if (!applied) throw new Error("The project was deleted while edge setup was in progress");

  // A route may have been saved while Traefik still owned 80/443. Retry NOW,
  // after takeover has carried its certs, rather than waiting for a sweep/restart.
  const domains = await repos.domain.listByProject(projectId);
  for (const domain of domains.filter((row) => row.domainType !== "free")) {
    try {
      if (domain.verified) {
        if (
          ["none", "provisioning", "error"].includes(domain.sslStatus) &&
          !tlsIssuedElsewhere(domain)
        ) {
          opts.onLog(`Retrying the pending certificate for ${domain.hostname}…`);
          const result = await manageDomainSsl(domain.hostname, { action: "provision", projectId });
          if (!result.verified)
            warn(`${domain.hostname}: certificate provisioning is still pending`);
        }
        continue;
      }
      if (!domain.externalIngress && (await reuseServerCertForDomain(ctx, domain.id))) continue;
      const result = await verifyDomain(ctx, domain.id, { onLog: opts.onLog });
      if (!result.verified)
        warn(`${domain.hostname}: ${result.message || "verification is still pending"}`);
    } catch (error) {
      observeCaughtError(error, "platform/engine/modules/domains/project-edge.service");
      warn(`${domain.hostname}: ${safeErrorMessage(error)}`);
    }
  }
  return warnings;
}
