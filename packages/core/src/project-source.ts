/**
 * Project source model — the discriminator for WHERE a project's code/dist
 * comes from. Shared by the db schema, API request validation, and deploy
 * dispatch so the allowed set can't drift across layers (a typo in one place
 * silently bypassing the release path is exactly the bug we're avoiding).
 */

/** Values stored in `project.gitProvider` (free-text column). */
export const SOURCE_PROVIDERS = [
  "github",
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
  /** Target OS/arch used to fill the asset name (default "linux"/"amd64"). */
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

/** Fill a GitHub asset-name template from a version + os/arch. */
export function renderAssetName(
  template: string,
  opts: { version: string; os?: string; arch?: string },
): string {
  const version = opts.version.replace(/^v/, "");
  const tag = `v${version}`;
  return template
    .replaceAll("{tag}", tag)
    .replaceAll("{version}", version)
    .replaceAll("{os}", opts.os ?? "linux")
    .replaceAll("{arch}", opts.arch ?? "amd64");
}
