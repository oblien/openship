import type { InstallerConfig } from "@repo/adapters";
import { buildEdgeImageRef } from "@repo/core";

import { APP_VERSION } from "./app-version";

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
  return buildEdgeImageRef({ fallbackTag: APP_VERSION });
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
