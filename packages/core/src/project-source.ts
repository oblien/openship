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

/** True for a release source (no clone/build — deploy an archive or container image). */
export function isReleaseProvider(gitProvider: string | null | undefined): boolean {
  return gitProvider === "release";
}

/**
 * What a release publishes. Existing release-source rows predate this field and
 * always describe an extracted archive, so an absent discriminator MUST continue
 * to mean `archive`. A container release opts into `image` explicitly; the
 * presence of an unrelated field is deliberately not used as a discriminator.
 */
export const RELEASE_ARTIFACT_KINDS = ["archive", "image"] as const;
export type ReleaseArtifactKind = (typeof RELEASE_ARTIFACT_KINDS)[number];

/**
 * A tracked release source. `mode` chooses how OpenShip discovers a version
 * (GitHub Releases or an external version URL); `artifactKind` independently
 * chooses whether that release deploys an extracted archive or a registry image.
 * The deployed VERSION/tag, not a commit, drives redeploys.
 *
 * This remains a flat, optional-field shape because it is persisted in JSON and
 * legacy archive rows have no artifact discriminator. Service-boundary validation
 * is responsible for requiring the fields selected by mode + artifact kind.
 */
export interface ReleaseSource {
  mode: "github" | "url";
  /**
   * The artifact deployed for a resolved release. Omitted on legacy rows, where
   * it means `archive`. `image` deploys the rendered registry reference verbatim
   * and never downloads/extracts a release asset.
   */
  artifactKind?: ReleaseArtifactKind;
  /** GitHub "owner/repo" used for release/tag discovery (mode="github"). */
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
  /** External HTTPS tarball URL (mode="url", archive only). May contain {version}. */
  distUrl?: string;
  /**
   * Registry image template (artifactKind="image"). `{version}` is the
   * normalized release version and `{tag}` is the upstream tag verbatim. At
   * least one placeholder is required and placeholders may appear only in the
   * image tag, e.g. `ghcr.io/acme/api:{tag}`.
   */
  imageTemplate?: string;
  /** External sha256 sidecar URL, OR a pinned inline hash for a fixed distUrl. */
  sha256Url?: string;
  sha256?: string;
  /** mode="url" drift source: a URL returning the latest semver (plain text or {version}). */
  versionUrl?: string;
  /** Reserved: release-tag prefix / channel filter. */
  channel?: string;
  /** Pin to a specific version instead of resolving "latest". */
  pinnedVersion?: string;
  /** Reserved opt-in for release-webhook auto-deploy. */
  trackReleases?: boolean;
}

/**
 * Resolve the persisted discriminator without changing legacy release sources.
 *
 * Unknown values throw instead of silently becoming archives: JSON columns and
 * imported dumps are runtime data, and treating a corrupt `"images"` value as an
 * archive would send a registry project down the download/extract path.
 */
export function releaseArtifactKind(
  source: Pick<ReleaseSource, "artifactKind"> | null | undefined,
): ReleaseArtifactKind {
  const kind = source?.artifactKind;
  if (kind === undefined || kind === "archive") return "archive";
  if (kind === "image") return "image";
  throw new Error(`Unknown release artifact kind ${JSON.stringify(kind)}.`);
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
  const version = opts.version.replace(/^v/i, "");
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

// ─── Container release images ────────────────────────────────────────────────

/** OCI/Docker distribution reference limits. */
const MAX_IMAGE_NAME_LENGTH = 255;
const MAX_IMAGE_TAG_LENGTH = 128;

/** A repository path component from the distribution/reference grammar. */
const IMAGE_PATH_COMPONENT_RE = /^[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*$/;
/** A tag from the distribution/reference grammar. */
const IMAGE_TAG_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;
/** A digest algorithm and encoded value from the OCI descriptor grammar. */
const IMAGE_DIGEST_RE = /^([A-Za-z][A-Za-z0-9]*(?:[+._-][A-Za-z][A-Za-z0-9]*)*):([A-Za-z0-9=_-]+)$/;
// Registry DNS names are case-insensitive and the distribution grammar permits
// either case. Only repository path components are required to be lowercase.
const IMAGE_DOMAIN_LABEL_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/;

/**
 * Validate a concrete OCI/Docker image reference.
 *
 * Returns an actionable message rather than throwing so API schemas, CLI input
 * and dashboard forms can share the same rule and present it in their own shape.
 * The release renderer below turns the message into an exception because a bad
 * frozen artifact must stop before a pull/deploy is attempted.
 *
 * This intentionally validates more than "contains a slash and colon": schemes,
 * uppercase repository names, empty components, traversal-ish separators,
 * malformed registry ports, overlong tags and malformed digests are all rejected
 * here rather than delegated to a Docker daemon with a target-specific error.
 */
export function validateImageReference(ref: string): string | null {
  if (typeof ref !== "string") return "Container image reference must be a string.";
  if (!ref) return "Container image reference cannot be empty.";
  if (ref !== ref.trim()) return "Container image reference cannot have surrounding whitespace.";
  if (/\s/.test(ref))
    return `Container image reference ${JSON.stringify(ref)} cannot contain whitespace.`;
  if (ref.includes("\0"))
    return `Container image reference ${JSON.stringify(ref)} contains a NUL byte.`;
  if (ref.includes("://")) {
    return `Container image reference ${JSON.stringify(ref)} must not include a URL scheme.`;
  }

  const at = ref.indexOf("@");
  if (at !== -1 && at !== ref.lastIndexOf("@")) {
    return `Container image reference ${JSON.stringify(ref)} contains more than one digest separator (@).`;
  }

  const nameAndTag = at === -1 ? ref : ref.slice(0, at);
  const digest = at === -1 ? null : ref.slice(at + 1);
  if (!nameAndTag)
    return `Container image reference ${JSON.stringify(ref)} is missing a repository name.`;
  if (digest !== null) {
    const parsed = IMAGE_DIGEST_RE.exec(digest);
    if (!parsed) {
      return `Container image reference ${JSON.stringify(ref)} has an invalid OCI digest.`;
    }
    // The generic OCI grammar permits algorithms other than sha256. For the
    // overwhelmingly common sha256 form, enforce its real encoded length so a
    // truncated digest is not accepted as a deployable reference.
    if (parsed[1]!.toLowerCase() === "sha256" && !/^[a-fA-F0-9]{64}$/.test(parsed[2]!)) {
      return `Container image reference ${JSON.stringify(ref)} has an invalid sha256 digest (expected 64 hexadecimal characters).`;
    }
  }

  const lastSlash = nameAndTag.lastIndexOf("/");
  const lastColon = nameAndTag.lastIndexOf(":");
  const hasTag = lastColon > lastSlash;
  const name = hasTag ? nameAndTag.slice(0, lastColon) : nameAndTag;
  const tag = hasTag ? nameAndTag.slice(lastColon + 1) : null;

  if (!name)
    return `Container image reference ${JSON.stringify(ref)} is missing a repository name.`;
  if (name.length > MAX_IMAGE_NAME_LENGTH) {
    return `Container image repository name is too long (${name.length}; maximum ${MAX_IMAGE_NAME_LENGTH}).`;
  }
  if (tag !== null) {
    if (!tag) return `Container image reference ${JSON.stringify(ref)} has an empty tag.`;
    if (tag.length > MAX_IMAGE_TAG_LENGTH || !IMAGE_TAG_RE.test(tag)) {
      return `Container image reference ${JSON.stringify(ref)} has an invalid tag; tags must be 1-${MAX_IMAGE_TAG_LENGTH} ASCII letters, digits, underscores, periods, or hyphens and cannot start with a period or hyphen.`;
    }
  }

  const parts = name.split("/");
  if (parts.some((part) => !part)) {
    return `Container image reference ${JSON.stringify(ref)} contains an empty repository path component.`;
  }

  // Docker treats the first component as a registry only when it looks like a
  // host. A bare `org/image` therefore validates both components as repository
  // path segments and resolves through Docker Hub.
  const first = parts[0]!;
  const hasRegistry =
    parts.length > 1 &&
    (first.includes(".") || first.includes(":") || first === "localhost" || first.startsWith("["));
  const path = hasRegistry ? parts.slice(1) : parts;
  if (path.length === 0 || path.some((part) => !IMAGE_PATH_COMPONENT_RE.test(part))) {
    return `Container image reference ${JSON.stringify(ref)} has an invalid repository path; repository names must be lowercase OCI path components.`;
  }

  if (hasRegistry) {
    const registryError = validateImageRegistry(first);
    if (registryError) return `Container image reference ${JSON.stringify(ref)} ${registryError}`;
  }

  return null;
}

/**
 * Validate the external endpoint used to discover an image release version.
 *
 * This is browser-safe so the dashboard and CLI can reject an obvious bad
 * source before submitting it, while the API remains the authoritative
 * persistence boundary. Network-level SSRF protection stays in the API's
 * `safeFetch`; URL shape belongs in the shared source contract.
 */
export function validateReleaseVersionUrl(value: string): string | null {
  if (typeof value !== "string" || !value.trim()) {
    return "Release version URL cannot be empty.";
  }
  if (value !== value.trim()) {
    return "Release version URL cannot have surrounding whitespace.";
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return "Release version URL must be a valid HTTPS URL.";
  }
  if (url.protocol !== "https:") {
    return "Release version URL must use HTTPS.";
  }
  if (url.username || url.password) {
    return "Release version URL must not include embedded credentials.";
  }
  return null;
}

/**
 * Validate the `owner/repository` identity used for GitHub release discovery.
 *
 * Keeping this next to the release-source contract gives the API, dashboard and
 * CLI one rule. Besides ordinary format mistakes, it rejects `.`/`..` path
 * segments that URL normalization could otherwise turn into a different GitHub
 * API endpoint than the operator entered.
 */
export function validateReleaseRepository(value: string): string | null {
  if (typeof value !== "string" || !value.trim()) {
    return 'GitHub release repository must use the "owner/repository" format.';
  }
  if (value !== value.trim()) {
    return "GitHub release repository cannot have surrounding whitespace.";
  }

  const parts = value.split("/");
  if (parts.length !== 2) {
    return 'GitHub release repository must use the "owner/repository" format.';
  }
  const [owner, repository] = parts as [string, string];
  const ownerValid =
    owner.length <= 39 && /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(owner);
  const repositoryValid =
    repository.length <= 100 &&
    repository !== "." &&
    repository !== ".." &&
    /^[A-Za-z0-9_.-]+$/.test(repository);
  if (!ownerValid || !repositoryValid) {
    return "GitHub release repository contains an invalid owner or repository name.";
  }
  return null;
}

/**
 * Validate a Docker-compatible bracketed IPv6 registry host without importing
 * Node-only networking APIs into the shared dashboard/core bundle.
 */
function isValidBracketedIpv6Host(host: string): boolean {
  // Distribution references permit only hexadecimal IPv6 notation here (no
  // zone identifiers or dotted IPv4 tail). The URL parser then verifies the
  // compression and segment structure that a character class cannot express.
  if (!/^\[[0-9a-fA-F:]+\]$/.test(host)) return false;
  try {
    const parsed = new URL(`http://${host}/`);
    return parsed.hostname.startsWith("[") && parsed.hostname.endsWith("]");
  } catch {
    return false;
  }
}

/** Validate the optional registry component, including a numeric TCP port. */
function validateImageRegistry(registry: string): string | null {
  let host = registry;
  let port: string | null = null;

  if (registry.startsWith("[")) {
    const close = registry.indexOf("]");
    if (close <= 1) return "has an invalid bracketed IPv6 registry host.";
    host = registry.slice(0, close + 1);
    const rest = registry.slice(close + 1);
    if (rest) {
      if (!rest.startsWith(":")) return "has invalid characters after its registry host.";
      port = rest.slice(1);
    }
    if (!isValidBracketedIpv6Host(host)) {
      return "has an invalid bracketed IPv6 registry host.";
    }
  } else {
    const colon = registry.lastIndexOf(":");
    if (colon !== -1) {
      host = registry.slice(0, colon);
      port = registry.slice(colon + 1);
    }
    if (!host) return "is missing its registry host.";
    const labels = host.split(".");
    if (labels.some((label) => !IMAGE_DOMAIN_LABEL_RE.test(label))) {
      return "has an invalid registry hostname.";
    }
  }

  if (port !== null) {
    if (!/^\d+$/.test(port)) return "has a non-numeric registry port.";
    const value = Number(port);
    if (value < 1 || value > 65535) return "has a registry port outside 1-65535.";
  }
  return null;
}

const RELEASE_IMAGE_PLACEHOLDERS = ["version", "tag"] as const;

/**
 * Render a release's concrete registry image.
 *
 * Image templates are deliberately narrower than archive asset templates:
 * `{version}` and `{tag}` are the only variables, at least one is mandatory,
 * and every occurrence must be inside the image TAG. A placeholder in the
 * registry/repository could redirect a release to another image namespace; one
 * in a digest would pretend an arbitrary release tag is a content hash. Keeping
 * substitution inside the tag makes the repository identity stable and auditable.
 *
 * `tag` is required separately and used verbatim. Reconstructing it as
 * `v${version}` would be incorrect for upstream tags without `v` (or with another
 * prefix), which is why release resolution must preserve both values.
 */
export function renderReleaseImage(
  template: string,
  opts: { version: string; tag: string },
): string {
  if (typeof template !== "string" || !template.trim()) {
    throw new Error("Release image template cannot be empty.");
  }
  if (template !== template.trim()) {
    throw new Error("Release image template cannot have surrounding whitespace.");
  }

  let insidePlaceholder = false;
  for (const char of template) {
    if (char === "{") {
      if (insidePlaceholder) {
        throw new Error(
          `Release image template ${JSON.stringify(template)} contains malformed placeholder braces.`,
        );
      }
      insidePlaceholder = true;
    } else if (char === "}") {
      if (!insidePlaceholder) {
        throw new Error(
          `Release image template ${JSON.stringify(template)} contains malformed placeholder braces.`,
        );
      }
      insidePlaceholder = false;
    }
  }
  if (insidePlaceholder) {
    throw new Error(
      `Release image template ${JSON.stringify(template)} contains malformed placeholder braces.`,
    );
  }

  const placeholders = template.match(/\{[^{}]*\}/g) ?? [];
  const unknown = placeholders.filter(
    (placeholder) =>
      !(RELEASE_IMAGE_PLACEHOLDERS as readonly string[]).includes(placeholder.slice(1, -1)),
  );
  if (unknown.length > 0) {
    throw new Error(
      `Release image template ${JSON.stringify(template)} uses unknown placeholder(s) ${unknown.join(", ")}. ` +
        `Supported: ${RELEASE_IMAGE_PLACEHOLDERS.map((p) => `{${p}}`).join(" ")}.`,
    );
  }
  if (!template.includes("{version}") && !template.includes("{tag}")) {
    throw new Error(
      `Release image template ${JSON.stringify(template)} must contain {version} or {tag}.`,
    );
  }
  // A digest pins content independently of the release tag. Permitting one here
  // would make every advertised version render a different-looking reference to
  // the same digest, so it is rejected rather than silently defeating updates.
  if (template.includes("@")) {
    throw new Error(
      `Release image template ${JSON.stringify(template)} must use a tag, not a digest.`,
    );
  }

  const lastSlash = template.lastIndexOf("/");
  const tagColon = template.lastIndexOf(":");
  if (tagColon <= lastSlash) {
    throw new Error(
      `Release image template ${JSON.stringify(template)} must put {version} or {tag} in an explicit image tag.`,
    );
  }
  const tagStart = tagColon + 1;
  for (const placeholder of ["{version}", "{tag}"] as const) {
    let at = template.indexOf(placeholder);
    while (at !== -1) {
      if (at < tagStart) {
        throw new Error(
          `Release image template ${JSON.stringify(template)} may use ${placeholder} only in the image tag.`,
        );
      }
      at = template.indexOf(placeholder, at + placeholder.length);
    }
  }

  const rawVersion = opts.version?.trim();
  const rawTag = opts.tag?.trim();
  if (!rawVersion) throw new Error("Release image version cannot be empty.");
  if (!rawTag) throw new Error("Release image tag cannot be empty.");
  const version = rawVersion.replace(/^v/i, "");
  if (!version) throw new Error("Release image version cannot contain only a leading v.");

  // Interpolate in one pass so upstream release metadata remains data. With
  // chained replaceAll calls, a version like `v1{tag}` was processed again by
  // the second replacement and silently selected a different image.
  const rendered = template.replace(/\{(?:version|tag)\}/g, (placeholder) =>
    placeholder === "{version}" ? version : rawTag,
  );
  const invalid = validateImageReference(rendered);
  if (invalid) throw new Error(invalid);
  return rendered;
}
