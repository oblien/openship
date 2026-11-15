import {
  parseInput,
  EnsureProjectBody,
  BuildAccessBody,
  type ProjectOperations,
  type SourceOperations,
  type DeploymentOperations,
  type SourceScan,
} from "@repo/contracts";
import type { DeploySourceInput, SourceDeploymentResult } from "./source-input";
import { runtimeNeedsInstall } from "@repo/core";

/**
 * Scan endpoints → BuildAccessBody.publicEndpoints. The scan shape reuses
 * EnsureProjectBody's endpoint (numeric `port`), while the deploy request's
 * PublicEndpointInput takes the port as a STRING (the wizard stringifies its
 * ports too) — parseInput is strict Value.Check, so the pass-through must
 * convert or the deploy 400s.
 */
function buildAccessEndpoint(endpoint: NonNullable<SourceScan["publicEndpoints"]>[number]) {
  return {
    ...(endpoint.port !== undefined ? { port: String(endpoint.port) } : {}),
    ...(endpoint.targetPath !== undefined ? { targetPath: endpoint.targetPath } : {}),
    ...(endpoint.domain !== undefined ? { domain: endpoint.domain } : {}),
    ...(endpoint.customDomain !== undefined ? { customDomain: endpoint.customDomain } : {}),
    ...(endpoint.domainType !== undefined ? { domainType: endpoint.domainType } : {}),
    ...(endpoint.redirectTo !== undefined ? { redirectTo: endpoint.redirectTo } : {}),
    ...(endpoint.redirectStatus !== undefined ? { redirectStatus: endpoint.redirectStatus } : {}),
  };
}

/**
 * Scan service rows differ from the two destinations by ONE field: the
 * endpoint `port` type. EnsureProjectBody's services use the numeric
 * PublicEndpointSchema, BuildAccessBody's use the string PublicEndpointInput
 * (and the scan's own declared shape is the string one). A verbatim
 * pass-through can only satisfy one of the two, so retype it per destination.
 */
function serviceForDestination(service: Record<string, unknown>, portAs: "number" | "string") {
  const endpoints = service.publicEndpoints as Array<Record<string, unknown>> | undefined;
  if (!endpoints?.length) return service;
  return {
    ...service,
    publicEndpoints: endpoints.map((endpoint) =>
      endpoint.port === undefined
        ? endpoint
        : { ...endpoint, port: portAs === "number" ? Number(endpoint.port) : String(endpoint.port) },
    ),
  };
}

/** Identical orchestration for native and remote sources; transports only stage the bytes. */
export async function deploySourceWorkflow(ship: { projects: ProjectOperations; sources: SourceOperations; deployments: DeploymentOperations }, input: DeploySourceInput): Promise<SourceDeploymentResult> {
  const { source, signal, onStep } = input;
  const step = (message: string) => { signal?.throwIfAborted(); onStep?.(message); };
  step("Preparing source");
  const session = await ship.sources.stage({ source, name: input.name, projectId: input.projectId, serverId: input.serverId }, { signal, onStep });
  step("Detecting build config");
  const scan = await ship.sources.scan(session.sessionId);
  const serverId = scan.serverId ?? session.serverId ?? input.serverId;
  const services = scan.services?.map(service => ({ ...service, commandArgv: service.commandArgv ?? undefined }));
  // Declared domains (openship.json `domains[]`, normalized by the scan) must
  // reach BOTH the project record and the deploy request. Without them a
  // self-hosted server deploy fails the Cloud preflight
  // (hasManagedProjectDomain → "Connect Openship Cloud to use a free
  // subdomain") — the dashboard wizard sends these, the SDK didn't.
  const publicEndpoints = scan.publicEndpoints;
  step("Creating project");
  const hasBuild = Boolean(scan.buildCommand) || runtimeNeedsInstall(scan.stack, scan.runtimeVersion, scan.installCommand), hasServer = scan.workloadType !== "worker" && Boolean(scan.startCommand);
  // A SINGLE-APP deploy whose scan reports a container port is a web workload.
  // The scan's startCommand is empty when the repository Dockerfile owns the
  // process, so the legacy derivation above yields hasServer=false → the API
  // resolves workloadType=static/productionMode=static, and the deploy
  // preflight rejects the port-targeted route ("Static deployments cannot
  // expose port-targeted routes"). Derive web like the dashboard wizard does;
  // an explicitly declared workload (openship.json `workload: worker|static`)
  // stays authoritative, and multi-service (compose) deploys are untouched —
  // their project row is legitimately static with per-service endpoints.
  const webSingleApp = !services?.length
    && typeof scan.port === "number" && scan.port > 0
    && scan.workloadType !== "worker" && scan.workloadType !== "static";
  // A repository Dockerfile owns install + build: hasBuild derives false from
  // the empty scan commands, but there IS a build (the image build itself).
  const repoDockerfileBuild = scan.projectType === "docker" || scan.stack === "docker";
  const ensured = await ship.projects.ensure(parseInput(EnsureProjectBody, {
    name: input.name || scan.name || "app", projectId: input.projectId, serverId,
    deploymentEnvironment: input.environment,
    gitProvider: "upload", uploadSessionId: session.sessionId,
    framework: scan.stack, projectType: scan.projectType, packageManager: scan.packageManager,
    installCommand: scan.installCommand, buildCommand: scan.buildCommand, startCommand: scan.startCommand || undefined,
    releaseCommands: scan.releaseCommands,
    roles: scan.roles,
    outputDirectory: scan.outputDirectory, rootDirectory: scan.rootDirectory, buildImage: scan.buildImage, runtimeVersion: scan.runtimeVersion, runtimeImage: scan.runtimeImage,
    productionPaths: Array.isArray(scan.productionPaths) ? scan.productionPaths.join(",") : undefined,
    hasBuild: webSingleApp && repoDockerfileBuild ? true : hasBuild,
    hasServer: webSingleApp || hasServer,
    productionMode: scan.productionMode ?? (webSingleApp ? "host" : hasServer ? "standalone" : "static"),
    workloadType: webSingleApp ? "web" : scan.workloadType, runtimeMode: scan.runtimeMode,
    ...((webSingleApp || hasServer) && scan.port ? { port: scan.port } : {}),
    ...(services?.length ? { services: services.map((s) => serviceForDestination(s, "number")) } : {}),
    ...(publicEndpoints?.length ? { publicEndpoints } : {}),
    monorepoApps: scan.monorepoApps, monorepoWorkspace: scan.monorepoWorkspace,
    composePath: scan.composePath, volumes: scan.volumes, routingConfig: scan.routing,
  }));
  step("Deploying");
  const deployment = await ship.deployments.buildAccess(parseInput(BuildAccessBody, {
    projectId: ensured.project_id, uploadSessionId: session.sessionId,
    ...(serverId ? { serverId } : {}),
    environment: input.environment,
    ...(services?.length ? { services: services.map((s) => serviceForDestination(s, "string")) } : {}),
    ...(publicEndpoints?.length ? { publicEndpoints: publicEndpoints.map(buildAccessEndpoint) } : {}),
    ...(input.serviceIds?.length ? { serviceIds: input.serviceIds } : {}),
  }));
  return { deployment_id: deployment.deployment_id, project_id: deployment.project_id,
    ...(scan.configDiagnostics && { configDiagnostics: scan.configDiagnostics }) };
}
