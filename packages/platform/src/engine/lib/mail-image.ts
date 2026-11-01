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
 * apps/email/ holds TWO Dockerfiles, published under two names: this one — the
 * engine, `openship-mail` — and `Dockerfile.webmail`, the Zero client published as
 * `openship-webmail`. So the directory neither names its image nor owns just one;
 * .github/workflows/docker-images.yml carries the image→Dockerfile map explicitly
 * for the same reason. Keep the two in step if either side moves.
 *
 * Only the engine is a MANAGED image (pinned to APP_VERSION, built from source in a
 * checkout, reconciled by this API). Webmail is a catalog app: it is installed and
 * deployed like any other template, so it has no pin and no build spec here — see
 * packages/core/src/apps/catalog/webmail.json.
 *
 * That catalog entry names `openship-webmail:latest`, deliberately unpinned, unlike
 * every third-party app in the catalog. Two reasons. Skew is harmless: the engine is
 * pinned because this API execs into it and assumes its layout, whereas webmail is a
 * standalone IMAP/SMTP client nothing here reaches into. And a pinned tag would have
 * to be rewritten in generated, drift-tested JSON on every release (scripts/release.ts
 * syncs package.json versions only), so the pin would rot into a tag that was never
 * published. Floating matches how openship ships its own other images (the compose
 * install defaults to :latest, overridable by --image-version); an app update is a
 * redeploy with trigger "update", which is the one trigger that force-pulls.
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
