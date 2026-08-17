import { DEFAULT_IMAGE_REGISTRY } from "./constants";

/**
 * Shared precedence for an Openship container image reference (edge, mail, …).
 * ONE resolver so a per-image wrapper can't drift on the order:
 *
 *   explicit → <image env override> → injectedDefault → `<registry>/<image>:<tag>`
 *
 * where `registry = OPENSHIP_IMAGE_REGISTRY || DEFAULT_IMAGE_REGISTRY` and
 *       `tag      = <tag env override> || OPENSHIP_VERSION || fallbackTag || "latest"`.
 *
 * The image name and the two env overrides are the ONLY per-image differences, so
 * each caller passes them in. Callers read their env vars by LITERAL name (below)
 * and hand the values here, so `OPENSHIP_EDGE_IMAGE`/`OPENSHIP_MAIL_TAG`/etc. stay
 * greppable — the resolver never does a dynamic `process.env[name]` lookup.
 */
export function buildImageRef(
  opts: { explicit?: string | null; injectedDefault?: string | null; fallbackTag?: string } | undefined,
  image: { name: string; imageOverride?: string; tagOverride?: string },
): string {
  const explicit = opts?.explicit?.trim();
  if (explicit) return explicit;
  const override = image.imageOverride?.trim();
  if (override) return override;
  const injected = opts?.injectedDefault?.trim();
  if (injected) return injected;
  const registry = process.env.OPENSHIP_IMAGE_REGISTRY?.trim() || DEFAULT_IMAGE_REGISTRY;
  const tag =
    image.tagOverride?.trim() ||
    process.env.OPENSHIP_VERSION?.trim() ||
    opts?.fallbackTag?.trim() ||
    "latest";
  return `${registry}/${image.name}:${tag}`;
}

/** Docker Hub's canonical name in an image reference. */
export const DOCKER_HUB_REGISTRY = "docker.io";

/**
 * Every key Docker has used for Hub. `docker login` still writes the v1 URL while an
 * image reference says `docker.io`, so a literal lookup of the registry name finds
 * nothing in a real `config.json`.
 */
const DOCKER_HUB_ALIASES = [
  "https://index.docker.io/v1/",
  "https://index.docker.io/v1",
  "index.docker.io",
  "registry-1.docker.io",
  DOCKER_HUB_REGISTRY,
] as const;

/**
 * The registry an image reference addresses.
 *
 * Lives here, beside {@link buildImageRef}, because it is the inverse question about
 * the same string — and because BOTH the credential a user saves and the lookup that
 * matches it at pull time must derive the registry identically. Two copies of this
 * rule is how a credential saved for `ghcr.io` stops matching an image from `ghcr.io`.
 *
 * The first path component is a registry only when it looks like a host AND a path
 * follows it. Without that second condition a tag's colon reads as a registry port:
 * `postgres:16-alpine` has no `/` at all, so the whole reference was taken as the
 * registry (#581).
 */
export function registryForImage(ref: string): string {
  const trimmed = ref.trim();
  const slash = trimmed.indexOf("/");
  if (slash === -1) return DOCKER_HUB_REGISTRY; // `postgres:16-alpine`, `nginx`
  const first = trimmed.slice(0, slash);
  const looksLikeHost = first.includes(".") || first.includes(":") || first === "localhost";
  return looksLikeHost ? first.toLowerCase() : DOCKER_HUB_REGISTRY; // else `myorg/img`
}

/**
 * A registry host as stored: lowercased, with any scheme, trailing slash or trailing
 * path removed, and every Hub spelling folded to `docker.io`.
 *
 * Applied to what the OPERATOR types when saving a credential, so `https://ghcr.io/`
 * and `GHCR.IO` both land on the same row that `registryForImage` will look up.
 */
export function normalizeRegistryHost(input: string): string {
  const bare = input
    .trim()
    .toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, "") // scheme
    .replace(/\/+$/, ""); // trailing slash
  const host = bare.split("/")[0] ?? "";
  return (DOCKER_HUB_ALIASES as readonly string[]).includes(bare) ||
    (DOCKER_HUB_ALIASES as readonly string[]).includes(host)
    ? DOCKER_HUB_REGISTRY
    : host;
}

/**
 * The `config.json` keys that could hold a registry's credential, most likely first.
 *
 * Docker has written the bare host, the `https://` URL and a trailing-slash form at
 * different times, and a config assembled by hand or by CI may use any of them. An
 * exact-match-only lookup silently reports "no credential" for the very registry the
 * operator logged into.
 */
export function registryConfigKeys(registry: string): string[] {
  const host = normalizeRegistryHost(registry);
  if (host === DOCKER_HUB_REGISTRY) return [...DOCKER_HUB_ALIASES];
  return [host, `https://${host}`, `https://${host}/`, `${host}/`, `http://${host}`];
}
