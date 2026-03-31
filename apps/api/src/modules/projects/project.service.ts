/**
 * Project service — barrel re-export.
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
  getGitInfo,
  setBranch,
  updateOptions,
  listProjectDeployments,
  getLatestDeploymentSession,
  enrichProject,
} from "./project-crud.service";

export { deleteProject } from "./project-cleanup.service";

export { listEnvVars, setEnvVars } from "./project-env.service";

export { getResources, updateResources, setSleepMode } from "./project-resources.service";

export {
  getRuntimeLogs,
  streamRuntimeLogs,
  enableProject,
  disableProject,
} from "./project-runtime.service";
