/**
 * GitLab types — shared interfaces for the GitLab module.
 */

export interface GitLabUser {
  id: number;
  username: string;
  name: string;
  avatar_url: string;
  web_url: string;
}

export interface GitLabNamespace {
  id: number;
  name: string;
  path: string;
  kind: "user" | "group";
  full_path: string;
  avatar_url: string | null;
}

export interface GitLabProject {
  id: number;
  name: string;
  path: string;
  path_with_namespace: string;
  default_branch: string | null;
  http_url_to_repo: string;
  ssh_url_to_repo: string;
  web_url: string;
  visibility: string;
  description: string | null;
  namespace: {
    id: number;
    name: string;
    path: string;
    kind: string;
    full_path: string;
    avatar_url: string | null;
  };
  last_activity_at: string;
}

export interface GitLabBranch {
  name: string;
  default: boolean;
  protected: boolean;
  commit: { id: string; short_id: string; title: string };
}

export interface GitLabHook {
  id: number;
  url: string;
  push_events: boolean;
  enable_ssl_verification: boolean;
  token?: string;
}

export interface MappedGitLabProject {
  id: number;
  name: string;
  /** Namespace path (may include subgroups), stored as gitOwner. */
  owner: string;
  /** Project path segment, stored as gitRepo. */
  repo: string;
  fullName: string;
  private: boolean;
  defaultBranch: string;
  htmlUrl: string;
  cloneUrl: string;
  sshUrl: string;
  description: string | null;
  updatedAt: string;
}

export interface MappedGitLabAccount {
  id: number;
  login: string;
  name: string;
  avatarUrl: string | null;
  kind: "user" | "group";
  fullPath: string;
}

export interface GitLabConnectionState {
  connected: boolean;
  mode: "oauth" | "pat" | null;
  login: string | null;
  avatarUrl: string | null;
  baseUrl: string;
  oauthConfigured: boolean;
}

/** Push Hook payload (subset used for auto-deploy). */
export interface GitLabPushPayload {
  object_kind?: string;
  event_name?: string;
  ref?: string;
  checkout_sha?: string | null;
  before?: string;
  after?: string;
  user_username?: string;
  user_name?: string;
  project?: {
    id?: number;
    name?: string;
    path_with_namespace?: string;
    http_url?: string;
    default_branch?: string;
  };
  repository?: {
    name?: string;
    url?: string;
    homepage?: string;
  };
  commits?: Array<{ id?: string; message?: string; title?: string }>;
}
