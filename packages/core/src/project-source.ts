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
  /**
   * Container image ref template for container release mode (mode="github" or "url").
   * Placeholders: {version} (bare semver) or {tag} (raw release tag).
   * e.g. "ghcr.io/orangecoding/fredy:{version}".
   */
  imageTemplate?: string;
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

const IMAGE_PLACEHOLDERS = ["tag", "version"] as const;

/**
 * Fill a container image template from a version (and optional raw release tag).
 * If template has no placeholders, replaces the tag portion after the final colon.
 */
export function renderImageTemplate(
  template: string,
  opts: { version: string; tag?: string },
): string {
  const version = opts.version.trim();
  const cleanVersion = version.replace(/^v/, "");
  const rawTag = opts.tag ?? cleanVersion;
  const stray = template.match(/\{[^{}]*\}/g)?.filter(
    (p) => !IMAGE_PLACEHOLDERS.some((valid) => p === `{${valid}}`),
  );
  if (stray && stray.length > 0) {
    throw new Error(
      `Release image template ${JSON.stringify(template)} uses unknown placeholder(s) ` +
        `${stray.join(", ")}. Supported: ${IMAGE_PLACEHOLDERS.map((p) => `{${p}}`).join(" ")}.`,
    );
  }

  if (template.includes("{version}") || template.includes("{tag}")) {
    return template.replaceAll("{version}", cleanVersion).replaceAll("{tag}", rawTag);
  }
  const lastColon = template.lastIndexOf(":");
  const lastSlash = template.lastIndexOf("/");
  if (lastColon > lastSlash) {
    return `${template.slice(0, lastColon)}:${cleanVersion}`;
  }
  return `${template}:${cleanVersion}`;
}
