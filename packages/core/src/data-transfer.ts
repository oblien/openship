/** Shared controls and review models for control-plane data portability. */
export type ExportHistoryCategory =
  | "analytics"
  | "activity"
  | "backups"
  | "incidents"
  | "migrations";

export interface ExportSelection {
  history: ExportHistoryCategory[];
  /** Missing scope preserves the original whole-instance format. */
  scope?: "instance" | "projects";
  projectIds?: string[];
  includeEnvironments?: boolean;
  includeLinkedProjects?: boolean;
  includeServers?: boolean;
  includeSecrets?: boolean;
  includeDomains?: boolean;
  includeBackups?: boolean;
  includeIntegrations?: boolean;
}

export interface TransferProject {
  id: string;
  groupId: string;
  organizationId: string;
  name: string;
  slug: string;
  environmentName: string;
  serverId: string | null;
  cloudWorkspaceId: string | null;
  localPath: string | null;
}

export interface TransferServer {
  id: string;
  name: string;
  host: string;
  port: number;
  jumpHost?: string | null;
  isLocal: boolean;
  included: boolean;
  hasCredentials: boolean;
}

export interface TransferManifest {
  projects: TransferProject[];
  servers: TransferServer[];
  cloudAccounts: Array<{ organizationId: string; email: string | null }>;
  warnings: string[];
}

export interface ExportPreview {
  core: number;
  history: Record<ExportHistoryCategory, number>;
  total: number;
  /** All available environments, for the bulk picker. */
  projects?: TransferProject[];
  /** The resolved selection, including environments and linked apps. */
  manifest?: TransferManifest;
}

export interface ImportSelection {
  scope: "instance" | "projects";
  projectIds?: string[];
  history?: ExportHistoryCategory[];
  conflictPolicy?: "skip" | "overwrite";
  overwriteDependencies?: boolean;
  projectActions?: Record<string, "skip" | "overwrite">;
  /** Source server id -> destination server id. "local" is the source control-plane host. */
  serverMappings?: Record<string, string>;
  includeSecrets?: boolean;
  includeDomains?: boolean;
  includeBackups?: boolean;
  includeIntegrations?: boolean;
}

export interface ImportPreview {
  scope: "instance" | "projects";
  projects: Array<
    TransferProject & {
      existingProjectId?: string;
      action: "create" | "skip" | "overwrite";
    }
  >;
  servers: Array<
    TransferServer & {
      targetId?: string;
      action: "reuse" | "create" | "map";
    }
  >;
  availableServers: TransferServer[];
  history: Record<ExportHistoryCategory, number>;
  rows: number;
  hasSecrets: boolean;
  warnings: string[];
  blockers: string[];
}
