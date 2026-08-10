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
