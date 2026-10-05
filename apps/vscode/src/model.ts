import type { OpenshipClient, Project } from "@repo/sdk/client";

export interface Connection {
  id: string;
  name: string;
  apiUrl: string;
  dashboardUrl: string;
  organizationId?: string;
}

export interface ProjectReference {
  connectionId: string;
  projectId: string;
  organizationId?: string;
}

export interface DeploymentReference extends ProjectReference {
  deploymentId: string;
}

export interface ProjectTarget extends ProjectReference {
  connection: Connection;
  project: Project;
  client: OpenshipClient;
  branch?: string;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isProjectReference(value: unknown): value is ProjectReference {
  return (
    isRecord(value) &&
    typeof value.connectionId === "string" &&
    typeof value.projectId === "string" &&
    value.projectId.length > 0 &&
    (value.organizationId === undefined || typeof value.organizationId === "string")
  );
}

export function isDeploymentReference(value: unknown): value is DeploymentReference {
  return (
    isProjectReference(value) &&
    "deploymentId" in value &&
    typeof value.deploymentId === "string" &&
    value.deploymentId.length > 0
  );
}

export function projectLabel(project: Project): string {
  return [project.name || project.slug, project.environmentName || project.environmentSlug]
    .filter(Boolean)
    .join(" / ");
}
