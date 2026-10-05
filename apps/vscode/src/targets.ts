import { iteratePages, type Project } from "@repo/sdk/client";
import type { Connections } from "./connections";
import type { DeploymentReference, ProjectReference, ProjectTarget } from "./model";

export async function listProjects(
  connections: Connections,
  connectionId: string,
): Promise<Project[]> {
  const client = connections.client(connectionId);
  const projects: Project[] = [];
  for await (const project of iteratePages((input) => client.projects.list(input), {
    perPage: 100,
  }))
    projects.push(project);
  return projects;
}

export async function resolveProject(
  connections: Connections,
  ref: ProjectReference,
): Promise<ProjectTarget> {
  ref = {
    connectionId: ref.connectionId,
    projectId: ref.projectId,
    organizationId: ref.organizationId,
  };
  const connection = connections.get(ref.connectionId);
  const project = await connections
    .client(ref.connectionId, ref.organizationId)
    .projects.get(ref.projectId);
  if (
    project.id !== ref.projectId ||
    (ref.organizationId && ref.organizationId !== project.organizationId)
  ) {
    throw new Error(
      "The linked project's identity changed. Link the workspace again before continuing.",
    );
  }
  return {
    ...ref,
    organizationId: project.organizationId,
    connection,
    project,
    client: connections.client(ref.connectionId, project.organizationId),
  };
}

export async function resolveDeployment(connections: Connections, ref: DeploymentReference) {
  ref = {
    connectionId: ref.connectionId,
    projectId: ref.projectId,
    organizationId: ref.organizationId,
    deploymentId: ref.deploymentId,
  };
  const target = await resolveProject(connections, ref);
  const deployment = await target.client.deployments.get(ref.deploymentId);
  if (
    deployment.id !== ref.deploymentId ||
    deployment.projectId !== target.project.id ||
    deployment.organizationId !== target.project.organizationId
  ) {
    throw new Error("The selected deployment does not belong to this project and organization.");
  }
  return { ...target, deployment, deploymentId: deployment.id };
}

export function assertGitProject(project: Project): void {
  if (!["github", "gitlab", "bitbucket"].includes(project.gitProvider ?? "") || !project.gitRepo) {
    throw new Error(
      "Deploy Git Branch requires a project connected to a Git repository. Configure its source in the Openship dashboard.",
    );
  }
}
