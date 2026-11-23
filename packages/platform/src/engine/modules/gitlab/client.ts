import { AppError, GITLAB_PROVIDER, type GitRepositoryRef } from "@repo/core";
import type { GitRepositorySummary } from "@repo/contracts";
import { readBoundedResponseText } from "../../lib/bounded-response";

const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;

export interface GitLabProject {
  id: number;
  path: string;
  path_with_namespace: string;
  namespace: { full_path: string };
  description: string | null;
  default_branch: string | null;
  visibility: string;
  web_url: string;
  forks_count: number;
  star_count: number;
  created_at: string;
  last_activity_at: string;
}

export function projectPath(ref: GitRepositoryRef) {
  if (
    ref.provider !== GITLAB_PROVIDER.id ||
    !new RegExp(GITLAB_PROVIDER.namespacePattern).test(ref.namespace) ||
    !/^[\w.-]+$/.test(ref.name) ||
    ref.name === "." ||
    ref.name === ".."
  ) {
    throw new AppError("Invalid GitLab project path", 400, "GIT_REPOSITORY_INVALID");
  }
  return ref.namespace + "/" + ref.name;
}

export function segment(value: string) {
  if (!value || value === "." || value === "..") throw new AppError("Invalid GitLab path", 400);
  return encodeURIComponent(value);
}

export async function gitlabRequest<T>(
  path: string,
  token?: string,
  params: Record<string, string> = {},
  init: RequestInit = {},
): Promise<T> {
  const url = new URL("https://gitlab.com/api/v4/" + path);
  url.search = new URLSearchParams(params).toString();
  const response = await fetch(url, {
    ...init,
    redirect: "error",
    signal: init.signal
      ? AbortSignal.any([init.signal, AbortSignal.timeout(20000)])
      : AbortSignal.timeout(20000),
    headers: {
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...(token ? { Authorization: "Bearer " + token } : {}),
    },
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new AppError(
      "GitLab request failed (HTTP " + response.status + ")",
      response.status,
      "GITLAB_API_ERROR",
    );
  }
  if (response.status === 204) return undefined as T;
  try {
    return JSON.parse(await readBoundedResponseText(response, MAX_RESPONSE_BYTES, "GitLab response")) as T;
  } catch {
    init.signal?.throwIfAborted();
    throw new AppError(
      "GitLab returned an invalid or oversized response.",
      502,
      "GITLAB_RESPONSE_INVALID",
    );
  }
}

export function isGitLabStatus(error: unknown, ...statuses: number[]) {
  return error instanceof AppError && statuses.includes(error.statusCode);
}

export function isGitLabCredentialError(error: unknown): error is AppError {
  return (
    error instanceof AppError &&
    (isGitLabStatus(error, 401, 403) ||
      error.code === "CONNECTION_RECONNECT_REQUIRED" ||
      error.code === "GITLAB_CLI_UNAVAILABLE")
  );
}

export async function allPages<T>(read: (page: string) => Promise<T[]>): Promise<T[]> {
  const result: T[] = [];
  for (let page = 1; page <= 100; page++) {
    const rows = await read(String(page));
    result.push(...rows);
    if (rows.length < 100) return result;
  }
  throw new AppError(
    "GitLab listing exceeded 10,000 entries. Narrow the repository or group.",
    422,
  );
}

export function verifyGitLabToken(token: string) {
  return gitlabRequest("projects", token, { membership: "true", per_page: "1" });
}

export async function gitlabCredentials(org: string, allowHostCli = true) {
  const { listProviderCredentials } = await import("../credentials/credential.service");
  const credentials = await listProviderCredentials(org, GITLAB_PROVIDER.id);
  const tokens: { token: string; source: "cli" | "token" }[] = [];
  let failure: unknown;
  for (const row of credentials) {
    try {
      if (row.publicFields.authorization === "host-cli") {
        if (!allowHostCli) continue;
        const { resolveGlabToken } = await import("./cli");
        tokens.push({ token: await resolveGlabToken(row.secrets.glabUserId), source: "cli" });
      } else if (row.publicFields.authorization === "oauth") {
        const { getConnectionAccess } = await import("../credentials/connection-authorization");
        const { secrets } = await getConnectionAccess(
          org,
          row.id,
          (id): id is "gitlab" => id === "gitlab",
        );
        tokens.push({ token: secrets.apiToken, source: "token" });
      } else if (row.secrets.apiToken) {
        tokens.push({ token: row.secrets.apiToken, source: "token" });
      }
    } catch (error) {
      // diagnostics-ignore: try the other saved accounts, then propagate the failure if none is usable.
      if (!failure || isGitLabCredentialError(failure)) failure = error;
    }
  }
  if (!tokens.length && failure) throw failure;
  return tokens;
}

export async function projectConnection(org: string, ref: GitRepositoryRef, allowHostCli = true) {
  const path = "projects/" + segment(projectPath(ref));
  for (const { token } of await gitlabCredentials(org, allowHostCli)) {
    try {
      return { token, project: await gitlabRequest<GitLabProject>(path, token) };
    } catch (error) {
      if (!isGitLabStatus(error, 401, 403, 404)) throw error;
    }
  }
  return { token: undefined, project: await gitlabRequest<GitLabProject>(path) };
}

export function summary(project: GitLabProject, source: "cli" | "token"): GitRepositorySummary {
  return {
    full_name: project.path_with_namespace,
    name: project.path,
    owner: project.namespace.full_path,
    description: project.description,
    html_url: project.web_url,
    private: project.visibility !== "public",
    visibility: project.visibility,
    default_branch: project.default_branch ?? "",
    language: null,
    size: 0,
    watchers: 0,
    stars: project.star_count,
    forks: project.forks_count,
    license: null,
    created_at: project.created_at,
    updated_at: project.last_activity_at,
    pushed_at: project.last_activity_at,
    source,
  };
}
