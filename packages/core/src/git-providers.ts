/** Public provider metadata shared by the picker, admission and adapter registry.
 * Capabilities describe implemented features; connection permissions are checked separately.
 */
export interface GitProviderDefinition {
  id: string;
  name: string;
  icon: string;
  webBaseUrl: string;
  commitPath: string;
  commitsPath: string;
  /** Namespace grammar for public repository links (Enterprise hosts use configured connections). */
  namespacePattern: string;
  namespaceLabel: string;
  avatarUrl?: (namespace: string, size: number) => string;
  grantTypes: { root: string; namespace: string; repository: string };
  /** Optional unauthenticated, fixed-origin raw file endpoint for deploy-link branding. */
  publicFiles?: { baseUrl: string; defaultRef: string };
  capabilities: {
    webhooks: boolean;
    checks: boolean;
    pullRequests: boolean;
    sourceChanges: boolean;
    workflows: boolean;
  };
}

/** A namespace is a full path, not necessarily a single account name. */
export interface GitRepositoryRef {
  provider: string;
  namespace: string;
  name: string;
}

export const GITHUB_PROVIDER = {
  id: "github",
  name: "GitHub",
  icon: "github",
  webBaseUrl: "https://github.com",
  commitPath: "commit",
  commitsPath: "commits",
  namespaceLabel: "org",
  avatarUrl: (namespace: string, size: number) =>
    `https://github.com/${encodeURIComponent(namespace)}.png?size=${size}`,
  namespacePattern: "^[a-zA-Z0-9-]+$",
  grantTypes: {
    root: "github",
    namespace: "github_installation",
    repository: "github_repository",
  },
  publicFiles: { baseUrl: "https://raw.githubusercontent.com", defaultRef: "HEAD" },
  capabilities: {
    webhooks: true,
    checks: true,
    pullRequests: true,
    sourceChanges: true,
    workflows: true,
  },
} as const satisfies GitProviderDefinition;

export const GITLAB_PROVIDER = {
  id: "gitlab",
  name: "GitLab",
  icon: "gitlab",
  webBaseUrl: "https://gitlab.com",
  commitPath: "-/commit",
  commitsPath: "-/commits",
  namespaceLabel: "group",
  namespacePattern: "^[A-Za-z0-9_][A-Za-z0-9_.-]*(?:/[A-Za-z0-9_][A-Za-z0-9_.-]*)*$",
  grantTypes: { root: "gitlab", namespace: "gitlab_namespace", repository: "gitlab_repository" },
  capabilities: { webhooks: true, checks: false, pullRequests: false, sourceChanges: false, workflows: false },
} as const satisfies GitProviderDefinition;

export const DEFAULT_GIT_PROVIDER: string = GITHUB_PROVIDER.id;
export const GIT_PROVIDERS = Object.freeze([GITHUB_PROVIDER, GITLAB_PROVIDER] as const);

/** The original Git settings URL opens the default provider. */
export function gitProviderSettingsHref(provider: string) {
  return provider === DEFAULT_GIT_PROVIDER ? "/settings?tab=git" : `/settings?tab=git&provider=${encodeURIComponent(provider)}`;
}

export type RegisteredGitProvider = (typeof GIT_PROVIDERS)[number];

export function gitProviderForRoot(type: string) {
  return GIT_PROVIDERS.find(({ grantTypes }) => grantTypes.root === type);
}

/** Only namespace and repository grants can be issued to a scoped principal. */
export function gitProviderForGrant(resourceType: string) {
  return GIT_PROVIDERS.find(
    ({ grantTypes }) =>
      grantTypes.namespace === resourceType || grantTypes.repository === resourceType,
  );
}

export function gitGrantTarget(
  provider: Pick<GitProviderDefinition, "grantTypes">,
  resourceType: string,
  resourceId: string,
) {
  const slash = resourceId.lastIndexOf("/");
  return resourceType === provider.grantTypes.repository && slash >= 0
    ? { owner: resourceId.slice(0, slash), repo: resourceId.slice(slash + 1) }
    : { owner: resourceId, repo: null };
}

export function gitProviderDefinition(
  id: string | null | undefined,
): GitProviderDefinition | undefined {
  return GIT_PROVIDERS.find((provider) => provider.id === (id ?? DEFAULT_GIT_PROVIDER));
}

/** Default origin only; configured enterprise origins are resolved by the adapter. */
export function gitRepositoryUrl(
  provider: string | null | undefined,
  owner?: string | null,
  repo?: string | null,
): string | undefined {
  const definition = gitProviderDefinition(provider);
  if (!definition || !owner || !repo) return undefined;
  return `${definition.webBaseUrl}/${owner.split("/").map(encodeURIComponent).join("/")}/${encodeURIComponent(repo)}.git`;
}

/** Public UI links use provider metadata; unknown providers never link to GitHub. */
export function gitRepositoryLink(
  provider: string | null | undefined,
  owner?: string | null,
  repo?: string | null,
  revision?: string | null,
): string | undefined {
  const definition = gitProviderDefinition(provider);
  const cloneUrl = gitRepositoryUrl(provider, owner, repo);
  if (!definition || !cloneUrl) return undefined;
  const url = cloneUrl.slice(0, -4);
  return revision ? `${url}/${definition.commitPath}/${encodeURIComponent(revision)}` : url;
}

export interface GitRepositoryLocation {
  provider: string;
  owner: string;
  repo: string;
  url: string;
}

/** Known provider origins only. Never turn a source link into an arbitrary fetch URL. */
export function parseGitRepositoryUrl(value: string): GitRepositoryLocation | null {
  if (value.length > 2000) return null;
  try {
    const url = new URL(value.trim().replace(/^git@([^/:]+):/, "https://$1/"));
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.port ||
      url.search ||
      url.hash
    )
      return null;
    const provider = GIT_PROVIDERS.find(
      (item) => new URL(item.webBaseUrl).hostname === url.hostname.replace(/^www\./, ""),
    );
    if (!provider) return null;
    const parts = url.pathname.replace(/\/+$/, "").slice(1).split("/");
    const repo = parts.pop()?.replace(/\.git$/, ""),
      owner = parts.join("/");
    if (
      !repo ||
      repo === "." ||
      repo === ".." ||
      !/^[a-zA-Z0-9_.-]+$/.test(repo) ||
      !new RegExp(provider.namespacePattern).test(owner) ||
      parts.some((part) => !part || part === "." || part === "..")
    )
      return null;
    return { provider: provider.id, owner, repo, url: `${provider.webBaseUrl}/${owner}/${repo}` };
  } catch {
    // diagnostics-ignore: malformed external repository input is expected.
    return null;
  }
}

export function parseGitRepositoryReference(
  value: string,
  provider = DEFAULT_GIT_PROVIDER,
): GitRepositoryLocation | null {
  const definition = gitProviderDefinition(provider);
  if (!definition) return null;
  const input = value.trim();
  const parsed = parseGitRepositoryUrl(input.includes(":") ? input : `${definition.webBaseUrl}/${input}`);
  return parsed?.provider === definition.id ? parsed : null;
}
