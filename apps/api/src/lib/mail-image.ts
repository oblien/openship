import { join } from "node:path";

import { buildMailImageRef } from "@repo/core";

import { APP_VERSION } from "./app-version";
import { detectBuildContext, devFallbackTag } from "./managed-images";

/**
 * The mail-engine container image this API is allowed to run.
 *
 * Pinned to APP_VERSION by default so the engine's baked config + first-boot
 * entrypoint match the API driving it (the admin layer execs into the container
 * assuming a known layout). An operator can still float the engine independently
 * via OPENSHIP_MAIL_TAG / OPENSHIP_MAIL_IMAGE — the precedence lives in ONE place,
 * buildMailImageRef (@repo/core), shared with adapters' resolveMailImage so the pin
 * this produces and the ref that consumes it can't drift.
 */
export function pinnedMailImage(): string {
  // Same model as pinnedEdgeImage: in a source checkout the fallback becomes a
  // content-derived DEV tag so an edit to apps/email moves the tag and the drift scan
  // reports the engine behind (see devSourceTag). OPENSHIP_MAIL_TAG / OPENSHIP_MAIL_IMAGE
  // still float it independently; a compiled/prod install stays on plain APP_VERSION.
  return buildMailImageRef({ fallbackTag: devFallbackTag(APP_VERSION, mailBuildSpec()) });
}

/**
 * apps/email/ holds the engine's Dockerfile; the image it produces is published as
 * `openship-mail`. That rename is the one place the image↔directory mapping isn't
 * 1:1, and .github/workflows/docker-images.yml encodes the same exception in its
 * build matrix — keep the two in step if either side ever moves.
 */
const MAIL_DOCKERFILE = join("apps", "email", "Dockerfile");

/**
 * The from-source BUILD context for the engine image, or undefined when there's no
 * checkout to build from. Consumed by `deliverManagedImage`, which builds
 * `apps/email/Dockerfile` ON THE TARGET box (in place, or ship + build for a remote
 * one) so the create/swap adopts the dev image instead of pulling the pinned tag. Its
 * presence is also what makes `pinnedMailImage()` produce the dev-suffixed tag (see
 * `devFallbackTag`). Detection + the security rationale (why the context is never
 * client-supplied — it feeds `docker build` as root) live in {@link detectBuildContext}.
 */
export function mailBuildSpec(): { context: string; dockerfile: string } | undefined {
  return detectBuildContext(MAIL_DOCKERFILE, "OPENSHIP_MAIL_BUILD_CONTEXT");
}
