/**
 * Project source model — the discriminator for WHERE a project's code/dist
 * comes from. Shared by the db schema, API request validation, and deploy
 * dispatch so the allowed set can't drift across layers (a typo in one place
 * silently bypassing the release path is exactly the bug we're avoiding).
 */

/** Values stored in `project.gitProvider` (free-text column). */
export const SOURCE_PROVIDERS = [
  "github",
  "azure",
  "gitlab",
  "bitbucket",
  "local",
  "upload",
  "release",
] as const;
export type SourceProvider = (typeof SOURCE_PROVIDERS)[number];

/** True for a release/dist source (no repo, no build — deploy a prebuilt distribution). */
export function isReleaseProvider(gitProvider: string | null | undefined): boolean {
  return gitProvider === "release";
}

/**
 * A release/dist source. Either a GitHub-Releases asset (repo + assetTemplate)
 * or an external HTTPS tarball (distUrl + sha256/sha256Url). The deployed
 * VERSION (a semver tag), not a commit, drives redeploys.
 */
export interface ReleaseSource {
  mode: "github" | "url";
  /** GitHub "owner/repo" (mode="github"). */
  repo?: string;
  /**
   * Asset-name template (mode="github"). Placeholders: {tag} {version} {os} {arch}.
   * e.g. "openship-{tag}-{os}-{arch}.tar.gz".
   */
  assetTemplate?: string;
  /**
   * OS/arch used to fill the asset name — the DEPLOY TARGET's, which is why they are
   * config and not measured: the dist is downloaded onto the control plane and then
   * streamed to a server that may be a different architecture entirely, so the API
   * box's own arch is the one answer that is never right. Default "linux"/"amd64".
   */
  os?: string;
  arch?: string;
  /** External HTTPS tarball URL (mode="url"). May contain {version}. */
  distUrl?: string;
  /** External sha256 sidecar URL, OR a pinned inline hash for a fixed distUrl. */
  sha256Url?: string;
  sha256?: string;
  /** mode="url" drift source: a URL returning the latest semver (plain text or {version}). */
  versionUrl?: string;
  /** Reserved: release-tag prefix / channel filter. */
  channel?: string;
  /** Pin to a specific version instead of resolving "latest". */
  pinnedVersion?: string;
  /** Opt into release-webhook auto-deploy. */
  trackReleases?: boolean;
}

/**
 * The four placeholders this renderer knows. Anything else in a template is a typo,
 * and {@link renderAssetName} refuses rather than shipping it into a URL.
 */
const ASSET_PLACEHOLDERS = ["tag", "version", "os", "arch"] as const;

/**
 * Fill a GitHub asset-name template from a version + os/arch.
 *
 * `os`/`arch` default to the publisher convention (`linux`/`amd64`) because they name
 * an ASSET the release author chose to publish, not a host anyone measured — see the
 * note on `ReleaseSource.os`. Deriving them from the running process would be worse
 * than the default: the control plane downloads the dist and then streams it to a
 * server that may not share its architecture.
 *
 * An unknown placeholder throws. Left alone it survives into the download URL, GitHub
 * 404s, and the operator is told "release dist not found at <cache path>" — a message
 * about a cache directory when the fault is a typo in a template they can see.
 */
export function renderAssetName(
  template: string,
  opts: { version: string; os?: string; arch?: string },
): string {
  const version = opts.version.replace(/^v/, "");
  const tag = `v${version}`;
  const rendered = template
    .replaceAll("{tag}", tag)
    .replaceAll("{version}", version)
    .replaceAll("{os}", opts.os ?? "linux")
    .replaceAll("{arch}", opts.arch ?? "amd64");

  const stray = rendered.match(/\{[^{}]*\}/g);
  if (stray) {
    throw new Error(
      `Release asset template ${JSON.stringify(template)} uses unknown placeholder(s) ` +
        `${stray.join(", ")}. Supported: ${ASSET_PLACEHOLDERS.map((p) => `{${p}}`).join(" ")}.`,
    );
  }
  return rendered;
}

/** Git hosts we can parse a clone URL for today. */
export type GitHostProvider = Extract<SourceProvider, "github" | "azure">;

export interface ParsedGitRepo {
  provider: GitHostProvider;
  /** GitHub owner, or Azure DevOps organization. */
  owner: string;
  /** Azure DevOps project name. Absent for GitHub. */
  project?: string;
  repo: string;
}

function stripGitSuffix(name: string): string {
  return name.replace(/\.git$/i, "").replace(/\/+$/, "");
}

/**
 * Parse a GitHub or Azure DevOps repository URL into owner/repo (+ Azure project).
 * Returns null for unknown hosts. SSH Azure URLs are parsed; clone still uses HTTPS.
 */
export function parseGitRepoUrl(url: string | null | undefined): ParsedGitRepo | null {
  if (!url || typeof url !== "string") return null;
  const s = url.trim();
  if (!s) return null;

  // git@ssh.dev.azure.com:v3/{org}/{project}/{repo}
  const azureSsh = s.match(
    /(?:^git@ssh\.dev\.azure\.com:v3\/|ssh\.dev\.azure\.com:v3\/)([^/]+)\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/i,
  );
  if (azureSsh) {
    return {
      provider: "azure",
      owner: azureSsh[1]!,
      project: azureSsh[2]!,
      repo: stripGitSuffix(azureSsh[3]!),
    };
  }

  // https://{org}.visualstudio.com/{project}/_git/{repo}
  const azureOld = s.match(
    /(?:https?:\/\/)?([^.]+)(?:\.visualstudio\.com)\/([^/?#]+)\/_git\/([^/?#]+)/i,
  );
  if (azureOld) {
    return {
      provider: "azure",
      owner: azureOld[1]!,
      project: azureOld[2]!,
      repo: stripGitSuffix(azureOld[3]!),
    };
  }

  // https://dev.azure.com/{org}/{project}/_git/{repo}  (optional :pat@ prefix)
  const azureHttps = s.match(
    /dev\.azure\.com\/([^/]+)\/([^/]+)\/_git\/([^/?#]+)/i,
  );
  if (azureHttps) {
    return {
      provider: "azure",
      owner: azureHttps[1]!,
      project: azureHttps[2]!,
      repo: stripGitSuffix(azureHttps[3]!),
    };
  }

  // git@github.com:owner/repo.git
  const ghSsh = s.match(/github\.com:([^/]+)\/([^/?#]+?)(?:\.git)?\/?$/i);
  if (ghSsh) {
    return { provider: "github", owner: ghSsh[1]!, repo: stripGitSuffix(ghSsh[2]!) };
  }

  // https://github.com/owner/repo — first two path segments only (ignore /tree/…)
  const ghHttps = s.match(/github\.com\/([^/]+)\/([^/?#]+)/i);
  if (ghHttps) {
    return { provider: "github", owner: ghHttps[1]!, repo: stripGitSuffix(ghHttps[2]!) };
  }

  return null;
}

/**
 * Canonical HTTPS clone URL for a parsed git source.
 * Azure requires `project`. Token is never embedded — inject at clone time only.
 */
export function buildGitUrl(
  provider: GitHostProvider,
  owner: string,
  repo: string,
  project?: string,
): string {
  switch (provider) {
    case "github":
      return `https://github.com/${owner}/${repo}.git`;
    case "azure":
      if (!project) {
        throw new Error("Azure DevOps clone URL requires a project name");
      }
      return `https://dev.azure.com/${owner}/${project}/_git/${repo}`;
    default: {
      const _never: never = provider;
      throw new Error(`Unsupported git provider: ${_never}`);
    }
  }
}
