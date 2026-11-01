import type { ProjectRuntimeRoles, RuntimeRoleConfiguration, RuntimeRoleConfigurationInput } from "@repo/contracts";
import { api } from "./client";
import { endpoints } from "./endpoints";

export function loadRuntimeRoles(projectId: string) {
  return api.get<{ data: ProjectRuntimeRoles }>(endpoints.projects.roles(projectId));
}

export function loadRoleConfiguration(projectId: string) {
  return api.get<{ data: RuntimeRoleConfiguration }>(endpoints.projects.roles(projectId) + "/configuration");
}
export function applyRoleConfiguration(projectId: string, input: RuntimeRoleConfigurationInput) {
  return api.post<{ data: { deploymentId: string } }>(endpoints.projects.roles(projectId) + "/configuration", input);
}
