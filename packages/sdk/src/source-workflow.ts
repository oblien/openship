import { parseInput, EnsureProjectBody, BuildAccessBody, type ProjectOperations, type SourceOperations, type DeploymentOperations } from "@repo/contracts";
import type { DeploySourceInput, SourceDeploymentResult } from "./source-input";

/** Identical orchestration for native and remote sources; transports only stage the bytes. */
export async function deploySourceWorkflow(ship: { projects: ProjectOperations; sources: SourceOperations; deployments: DeploymentOperations }, input: DeploySourceInput): Promise<SourceDeploymentResult> {
  const { source, signal, onStep } = input;
  const step = (message: string) => { signal?.throwIfAborted(); onStep?.(message); };
  step("Preparing source");
  const session = await ship.sources.stage({ source, name: input.name, projectId: input.projectId }, { signal, onStep });
  step("Detecting build config");
  const scan = await ship.sources.scan(session.sessionId);
  const services = scan.services?.map(service => ({ ...service, commandArgv: service.commandArgv ?? undefined }));
  step("Creating project");
  const hasBuild = Boolean(scan.buildCommand), hasServer = scan.workloadType !== "worker" && Boolean(scan.startCommand);
  const ensured = await ship.projects.ensure(parseInput(EnsureProjectBody, {
    name: scan.name || input.name || "app", projectId: input.projectId, serverId: input.serverId,
    deploymentEnvironment: input.environment,
    gitProvider: "upload", uploadSessionId: session.sessionId,
    framework: scan.stack, projectType: scan.projectType, packageManager: scan.packageManager,
    installCommand: scan.installCommand, buildCommand: scan.buildCommand, startCommand: scan.startCommand || undefined,
    outputDirectory: scan.outputDirectory, rootDirectory: scan.rootDirectory, buildImage: scan.buildImage,
    productionPaths: Array.isArray(scan.productionPaths) ? scan.productionPaths.join(",") : undefined,
    hasBuild, hasServer, productionMode: scan.productionMode ?? (hasServer ? "standalone" : "static"),
    workloadType: scan.workloadType, runtimeMode: scan.runtimeMode,
    ...(hasServer && scan.port ? { port: scan.port } : {}),
    ...(services?.length ? { services } : {}),
    monorepoApps: scan.monorepoApps, monorepoWorkspace: scan.monorepoWorkspace,
    composePath: scan.composePath, volumes: scan.volumes, routingConfig: scan.routing,
  }));
  step("Deploying");
  const deployment = await ship.deployments.buildAccess(parseInput(BuildAccessBody, {
    projectId: ensured.project_id, uploadSessionId: session.sessionId,
    ...(input.serverId ? { deployTarget: "server", serverId: input.serverId } : {}),
    environment: input.environment,
    ...(services?.length ? { services } : {}),
    ...(input.serviceIds?.length ? { serviceIds: input.serviceIds } : {}),
  }));
  return { deployment_id: deployment.deployment_id, project_id: deployment.project_id,
    ...(scan.configDiagnostics && { configDiagnostics: scan.configDiagnostics }) };
}
