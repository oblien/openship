import { join } from "node:path";

import type { InstallerConfig } from "@repo/adapters";
import { buildEdgeImageRef } from "@repo/core";

import { APP_VERSION } from "./app-version";
import { detectBuildContext, devFallbackTag } from "./managed-images";

/**
 * The edge container image this API is allowed to run.
 *
 * Pinned to APP_VERSION so the Lua + nginx.conf baked into the edge always match
 * the API driving it — a skewed edge would answer requests with rules this build
 * doesn't know it wrote.
 */
export function pinnedEdgeImage(): string {
  // Precedence lives in ONE place — buildEdgeImageRef (@repo/core) — shared with
  // adapters' resolveEdgeImage so the pin this produces and the ref that consumes
  // it can't drift (they used to disagree on OPENSHIP_EDGE_TAG). Pin the tag to
  // APP_VERSION: the Lua + nginx.conf baked into the edge must match this build.
  //
  // In a source checkout the fallback becomes a content-derived DEV tag
  // (`<APP_VERSION>-dev.<hash>`) so a manual edit to apps/edge moves the tag and the
  // drift scan reports the box behind — see devSourceTag. An explicit
  // OPENSHIP_EDGE_TAG / OPENSHIP_VERSION still wins (buildEdgeImageRef precedence),
  // and a compiled/prod install has no checkout so it stays the plain APP_VERSION.
  return buildEdgeImageRef({ fallbackTag: devFallbackTag(APP_VERSION, edgeBuildSpec()) });
}

/**
 * Stamp the pinned image onto an InstallerConfig, OVERWRITING whatever was there.
 *
 * The component-install endpoints forward `body.config` into InstallerConfig
 * unvalidated, so without this overwrite a caller could name any image — and the
 * edge runs with host networking and `/etc/letsencrypt` mounted. Server-admin is
 * not authorization to run an arbitrary container as root on that box, so the image
 * is never client-supplied. Always apply this at the boundary, not deeper: it must
 * be impossible to reach an installer with a caller's value still in place.
 */
export function withPinnedEdgeImage(config: InstallerConfig = {}): InstallerConfig {
  return { ...config, edgeImage: pinnedEdgeImage() };
}

/**
 * apps/edge/ holds the edge's Dockerfile; the image it produces is published as
 * `openship-edge`. Same image↔directory rename exception the mail engine has, encoded
 * identically in .github/workflows/docker-images.yml — keep the two in step.
 */
const EDGE_DOCKERFILE = join("apps", "edge", "Dockerfile");

/**
 * The from-source BUILD context for the edge image, or undefined when there's no
 * checkout to build from. Consumed by `deliverManagedImage`, which builds
 * `apps/edge/Dockerfile` ON THE TARGET box (in place, or ship + build for a remote
 * one) so the create/swap adopts the dev image instead of pulling the pinned tag. Its
 * presence is also what makes `pinnedEdgeImage()` produce the dev-suffixed tag (see
 * `devFallbackTag`). In a dev checkout this is how the edge runs the fixes in the
 * working tree instead of the last published production image; in a compiled/bundled
 * install it returns undefined and bring-up pulls as before. Detection + the
 * security rationale (why the context is never client-supplied — it feeds `docker
 * build` as root) live in {@link detectBuildContext}, the shared detector.
 */
export function edgeBuildSpec(): { context: string; dockerfile: string } | undefined {
  return detectBuildContext(EDGE_DOCKERFILE, "OPENSHIP_EDGE_BUILD_CONTEXT");
}
