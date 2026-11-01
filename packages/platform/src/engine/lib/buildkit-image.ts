import { join } from "node:path";
import { buildImageRef } from "@repo/core";
import { APP_VERSION } from "./app-version";
import { detectBuildContext, devFallbackTag } from "./managed-images";

export function buildKitBuildSpec(): { context: string; dockerfile: string } | undefined {
  return detectBuildContext(
    join("packages", "adapters", "Dockerfile.buildkit"),
    "OPENSHIP_BUILDKIT_BUILD_CONTEXT",
  );
}

export function pinnedBuildKitImage(): string {
  return buildImageRef(
    {
      fallbackTag: devFallbackTag(APP_VERSION, buildKitBuildSpec(), [
        "packages/adapters/Dockerfile.buildkit",
        "packages/adapters/scripts/render-buildkit-guard.ts",
        "packages/core/src/build-metadata-policy.ts",
      ]),
    },
    {
      name: "openship-buildkit",
      imageOverride: process.env.OPENSHIP_BUILDKIT_IMAGE,
      tagOverride: process.env.OPENSHIP_BUILDKIT_TAG,
    },
  );
}
