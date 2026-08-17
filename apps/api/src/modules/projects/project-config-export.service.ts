/**
 * Operator config export — servers, projects, routes, release recipes,
 * and non-secret connection metadata. No SSH keys, tokens, or env values.
 */
import { repos, type Domain, type Project, type Server } from "@repo/db";
import {
  PROJECT_CONFIG_EXPORT_VERSION,
  ValidationError,
  exportContainsSecretKeys,
  resolveEdition,
  serializeMountedRelease,
  type ExportedConnection,
  type ExportedProject,
  type ExportedRoute,
  type ExportedServer,
  type ProjectConfigExport,
  type ReleaseSource,
} from "@repo/core";
import { env } from "../../config/env";

export { exportContainsSecretKeys, serializeMountedRelease };

type ConnectionRow = {
  id: string;
  sourceProjectId: string;
  targetProjectId: string;
  outputId: string;
  envKey: string;
  mode: string;
};

const EXPORT_PAGE_SIZE = 500;
const EXPORT_MAX_PROJECTS = 5000;

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

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function serializeReleaseSource(raw: unknown): ReleaseSource | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (o.mode !== "github" && o.mode !== "url") return null;
  const out: ReleaseSource = { mode: o.mode };
  const repo = optionalString(o.repo);
  if (repo !== undefined) out.repo = repo;
  const assetTemplate = optionalString(o.assetTemplate);
  if (assetTemplate !== undefined) out.assetTemplate = assetTemplate;
  const os = optionalString(o.os);
  if (os !== undefined) out.os = os;
  const arch = optionalString(o.arch);
  if (arch !== undefined) out.arch = arch;
  const distUrl = optionalString(o.distUrl);
  if (distUrl !== undefined) out.distUrl = distUrl;
  const sha256Url = optionalString(o.sha256Url);
  if (sha256Url !== undefined) out.sha256Url = sha256Url;
  const sha256 = optionalString(o.sha256);
  if (sha256 !== undefined) out.sha256 = sha256;
  const versionUrl = optionalString(o.versionUrl);
  if (versionUrl !== undefined) out.versionUrl = versionUrl;
  const channel = optionalString(o.channel);
  if (channel !== undefined) out.channel = channel;
  const pinnedVersion = optionalString(o.pinnedVersion);
  if (pinnedVersion !== undefined) out.pinnedVersion = pinnedVersion;
  if (typeof o.trackReleases === "boolean") out.trackReleases = o.trackReleases;
  return out;
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
    mountedRelease: serializeMountedRelease(project.mountedRelease),
    releaseSource: serializeReleaseSource(project.releaseSource),
    routes: routes.map(serializeRouteConfig),
    connections: connections.map(serializeConnectionConfig),
  };
}

export function assertExportSafe(value: unknown): void {
  if (exportContainsSecretKeys(value)) {
    throw new ValidationError("Config export contained a secret field and was refused.");
  }
}

/**
 * A scoped PAT/MCP token may only export the projects it was granted and the
 * servers those projects actually reference.
 */
export function applyExportScope(
  projects: Project[],
  servers: Server[],
  scopedIds: Set<string> | null,
): { projects: Project[]; servers: Server[] } {
  if (!scopedIds) return { projects, servers };
  const scopedProjects = projects.filter((p) => scopedIds.has(p.id));
  const serverIds = new Set(
    scopedProjects.map((p) => p.serverId).filter((id): id is string => typeof id === "string" && id.length > 0),
  );
  return {
    projects: scopedProjects,
    servers: servers.filter((s) => serverIds.has(s.id)),
  };
}

async function loadProjects(
  organizationId: string,
  scopedIds: Set<string> | null,
): Promise<{ projects: Project[]; total: number; truncated: boolean }> {
  const collected: Project[] = [];
  let total = 0;
  let page = 1;
  for (;;) {
    const result = await repos.project.listByOrganization(organizationId, {
      page,
      perPage: EXPORT_PAGE_SIZE,
    });
    total = result.total;
    collected.push(...result.rows);
    const haveAllScoped =
      !!scopedIds && [...scopedIds].every((id) => collected.some((p) => p.id === id));
    if (result.rows.length < EXPORT_PAGE_SIZE || collected.length >= EXPORT_MAX_PROJECTS || haveAllScoped) {
      break;
    }
    page += 1;
  }
  const truncated = total > collected.length;
  return { projects: collected, total, truncated };
}

export async function exportProjectConfig(
  organizationId: string,
  opts?: { projectIds?: Set<string> | null },
): Promise<ProjectConfigExport> {
  const scopedIds = opts?.projectIds ?? null;
  const [{ projects: loadedProjects, total, truncated }, allServers] = await Promise.all([
    loadProjects(organizationId, scopedIds),
    repos.server.listByOrganization(organizationId),
  ]);
  const { projects, servers } = applyExportScope(loadedProjects, allServers, scopedIds);
  const missingScoped =
    !!scopedIds && [...scopedIds].some((id) => !loadedProjects.some((p) => p.id === id));

  const projectIds = projects.map((p) => p.id);
  const routesByProject = await repos.domain.listByProjects(projectIds);
  const connections = await Promise.all(projectIds.map((id) => repos.projectConnection.listByTarget(id)));
  const connectionsByProject = new Map(projectIds.map((id, i) => [id, connections[i] ?? []]));

  const payload: ProjectConfigExport = {
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
    total: scopedIds ? projects.length : total,
    truncated: scopedIds ? missingScoped && truncated : truncated,
  };
  assertExportSafe(payload);
  return payload;
}
