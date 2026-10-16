import { repos } from "@repo/db";
import {
  AppError,
  NotFoundError,
  ValidationError,
  isExternalProject,
  isValidExternalMatcher,
  matchesExternalContainer,
  type ExternalProjectConfig,
} from "@repo/core";
import {
  EDGE_CONTAINER_NAME,
  MAIL_CONTAINER,
  MAIL_DB_CONTAINER,
  OPENSHIP_LABEL,
  type LogEntry,
} from "@repo/adapters";
import type { TCreateExternalProjectBody } from "@repo/contracts";
import { createServerDockerRuntime, disposeRuntime } from "../../lib/deployment-runtime";
import { assertResourceInOrg } from "../../lib/resource-access";
import { streamLogsOwningRuntime } from "../../lib/runtime-log-stream";
import { assertDeploymentServer } from "../system/server-access";
import { findOwnStack } from "../../lib/startup/self-services";
import { env } from "../../config/env";
import type { createProject } from "./project-crud.service";

type ProjectRow = NonNullable<Awaited<ReturnType<typeof repos.project.findById>>>;
type DockerRuntime = Awaited<ReturnType<typeof createServerDockerRuntime>>;

export interface ExternalContainer {
  id: string;
  name: string;
  image: string;
  state: string;
  status: string;
  labels: Record<string, string>;
}

export async function validateExternalProjectInput(
  organizationId: string,
  input: Pick<TCreateExternalProjectBody, "serverId" | "matchers">,
): Promise<ExternalProjectConfig> {
  if (env.CLOUD_MODE) {
    throw new AppError(
      "External projects are available on self-hosted Openship only.",
      400,
      "EXTERNAL_PROJECT_UNSUPPORTED",
    );
  }
  const server = await repos.server.getInOrganization(input.serverId, organizationId);
  if (!server) throw new NotFoundError("Server", input.serverId);
  assertDeploymentServer(server);
  if (server.workspaceId) {
    throw new ValidationError(
      "Choose one of your own servers. Managed Cloud servers cannot host external projects.",
    );
  }
  if (input.matchers.length === 0 || !input.matchers.every(isValidExternalMatcher)) {
    throw new ValidationError(
      "Each container matcher needs a container name or at least one label.",
    );
  }
  return { serverId: server.id, matchers: input.matchers };
}

function externalConfigOf(project: ProjectRow): ExternalProjectConfig {
  const config = project.externalConfig;
  if (!config?.serverId || config.serverId !== project.serverId) {
    throw new AppError(
      "This external project has no consistent server configured.",
      409,
      "EXTERNAL_PROJECT_UNCONFIGURED",
    );
  }
  return config;
}

async function loadExternalProject(projectId: string, organizationId: string) {
  const project = await repos.project.findById(projectId);
  assertResourceInOrg(project, "Project", organizationId, projectId);
  if (!isExternalProject(project)) {
    throw new ValidationError("This project is not an external project.");
  }
  return { project, config: externalConfigOf(project) };
}

async function matchedContainers(runtime: DockerRuntime, config: ExternalProjectConfig) {
  const all = await runtime.listAllContainers();
  const ownStack = new Set(findOwnStack(all).map((c) => c.id));
  // Openship's own infra containers carry no project label, so they are denied by name.
  const infraNames = new Set([EDGE_CONTAINER_NAME, MAIL_CONTAINER, MAIL_DB_CONTAINER]);
  const candidates = all.filter(
    (c) =>
      !ownStack.has(c.id) &&
      !c.labels?.[OPENSHIP_LABEL.project] &&
      !c.names.some((name) => infraNames.has(name)) &&
      matchesExternalContainer(config.matchers, c),
  );
  const managed = new Set(
    (await repos.service.findByContainerIds(candidates.map((c) => c.id))).map(
      (row) => row.containerId,
    ),
  );
  const labelKeys = new Set(config.matchers.flatMap((m) => Object.keys(m.labels ?? {})));
  return candidates
    .filter((c) => !managed.has(c.id))
    .map<ExternalContainer>((c) => ({
      id: c.id,
      name: c.names[0] ?? c.id,
      image: c.image,
      state: c.state,
      status: c.status,
      // Only the labels the operator matched on; the rest can carry secrets.
      labels: Object.fromEntries(
        Object.entries(c.labels ?? {}).filter(([key]) => labelKeys.has(key)),
      ),
    }));
}

/** Running containers first, then by name, so the plain logs endpoint is deterministic. */
export function pickExternalLogContainer(
  containers: ExternalContainer[],
): ExternalContainer | null {
  const sorted = [...containers].sort(
    (a, b) =>
      Number(b.state === "running") - Number(a.state === "running") || a.name.localeCompare(b.name),
  );
  return sorted[0] ?? null;
}

export async function listExternalContainers(
  projectId: string,
  organizationId: string,
): Promise<ExternalContainer[]> {
  const { config } = await loadExternalProject(projectId, organizationId);
  const runtime = await createServerDockerRuntime(config.serverId, organizationId);
  try {
    return await matchedContainers(runtime, config);
  } finally {
    disposeRuntime(runtime);
  }
}

async function openExternalLogTarget(project: ProjectRow, organizationId: string) {
  const config = externalConfigOf(project);
  const runtime = await createServerDockerRuntime(config.serverId, organizationId);
  try {
    const container = pickExternalLogContainer(await matchedContainers(runtime, config));
    if (!container) throw new NotFoundError("No matching container for project", project.id);
    return { runtime, container, serverId: config.serverId };
  } catch (error) {
    disposeRuntime(runtime);
    throw error;
  }
}

export async function getExternalRuntimeLogs(
  project: ProjectRow,
  organizationId: string,
  tail?: number,
): Promise<LogEntry[]> {
  const { runtime, container } = await openExternalLogTarget(project, organizationId);
  try {
    return await runtime.getRuntimeLogs(container.id, tail);
  } finally {
    disposeRuntime(runtime);
  }
}

export async function streamExternalRuntimeLogs(
  project: ProjectRow,
  organizationId: string,
  onLog: (entry: LogEntry) => void,
  opts?: { tail?: number },
) {
  const { runtime, container, serverId } = await openExternalLogTarget(project, organizationId);
  return streamLogsOwningRuntime(runtime, container.id, onLog, opts, serverId);
}

export async function createExternalProject(
  input: TCreateExternalProjectBody,
  organizationId: string,
  access?: { tokenId: string },
  ctx?: Parameters<typeof createProject>[3],
) {
  const externalConfig = await validateExternalProjectInput(organizationId, input);
  const { createProject } = await import("./project-crud.service");
  return createProject(
    {
      name: input.name,
      serverId: externalConfig.serverId,
      gitProvider: "external",
      hasBuild: false,
      publicEndpoints: [],
    },
    organizationId,
    access,
    ctx,
    { externalConfig, runtimeMode: "docker", autoDeploy: false },
  );
}
