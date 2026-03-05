/**
 * Project service — CRUD operations for user projects.
 */

export async function listProjects(userId: string) {
  // TODO: Query DB for user's projects
}

export async function createProject(userId: string, data: { name: string; repo?: string }) {
  // TODO: Insert project, set up initial config
}

export async function getProject(projectId: string) {
  // TODO: Fetch single project
}

export async function updateProject(projectId: string, data: Partial<{ name: string }>) {
  // TODO: Update project fields
}

export async function deleteProject(projectId: string) {
  // TODO: Soft-delete project and associated deployments
}
