/**
 * Operator config export — servers, projects, routes, release recipes,
 * and non-secret connection metadata. No SSH keys, tokens, or env values.
 */
import { repos, type Domain, type Project, type Server } from "@repo/db";

type ConnectionRow = {
  id: string;
  sourceProjectId: string;
  targetProjectId: string;
  outputId: string;
  envKey: string;
  mode: string;
};
import {
  PROJECT_CONFIG_EXPORT_VERSION,
  resolveEdition,
  type ExportedConnection,
  type ExportedProject,
  type ExportedRoute,
  type ExportedServer,
  type ProjectConfigExport,
} from "@repo/core";
import { env } from "../../config/env";

const SECRET_KEYS = [
  "sshPassword",
  "sshPrivateKey",
  "sshKeyPassphrase",
  "sshKeyPath",
  "cloneTokenEncrypted",
  "webhookSecret",
  "env",
  "envVars",
  "value",
] as const;

export function serializeServerConfig(server: Server): ExportedServer {
  return {
    id: server.id,
    name: server.name ?? null,
    isLocal: server.isLocal,
    sshHost: server.sshHost,
    sshPort: server.sshPort ?? null,
    sshUser: server.sshUser ?? null,
    sshAuthMethod: server.sshAuthMethod ?? null,
  };
}

export function serializeRouteConfig(route: Domain): ExportedRoute {
  return {
    id: route.id,
    hostname: route.hostname,
    domainType: route.domainType ?? null,
    isPrimary: route.isPrimary,
    targetPort: route.targetPort ?? null,
    targetPath: route.targetPath ?? null,
    serviceId: route.serviceId ?? null,
    redirectTo: route.redirectTo ?? null,
    redirectStatus: route.redirectStatus ?? null,
  };
}

export function serializeConnectionConfig(link: ConnectionRow): ExportedConnection {
  return {
    id: link.id,
    sourceProjectId: link.sourceProjectId,
    targetProjectId: link.targetProjectId,
    outputId: link.outputId,
    envKey: link.envKey,
    mode: link.mode,
  };
}

export function serializeProjectConfig(
  project: Project,
  routes: Domain[],
  connections: ConnectionRow[],
): ExportedProject {
  return {
    id: project.id,
    name: project.name,
    slug: project.slug,
    environmentName: project.environmentName,
    environmentSlug: project.environmentSlug,
    environmentType: project.environmentType,
    isApp: project.isApp,
    appTemplateId: project.appTemplateId ?? null,
    gitProvider: project.gitProvider ?? null,
    gitOwner: project.gitOwner ?? null,
    gitRepo: project.gitRepo ?? null,
    gitBranch: project.gitBranch ?? null,
    gitUrl: project.gitUrl ?? null,
    localPath: project.localPath ?? null,
    framework: project.framework ?? null,
    packageManager: project.packageManager ?? null,
    installCommand: project.installCommand ?? null,
    buildCommand: project.buildCommand ?? null,
    outputDirectory: project.outputDirectory ?? null,
    productionPaths: project.productionPaths ?? null,
    rootDirectory: project.rootDirectory ?? null,
    composePath: project.composePath ?? null,
    startCommand: project.startCommand ?? null,
    buildImage: project.buildImage ?? null,
    productionMode: project.productionMode ?? null,
    port: project.port ?? null,
    serverId: project.serverId ?? null,
    internalAlias: project.internalAlias ?? null,
    autoDeploy: project.autoDeploy,
    mountedRelease: project.mountedRelease ?? null,
    releaseSource: project.releaseSource ?? null,
    routes: routes.map(serializeRouteConfig),
    connections: connections.map(serializeConnectionConfig),
  };
}

/** True if a serialized object still contains a known secret field name. */
export function exportContainsSecretKeys(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(exportContainsSecretKeys);
  for (const [key, child] of Object.entries(value)) {
    if ((SECRET_KEYS as readonly string[]).includes(key)) return true;
    if (exportContainsSecretKeys(child)) return true;
  }
  return false;
}

export async function exportProjectConfig(organizationId: string): Promise<ProjectConfigExport> {
  const [servers, { rows: projects }] = await Promise.all([
    repos.server.listByOrganization(organizationId),
    repos.project.listByOrganization(organizationId, { page: 1, perPage: 5000 }),
  ]);

  const projectIds = projects.map((p) => p.id);
  const routesByProject = await repos.domain.listByProjects(projectIds);
  const connections = await Promise.all(projectIds.map((id) => repos.projectConnection.listByTarget(id)));
  const connectionsByProject = new Map(projectIds.map((id, i) => [id, connections[i] ?? []]));

  return {
    version: PROJECT_CONFIG_EXPORT_VERSION,
    edition: resolveEdition({ cloudMode: env.CLOUD_MODE === true }),
    exportedAt: new Date().toISOString(),
    organizationId,
    servers: servers.map(serializeServerConfig),
    projects: projects.map((project) =>
      serializeProjectConfig(
        project,
        routesByProject.get(project.id) ?? [],
        connectionsByProject.get(project.id) ?? [],
      ),
    ),
  };
}
