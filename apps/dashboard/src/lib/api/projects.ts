import { api } from "./client";
import { endpoints } from "./endpoints";

/* ------------------------------------------------------------------ */
/*  Projects API                                                      */
/* ------------------------------------------------------------------ */

export const projectsApi = {
  /** Dashboard overview — projects list + stats numbers */
  getHome: () =>
    api.get<{ success: boolean; projects: any[]; numbers: Record<string, number> }>(
      endpoints.projects.home,
    ),

  /** Create or update a project (mandatory before build access) */
  ensure: (body: {
    name: string;
    slug?: string;
    gitOwner?: string;
    gitRepo?: string;
    gitBranch?: string;
    framework?: string;
    localPath?: string;
    packageManager?: string;
    installCommand?: string;
    buildCommand?: string;
    outputDirectory?: string;
    rootDirectory?: string;
    startCommand?: string;
    buildImage?: string;
    port?: number;
    hasServer?: boolean;
    hasBuild?: boolean;
  }) =>
    api.post<any>(endpoints.projects.ensure, body),

  /** List local projects only */
  getLocal: () =>
    api.get<{ success: boolean; projects: any[] }>(endpoints.projects.local),

  /** Scan a local directory for framework detection */
  scan: (path: string) =>
    api.post<{
      success: boolean;
      name: string;
      path: string;
      stack: string;
      category: string;
      packageManager: string;
      installCommand: string;
      buildCommand: string;
      startCommand: string;
      outputDirectory: string;
    }>(endpoints.projects.scan, { path }),

  /** Import a local folder as a project */
  importLocal: (data: {
    name: string;
    localPath: string;
    framework?: string;
    packageManager?: string;
    buildCommand?: string;
    installCommand?: string;
    outputDirectory?: string;
    port?: number;
  }) =>
    api.post<{ data: any }>(endpoints.projects.import, data),

  /** Delete a local project */
  deleteLocal: (id: string) =>
    api.delete<{ message: string }>(`projects/${id}`),

  /** Single project info */
  getInfo: (id: string | number) => api.get<any>(endpoints.projects.info(id)),

  /** Delete a project */
  delete: (id: string | number) => api.post<any>(endpoints.projects.delete(id)),

  /** Update name or description */
  update: (id: string | number, action: string, value: string) =>
    api.post<any>(endpoints.projects.update(id), { action, value }),

  /** Update build options (single field) */
  setOptions: (id: string | number, options: Record<string, any>) =>
    api.post<any>(endpoints.projects.options(id), options),

  /** Enable or disable a project */
  toggle: (id: string | number, enable: boolean) =>
    api.post<any>(
      endpoints.projects.toggle(id, enable ? "enable" : "disable"),
    ),

  /** Clear CDN / proxy cache */
  clearCache: (id: string | number) =>
    api.post<any>(endpoints.projects.clearCache(id)),

  /** Clear build artifacts */
  clearBuild: (id: string | number) =>
    api.post<any>(endpoints.projects.clearBuild(id)),

  /** Create a new deployment session */
  createDeploymentSession: (id: string | number) =>
    api.post<any>(endpoints.projects.deploymentSession(id)),

  /** Connect a custom domain */
  connectDomain: (
    id: string | number,
    body: { domain: string; includeWww: boolean },
  ) => api.post<any>(endpoints.projects.connect(id), body),

  /** Set environment variables */
  setEnv: (id: string | number, envVars: any) =>
    api.post<any>(endpoints.projects.envSet(id), { envVars }),

  /** Get environment variables */
  getEnv: (id: string | number) => api.get<any>(endpoints.projects.envGet(id)),

  /** Get git settings */
  getGit: (id: string | number) => api.get<any>(endpoints.projects.git(id)),

  /** List branches */
  getBranches: (id: string | number) =>
    api.get<any>(endpoints.projects.branches(id)),

  /** Set active branch */
  setBranch: (id: string | number, branch: string) =>
    api.post<any>(endpoints.projects.branch(id), { branch }),

  /** Toggle git auto-deploy via git/switch */
  gitSwitch: (id: string | number, auto_deploy: boolean) =>
    api.post<any>(endpoints.projects.gitSwitch(id), { auto_deploy }),

  /** Toggle auto-deploy setting */
  setAutoDeploy: (id: string | number, enabled: boolean) =>
    api.post<any>(endpoints.projects.autoDeploy(id), { enabled }),

  /** Set resources (POST — tier-based) */
  setResources: (id: string | number, resources: Record<string, any>) =>
    api.post<any>(endpoints.projects.resources(id), resources),

  /** Update resources (PUT — raw values) */
  updateResources: (id: string | number, resources: Record<string, any>) =>
    api.put<any>(endpoints.projects.resources(id), resources),

  /** Set sleep-mode */
  setSleepMode: (id: string | number, sleep_mode: string) =>
    api.post<any>(endpoints.projects.sleepMode(id), { sleep_mode }),

  /** List deployments for a project */
  getDeployments: (id: string | number) =>
    api.get<any>(endpoints.projects.deployments(id)),
};
