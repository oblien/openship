import { DEFAULT_GIT_PROVIDER, GITHUB_PROVIDER, parseGitRepositoryUrl, gitProviderDefinition } from "./git-providers";
/** Public deployment links contain a source reference, never credentials or executable config. */
export type DeploySource =
  | { kind: "app"; appId: string }
  | { kind: "repo"; provider?: string; url: string; owner: string; repo: string; branch?: string };

export type DeployDestination = "cloud" | "server";

function parseRepository(repo: string) {
  const parsed = parseGitRepositoryUrl(repo);
  if (!parsed) throw new Error("Use the repository URL, without credentials, query parameters or a file path.");
  const { provider, ...source } = parsed;
  return { ...source, ...(provider !== GITHUB_PROVIDER.id ? { provider } : {}) };
}

/** Decode only canonical owner/repo slugs, never the dashboard's local/project payloads. */
function decodeRepositorySlug(slug: string) {
  if (!/^[A-Za-z0-9_-]{1,400}$/.test(slug)) return null;
  try {
    const decoded = atob(slug.replace(/-/g, "+").replace(/_/g, "/"));
    if (decoded.startsWith("repo:v2:")) {
      const value = JSON.parse(decoded.slice("repo:v2:".length));
      const definition = gitProviderDefinition(value.provider);
      if (!definition || typeof value.owner !== "string" || typeof value.repo !== "string") return null;
      const source = parseRepository(`${definition.webBaseUrl}/${value.owner}/${value.repo}`);
      return encodeRepoSlug(source.owner, source.repo, source.provider) === slug ? source : null;
    }
    const source = parseRepository(`${GITHUB_PROVIDER.webBaseUrl}/${decoded}`);
    return `${source.owner}/${source.repo}` === decoded &&
      encodeRepoSlug(source.owner, source.repo, source.provider) === slug
      ? source
      : null;
  } catch {
    // diagnostics-ignore: malformed public references are expected input validation failures.
    return null;
  }
}

/** Also used by the dashboard's ordinary Git URL import. URLs remain accepted for pasted input. */
export function parseDeploySource(input: {
  app?: unknown;
  repo?: unknown;
  branch?: unknown;
}): DeploySource {
  const { app, repo, branch } = input;
  if ((app !== undefined) === (repo !== undefined))
    throw new Error("Choose one app or Git repository to deploy.");
  if (app !== undefined) {
    if (
      typeof app !== "string" ||
      !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(app) ||
      app.length > 100 ||
      branch !== undefined
    )
      throw new Error("Use a valid app ID without repository options.");
    return { kind: "app", appId: app };
  }
  if (typeof repo !== "string")
    throw new Error("Use a Git repository URL or a valid deployment link.");
  const source = /^https?:\/\//i.test(repo.trim())
    ? parseRepository(repo)
    : decodeRepositorySlug(repo);
  if (!source)
    throw new Error("Invalid repository reference. Paste the Git repository URL to continue.");
  // A conservative Git branch subset is sufficient for shareable buttons. In
  // particular, no shell syntax, control characters, rev expressions or options.
  if (
    branch !== undefined &&
    (typeof branch !== "string" ||
      branch.length > 200 ||
      !/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/.test(branch) ||
      branch
        .split("/")
        .some(
          (part) => !part || part.startsWith(".") || part.endsWith(".") || part.endsWith(".lock"),
        ) ||
      branch.includes(".."))
  )
    throw new Error("Use a valid Git branch name.");
  return {
    kind: "repo",
    ...source,
    ...(branch ? { branch } : {}),
  };
}

export function deploySourceParams(source: DeploySource): URLSearchParams {
  return new URLSearchParams(
    source.kind === "app"
      ? { app: source.appId }
      : {
          repo: encodeRepoSlug(source.owner, source.repo, source.provider),
          ...(source.branch ? { branch: source.branch } : {}),
        },
  );
}

/** Same intent URL on the public site and the authenticated dashboard. */
export function deployLinkHref(source: DeploySource, destination?: DeployDestination, referralCode?: string): string {
  const params = deploySourceParams(source);
  if (destination) params.set("destination", destination);
  if (referralCode) params.set("ref", referralCode);
  return `/deploy?${params}`;
}

/** Existing dashboard repo slug format, shared by normal imports and deploy buttons. */
export function encodeRepoSlug(owner: string, repo: string, provider = DEFAULT_GIT_PROVIDER): string {
  const payload = provider === "github" && !owner.includes("/")
    ? `${owner}/${repo}`
    : `repo:v2:${JSON.stringify({ provider, owner, repo })}`;
  const bytes = new TextEncoder().encode(payload);
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** Auth may resume a repository wizard, but never an encoded local path or project override. */
export function isRepositoryDeployPath(path: string): boolean {
  const slug = /^\/deploy\/([A-Za-z0-9_-]{1,400})$/.exec(path)?.[1];
  return !!slug && decodeRepositorySlug(slug) !== null;
}

/** Open the normal wizard directly; no new endpoint or server version is required to resolve a link. */
export function deploySetupHref(source: DeploySource, destination?: DeployDestination, referralCode?: string): string {
  const params = new URLSearchParams();
  if (destination) params.set("destination", destination);
  if (referralCode) params.set("ref", referralCode);
  if (source.kind === "repo" && source.branch) params.set("branch", source.branch);
  const path =
    source.kind === "app"
      ? `/apps/new/${source.appId}`
      : `/deploy/${encodeRepoSlug(source.owner, source.repo, source.provider)}`;
  return `${path}${params.size ? `?${params}` : ""}`;
}

export function parseDeployDestination(value: unknown): DeployDestination | undefined {
  return value === "cloud" || value === "server" ? value : undefined;
}

export function deployInstallCommand(source: DeploySource, installed = false): string {
  // Single-quote each argument even though the source parser is deliberately
  // restrictive. Nothing from the repository is evaluated by the bootstrapper.
  const quote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;
  const args =
    source.kind === "app"
      ? `--app ${quote(source.appId)}`
      : `--repo ${quote(source.url)}${source.branch ? ` --branch ${quote(source.branch)}` : ""}`;
  return installed
    ? `openship launch ${args}`
    : `curl -fsSL https://get.openship.io | sh -s -- ${args}`;
}
