/** The project and organization must both match before using a deployment. */
export function deploymentBelongsToProject(
  project: { id: string; organizationId: string },
  deployment: { projectId: string; organizationId: string } | null | undefined,
): boolean {
  return Boolean(
    project.id &&
    project.organizationId &&
    deployment &&
    deployment.projectId === project.id &&
    deployment.organizationId === project.organizationId,
  );
}
