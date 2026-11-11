import { AppError } from "@repo/core";
import { z } from "zod";
import { mapWithLimit } from "../../../lib/map-with-limit";
import type { PlatformMigrationSource, PlatformProject } from "@repo/contracts";
import { railwayQuery, type ProviderAccess } from "../../credentials/provider-api";
import type { MigrationSourceProvider, ProviderService } from "./types";
import {
  providerId,
  nodes,
  envMap,
  parseProvider,
  githubRepository,
  databaseKind,
  nextCursor,
  MAX_DISCOVERY_PAGES,
} from "./common";

const named = z.object({ id: providerId, name: z.string() });
const environment = named.extend({
  canAccess: z.boolean().optional(),
  deletedAt: z.string().nullable().optional(),
});
const project = named.extend({ environments: nodes(environment) });
const projectFields =
  "id name environments(first: 100) { edges { node { id name canAccess deletedAt } } pageInfo { hasNextPage endCursor } }";

async function projects(access: ProviderAccess): Promise<PlatformProject[]> {
  if (access.publicFields.tokenType === "project") {
    const data = parseProvider(
      z.object({ projectToken: z.object({ project: named, environment: named }) }),
      await railwayQuery(
        access,
        "query { projectToken { project { id name } environment { id name } } }",
      ),
    );
    return [{ ...data.projectToken.project, environments: [data.projectToken.environment] }];
  }
  const workspaceScoped = access.publicFields.tokenType === "workspace";
  const workspaces = workspaceScoped
    ? [{ id: access.publicFields.workspaceId }]
    : parseProvider(
        z.object({ me: z.object({ workspaces: z.array(z.object({ id: providerId })) }) }),
        await railwayQuery(access, "query { me { workspaces { id } } }"),
      ).me.workspaces;
  const result: PlatformProject[] = [];
  for (const workspace of workspaces) {
    let cursor: string | undefined;
    for (let page = 0; page < MAX_DISCOVERY_PAGES; page++) {
      const selection = `projects(first: 100, after: $after${workspaceScoped ? ", workspaceId: $workspace" : ""}) { edges { node { ${projectFields} } } pageInfo { hasNextPage endCursor } }`;
      const query = `query($workspace: String!, $after: String) { ${workspaceScoped ? selection : `workspace(workspaceId: $workspace) { ${selection} }`} }`;
      const response = await railwayQuery(access, query, {
        workspace: workspace.id,
        after: cursor ?? null,
      });
      const connection = workspaceScoped
        ? parseProvider(z.object({ projects: nodes(project) }), response).projects
        : parseProvider(z.object({ workspace: z.object({ projects: nodes(project) }) }), response)
            .workspace.projects;
      for (const { node } of connection.edges) {
        if (node.environments.pageInfo.hasNextPage)
          throw new AppError(
            "This project has more than 100 environments. Connect a project token for the environment to import.",
            400,
            "MIGRATION_ENVIRONMENT_SCOPE_REQUIRED",
          );
        result.push({
          id: node.id,
          name: node.name,
          environments: node.environments.edges
            .filter(({ node }) => node.canAccess !== false && !node.deletedAt)
            .map(({ node }) => ({ id: node.id, name: node.name })),
        });
      }
      cursor = nextCursor(cursor, connection.pageInfo);
      if (!cursor) break;
      if (page === MAX_DISCOVERY_PAGES - 1)
        throw new AppError(
          "Narrow this connection's workspace scope before importing",
          400,
          "MIGRATION_DISCOVERY_LIMIT",
        );
    }
  }
  return result;
}

const domain = z.object({ domain: z.string(), targetPort: z.number().nullable().optional() });
const deployment = z.object({
  id: providerId,
  meta: z.record(z.string(), z.unknown()).nullable(),
  deploymentStopped: z.boolean(),
});
const service = z.object({
  id: providerId,
  serviceId: providerId,
  serviceName: z.string(),
  source: z.object({ image: z.string().nullable(), repo: z.string().nullable() }).nullable(),
  rootDirectory: z.string().nullable(),
  dockerfilePath: z.string().nullable(),
  buildCommand: z.string().nullable(),
  startCommand: z.string().nullable(),
  cronSchedule: z.string().nullable(),
  healthcheckPath: z.string().nullable().optional(),
  healthcheckTimeout: z.number().nullable().optional(),
  numReplicas: z.number().nullable().optional(),
  preDeployCommand: z.unknown().optional(),
  restartPolicyType: z.string().optional(),
  restartPolicyMaxRetries: z.number().optional(),
  sleepApplication: z.boolean().nullable().optional(),
  activeDeployments: z.array(deployment),
  domains: z.object({ serviceDomains: z.array(domain), customDomains: z.array(domain) }),
});
const volume = z.object({
  id: providerId,
  serviceId: z.string().nullable(),
  mountPath: z.string(),
  currentSizeMB: z.number().nullable(),
  deletedAt: z.string().nullable(),
  isPendingDeletion: z.boolean(),
  volume: named,
});
const fieldString = (value: unknown) => (typeof value === "string" ? value : undefined);

async function discover(access: ProviderAccess, source: PlatformMigrationSource) {
  // The list is also the scope check: project tokens cannot name another environment.
  const chosen = (await projects(access)).find((p) => p.id === source.projectId);
  const selectedEnvironment = chosen?.environments.find((e) => e.id === source.environmentId);
  if (!chosen || !selectedEnvironment)
    throw new AppError(
      "This connection cannot access the selected project and environment",
      404,
      "MIGRATION_SOURCE_NOT_FOUND",
    );
  const services: z.infer<typeof service>[] = [];
  const volumes: z.infer<typeof volume>[] = [];
  let serviceCursor: string | undefined, volumeCursor: string | undefined;
  let servicesDone = false,
    volumesDone = false;
  for (let page = 0; page < MAX_DISCOVERY_PAGES; page++) {
    const data = parseProvider(
      z.object({
        environment: z.object({ serviceInstances: nodes(service), volumeInstances: nodes(volume) }),
      }),
      await railwayQuery(
        access,
        `query($project: String!, $environment: String!, $services: String, $volumes: String) {
        environment(id: $environment, projectId: $project) {
          serviceInstances(first: 100, after: $services) { edges { node {
            id serviceId serviceName source { image repo } rootDirectory dockerfilePath buildCommand startCommand cronSchedule
            healthcheckPath healthcheckTimeout numReplicas preDeployCommand restartPolicyType restartPolicyMaxRetries sleepApplication
            activeDeployments { id meta deploymentStopped }
            domains { serviceDomains { domain targetPort } customDomains { domain targetPort } }
          } } pageInfo { hasNextPage endCursor } }
          volumeInstances(first: 100, after: $volumes) { edges { node { id serviceId mountPath currentSizeMB deletedAt isPendingDeletion volume { id name } } } pageInfo { hasNextPage endCursor } }
        }
      }`,
        {
          project: source.projectId,
          environment: source.environmentId,
          services: serviceCursor ?? null,
          volumes: volumeCursor ?? null,
        },
      ),
    );
    if (!servicesDone) {
      services.push(...data.environment.serviceInstances.edges.map((e) => e.node));
      serviceCursor = nextCursor(serviceCursor, data.environment.serviceInstances.pageInfo);
      servicesDone = !serviceCursor;
    }
    if (!volumesDone) {
      volumes.push(...data.environment.volumeInstances.edges.map((e) => e.node));
      volumeCursor = nextCursor(volumeCursor, data.environment.volumeInstances.pageInfo);
      volumesDone = !volumeCursor;
    }
    if (servicesDone && volumesDone) break;
    if (page === MAX_DISCOVERY_PAGES - 1)
      throw new AppError(
        "The source is too large for one import. Select a smaller environment.",
        400,
        "MIGRATION_DISCOVERY_LIMIT",
      );
  }
  const shared = parseProvider(
    z.object({
      raw: envMap,
      environment: z.object({
        variables: nodes(
          z.object({ name: z.string(), serviceId: z.string().nullable(), isSealed: z.boolean() }),
        ),
      }),
    }),
    await railwayQuery(
      access,
      `query($project: String!, $environment: String!) {
      raw: variables(projectId: $project, environmentId: $environment, unrendered: true)
      environment(id: $environment, projectId: $project) { variables(first: 10000) { edges { node { name serviceId isSealed } } pageInfo { hasNextPage endCursor } } }
    }`,
      { project: source.projectId, environment: source.environmentId },
    ),
  );
  if (shared.environment.variables.pageInfo.hasNextPage)
    throw new AppError("Variable discovery is incomplete", 502, "MIGRATION_DISCOVERY_INCOMPLETE");
  const result = await mapWithLimit(services, 4, async (s): Promise<ProviderService> => {
    const values = parseProvider(
      z.object({ raw: envMap, resolved: envMap }),
      await railwayQuery(
        access,
        `query($project: String!, $environment: String!, $service: String!) {
        raw: variables(projectId: $project, environmentId: $environment, serviceId: $service, unrendered: true)
        resolved: variablesForServiceDeployment(projectId: $project, environmentId: $environment, serviceId: $service)
      }`,
        { project: source.projectId, environment: source.environmentId, service: s.serviceId },
      ),
    );
    const names = [
      ...new Set([
        ...Object.keys(shared.raw),
        ...Object.keys(values.raw),
        ...shared.environment.variables.edges
          .filter(({ node }) => !node.serviceId || node.serviceId === s.serviceId)
          .map(({ node }) => node.name),
      ]),
    ];
    const sealed = new Set(
      shared.environment.variables.edges
        .filter(({ node }) => node.isSealed && (!node.serviceId || node.serviceId === s.serviceId))
        .map(({ node }) => node.name),
    );
    const env = Object.fromEntries(
      names
        .filter(
          (key) =>
            !key.startsWith("RAILWAY_") &&
            !sealed.has(key) &&
            typeof values.resolved[key] === "string",
        )
        .map((key) => [key, values.resolved[key]]),
    );
    const active = s.activeDeployments.filter((d) => !d.deploymentStopped);
    const meta = active[0]?.meta ?? {};
    const configuredImage = s.source?.image ?? undefined;
    const digest = fieldString(meta.imageDigest);
    const image =
      configuredImage && digest && /^sha256:[a-f0-9]{64}$/i.test(digest)
        ? `${configuredImage.split("@")[0]}@${digest}`
        : configuredImage;
    const database = databaseKind(image);
    const repository = githubRepository(s.source?.repo);
    const commit = fieldString(meta.commitHash);
    const blockers: string[] = [];
    const warnings: string[] = [];
    if (configuredImage && !image?.includes("@sha256:"))
      warnings.push(
        "Railway did not expose the deployed image digest. This import uses the configured tag; confirm that it still identifies the source version before copying data.",
      );
    if (configuredImage && meta.image && meta.image !== configuredImage)
      blockers.push(
        "The configured image differs from the running deployment. Deploy the intended source image and discover it again.",
      );
    if (active.some((d) => d.meta?.imageDigest !== meta.imageDigest))
      blockers.push(
        "Active deployments use different image digests. Select one source version before importing.",
      );
    if (!image && !repository)
      blockers.push("Connect a GitHub source or a portable container image for this service.");
    if (repository && (!commit || !/^[a-f0-9]{40}$/i.test(commit)))
      blockers.push(
        "Railway did not return a full deployed Git commit. Deploy this service on Railway before importing it.",
      );
    if (active.some((d) => d.meta?.commitHash !== meta.commitHash))
      blockers.push(
        "Active deployments use different revisions. Select one source revision before importing.",
      );
    if (s.cronSchedule)
      blockers.push(
        "This service has a Railway schedule. Configure its equivalent in Openship before enabling it.",
      );
    if (s.numReplicas != null && s.numReplicas !== 1)
      blockers.push(
        "This service uses a replica count other than one. Review its scaling and topology before importing.",
      );
    if (s.preDeployCommand && (!Array.isArray(s.preDeployCommand) || s.preDeployCommand.length > 0))
      blockers.push(
        "This service runs a pre-deploy command. Move it into a reviewed deployment workflow before importing; it will not be silently skipped.",
      );
    if (s.sleepApplication)
      warnings.push(
        "Railway serverless sleeping is not transferred. The imported service runs continuously.",
      );
    if (s.restartPolicyType && !["ALWAYS", "ON_FAILURE", "NEVER"].includes(s.restartPolicyType))
      blockers.push("This service's restart policy is not supported. Review it before importing.");
    if (
      s.healthcheckPath &&
      (!s.healthcheckPath.startsWith("/") ||
        /[\r\n\0]/.test(s.healthcheckPath) ||
        s.healthcheckPath.length > 2000)
    )
      blockers.push("The provider health-check path is invalid.");
    if (
      s.healthcheckTimeout != null &&
      (!Number.isInteger(s.healthcheckTimeout) ||
        s.healthcheckTimeout < 1 ||
        s.healthcheckTimeout > 600)
    )
      blockers.push("The provider health-check timeout must be between 1 and 600 seconds.");
    const ownVolumes = volumes.filter(
      (v) => v.serviceId === s.serviceId && !v.deletedAt && !v.isPendingDeletion,
    );
    const port =
      [...s.domains.customDomains, ...s.domains.serviceDomains].find((d) => d.targetPort)
        ?.targetPort ??
      (Number(env.PORT) ||
        (database === "pg_dump"
          ? 5432
          : database === "mysql_dump"
            ? 3306
            : database === "redis_rdb"
              ? 6379
              : database === "mongo_dump"
                ? 27017
                : undefined));
    if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65535))
      blockers.push(
        "The service port is invalid. Correct its provider configuration before importing.",
      );
    if (
      new Set(
        [...s.domains.customDomains, ...s.domains.serviceDomains]
          .map((d) => d.targetPort)
          .filter(Boolean),
      ).size > 1
    )
      blockers.push(
        "This service exposes multiple ports. Review its public endpoints before importing.",
      );
    if (s.healthcheckPath && !port)
      blockers.push("Set this service's PORT before importing its HTTP health check.");
    return {
      id: s.serviceId,
      instanceId: s.id,
      deploymentIds: active.map((deployment) => deployment.id),
      privateDomain: values.resolved.RAILWAY_PRIVATE_DOMAIN,
      name: s.serviceName,
      kind: database ? "database" : port ? "app" : "worker",
      image,
      database,
      repository,
      branch: fieldString(meta.branch),
      commit,
      rootDirectory: s.rootDirectory?.replace(/^\//, "") || ".",
      dockerfile: s.dockerfilePath ?? undefined,
      buildCommand: s.buildCommand ?? undefined,
      startCommand: s.startCommand ?? undefined,
      readiness: s.healthcheckPath
        ? {
            enabled: true,
            path: s.healthcheckPath,
            port,
            timeoutSeconds: s.healthcheckTimeout ?? 300,
            onFailure: "fail",
          }
        : undefined,
      restart:
        s.restartPolicyType === "NEVER"
          ? "no"
          : s.restartPolicyType === "ON_FAILURE"
            ? `on-failure${s.restartPolicyMaxRetries ? `:${s.restartPolicyMaxRetries}` : ""}`
            : "always",
      port,
      env,
      rawEnv: { ...shared.raw, ...values.raw },
      variables: names
        .filter((key) => !key.startsWith("RAILWAY_"))
        .map((key) => ({ key, required: !Object.hasOwn(env, key) })),
      volumes: ownVolumes.map((v) => ({
        id: v.id,
        mountPath: v.mountPath,
        sizeBytes: v.currentSizeMB == null ? undefined : v.currentSizeMB * 1024 * 1024,
      })),
      domains: [
        ...s.domains.customDomains.map((d) => ({ hostname: d.domain, portable: true })),
        ...s.domains.serviceDomains.map((d) => ({ hostname: d.domain, portable: false })),
      ],
      warnings,
      blockers,
    };
  });
  return {
    provider: "railway" as const,
    source,
    projectName: chosen.name,
    environmentName: selectedEnvironment.name,
    services: result,
    warnings: volumes.some((v) => !v.serviceId && !v.deletedAt)
      ? [
          "Unattached volumes exist in this environment. They are not assigned to an imported service; export them separately.",
        ]
      : [],
  };
}

export const railwayMigrationProvider: MigrationSourceProvider = { projects, discover };
