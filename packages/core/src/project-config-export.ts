import type { Edition } from "./edition";
import type { ReleaseSource } from "./project-source";

/** Non-secret instance config snapshot for Operator backup / later recipe waves. */
export const PROJECT_CONFIG_EXPORT_VERSION = 1 as const;

export type ExportedMountedRelease = {
  enabled: boolean;
  buildMode?: "prebuilt" | "server";
  serviceName?: string;
  sourcePath?: string;
  containerPath: string;
  sharedPaths?: string[];
  prepareCommand?: string;
  builderImage?: string;
  builderMemoryMb?: number;
  builderCpus?: number;
  builderCachePaths?: string[];
  reloadCommand?: string;
  healthPath?: string;
  healthPort?: number;
  retain?: number;
};

export type ExportedServer = {
  id: string;
  name: string | null;
  isLocal: boolean;
  sshHost: string;
  sshPort: number | null;
  sshUser: string | null;
  sshAuthMethod: string | null;
};

export type ExportedRoute = {
  id: string;
  hostname: string;
  domainType: string | null;
  isPrimary: boolean;
  targetPort: number | null;
  targetPath: string | null;
  serviceId: string | null;
  redirectTo: string | null;
  redirectStatus: number | null;
};

export type ExportedConnection = {
  id: string;
  sourceProjectId: string;
  targetProjectId: string;
  outputId: string;
  envKey: string;
  mode: string;
};

export type ExportedProject = {
  id: string;
  name: string;
  slug: string;
  environmentName: string;
  environmentSlug: string;
  environmentType: string;
  isApp: boolean;
  appTemplateId: string | null;
  gitProvider: string | null;
  gitOwner: string | null;
  gitRepo: string | null;
  gitBranch: string | null;
  gitUrl: string | null;
  localPath: string | null;
  framework: string | null;
  packageManager: string | null;
  installCommand: string | null;
  buildCommand: string | null;
  outputDirectory: string | null;
  productionPaths: string | null;
  rootDirectory: string | null;
  composePath: string | null;
  startCommand: string | null;
  buildImage: string | null;
  productionMode: string | null;
  port: number | null;
  serverId: string | null;
  internalAlias: string | null;
  autoDeploy: boolean;
  mountedRelease: ExportedMountedRelease | null;
  releaseSource: ReleaseSource | null;
  routes: ExportedRoute[];
  connections: ExportedConnection[];
};

export type ProjectConfigExport = {
  version: typeof PROJECT_CONFIG_EXPORT_VERSION;
  edition: Edition;
  exportedAt: string;
  organizationId: string;
  servers: ExportedServer[];
  projects: ExportedProject[];
};
