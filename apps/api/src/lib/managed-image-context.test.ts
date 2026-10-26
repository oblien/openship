import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const anchor = vi.hoisted(() => ({ root: "" }));
vi.mock("@repo/platform/engine/lib/release-resolver", () => ({
  apiRootPath: () => anchor.root,
}));

import { APP_VERSION } from "@repo/platform/engine/lib/app-version";
import { buildKitBuildSpec, pinnedBuildKitImage } from "@repo/platform/engine/lib/buildkit-image";
import { detectBuildContext } from "@repo/platform/engine/lib/managed-images";

const dockerfile = join("packages", "adapters", "Dockerfile.buildkit");
beforeEach(() => {
  anchor.root = mkdtempSync(join(tmpdir(), "openship-managed-context-"));
  mkdirSync(dirname(join(anchor.root, dockerfile)), { recursive: true });
  writeFileSync(join(anchor.root, dockerfile), "FROM moby/buildkit\n");
  for (const key of ["OPENSHIP_BUILDKIT_IMAGE", "OPENSHIP_BUILDKIT_TAG",
    "OPENSHIP_BUILDKIT_BUILD_CONTEXT", "OPENSHIP_VERSION", "OPENSHIP_IMAGE_REGISTRY"])
    vi.stubEnv(key, undefined);
});
afterEach(() => {
  rmSync(anchor.root, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

it("uses the published protected worker when an API distribution bundles its Dockerfile", () => {
  expect(buildKitBuildSpec()).toBeUndefined();
  expect(pinnedBuildKitImage()).toBe(`ghcr.io/oblien/openship-buildkit:${APP_VERSION}`);
});

it.each(["directory", "worktree"])("builds trusted source from a Git %s", (kind) => {
  if (kind === "directory") mkdirSync(join(anchor.root, ".git"));
  else writeFileSync(join(anchor.root, ".git"), "gitdir: /checkout/.git/worktrees/dev\n");
  expect(buildKitBuildSpec()).toEqual({ context: anchor.root, dockerfile });
  expect(pinnedBuildKitImage()).toMatch(/-dev\.[a-f0-9]{12}$/);
});

it("requires the component Dockerfile even in a checkout", () => {
  mkdirSync(join(anchor.root, ".git"));
  rmSync(join(anchor.root, dockerfile));
  expect(buildKitBuildSpec()).toBeUndefined();
});

it("preserves explicit administrator source contexts without Git metadata", () => {
  vi.stubEnv("OPENSHIP_BUILDKIT_BUILD_CONTEXT", anchor.root);
  expect(detectBuildContext(dockerfile, "OPENSHIP_BUILDKIT_BUILD_CONTEXT"))
    .toEqual({ context: anchor.root, dockerfile });
});
