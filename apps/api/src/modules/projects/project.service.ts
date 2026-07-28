/**
 * Project service - barrel re-export.
 *
 * All logic has been split into focused service files:
 *   - project-crud.service.ts      → CRUD, ensure, git, options, deployments
 *   - project-env.service.ts       → environment variables
 *   - project-resources.service.ts → resources, sleep mode
 *   - project-runtime.service.ts   → logs, enable/disable
 *   - project-cleanup.service.ts   → delete orchestrator
 *
 * This barrel preserves the original import surface so that
 * `import * as projectService from "./project.service"` continues to work.
 */

export {
  ensureProject,
  listProjects,
  getProject,
  createProject,
  updateProject,
  linkProjectRepo,
  getGitInfo,
  getProjectCommitStatus,
  setBranch,
  listProjectEnvironments,
  createProjectEnvironment,
  updateOptions,
  listProjectDeployments,
  getLatestDeploymentSession,
  enrichProject,
  enrichProjectsBatch,
} from "./project-crud.service";

export { previewProjectDeletion } from "./project-cleanup.service";
export type { DeletionPreview, DeletionPreviewService } from "./project-cleanup.service";

export { listEnvVars, mergeEnvVars } from "./project-env.service";

export { getResources, updateResources, setSleepMode } from "./project-resources.service";

export {
  getRuntimeLogs,
  streamRuntimeLogs,
  enableProject,
  disableProject,
  retryProjectRouting,
} from "./project-runtime.service";
