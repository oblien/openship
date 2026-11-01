import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { APP_VERSION } from "@repo/platform/engine/lib/app-version";
import { buildKitBuildSpec, pinnedBuildKitImage } from "@repo/platform/engine/lib/buildkit-image";

afterEach(() => vi.unstubAllEnvs());
function clean() {
  for (const name of [
    "OPENSHIP_BUILDKIT_IMAGE",
    "OPENSHIP_BUILDKIT_TAG",
    "OPENSHIP_BUILDKIT_BUILD_CONTEXT",
    "OPENSHIP_VERSION",
    "OPENSHIP_IMAGE_REGISTRY",
  ])
    vi.stubEnv(name, undefined);
}
it("detects and version-tags only the trusted protected worker source", () => {
  clean();
  const spec = buildKitBuildSpec();
  expect(spec?.dockerfile).toBe(join("packages", "adapters", "Dockerfile.buildkit"));
  expect(existsSync(join(spec!.context, spec!.dockerfile))).toBe(true);
  expect(pinnedBuildKitImage()).toMatch(
    new RegExp(`:${APP_VERSION.replace(/\./g, "\\.")}-dev\\.[a-f0-9]{12}$`),
  );
});
it("uses the release version when source is absent and respects administrator image overrides", () => {
  clean();
  vi.stubEnv("OPENSHIP_BUILDKIT_BUILD_CONTEXT", "/not/an/openship/checkout");
  expect(pinnedBuildKitImage()).toBe(`ghcr.io/oblien/openship-buildkit:${APP_VERSION}`);
  vi.stubEnv("OPENSHIP_BUILDKIT_IMAGE", "registry.test/guard@sha256:123");
  expect(pinnedBuildKitImage()).toBe("registry.test/guard@sha256:123");
});
