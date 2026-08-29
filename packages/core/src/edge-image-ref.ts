import { buildImageRef } from "./image-ref";

/**
 * THE single precedence for the edge container image reference, shared by
 * `pinnedEdgeImage` (apps/api) and `resolveEdgeImage` (packages/adapters) so the
 * two can never drift — they previously disagreed (only one read
 * `OPENSHIP_EDGE_TAG`), which meant the same box could compute two different edge
 * tags depending on which door the install came through. Order:
 *
 *   explicit → OPENSHIP_EDGE_IMAGE → injectedDefault → `<registry>/openship-edge:<tag>`
 *
 * where `registry = OPENSHIP_IMAGE_REGISTRY || DEFAULT_IMAGE_REGISTRY` and
 *       `tag      = OPENSHIP_EDGE_TAG || OPENSHIP_VERSION || fallbackTag || "latest"`.
 *
 * `fallbackTag` is the ONLY intentional per-layer difference: apps/api pins its
 * `APP_VERSION` (the Lua + nginx.conf baked into the edge must match the API
 * driving it), while the version-agnostic adapters layer has no build version and
 * omits it — the API injects its pinned ref via `setDefaultEdgeImage`, so the
 * adapters fallback ("latest") is only reached when nothing was injected.
 *
 * The resolution order lives in `buildImageRef`, shared with `buildMailImageRef`;
 * only the image name + these two env overrides differ.
 */
export function buildEdgeImageRef(opts?: {
  explicit?: string | null;
  injectedDefault?: string | null;
  fallbackTag?: string;
}): string {
  return buildImageRef(opts, {
    name: "openship-edge",
    imageOverride: process.env.OPENSHIP_EDGE_IMAGE,
    tagOverride: process.env.OPENSHIP_EDGE_TAG,
  });
}
