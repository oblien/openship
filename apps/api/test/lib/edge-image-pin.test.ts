import { existsSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it, afterEach } from "vitest";

import { edgeBuildSpec, pinnedEdgeImage, withPinnedEdgeImage } from "../../src/lib/edge-image";
import { detectBuildContext } from "../../src/lib/managed-images";
import { APP_VERSION } from "../../src/lib/app-version";

const EDGE_DOCKERFILE = join("apps", "edge", "Dockerfile");
const saved = { ...process.env };
afterEach(() => {
  process.env = { ...saved };
});

// Clears everything that overrides the resolved tag/registry so `fallbackTag` (the
// value under test) is what actually surfaces in the ref.
function clearRefEnv() {
  delete process.env.OPENSHIP_EDGE_IMAGE;
  delete process.env.OPENSHIP_EDGE_TAG;
  delete process.env.OPENSHIP_VERSION;
  delete process.env.OPENSHIP_IMAGE_REGISTRY;
}

// Force the "compiled/prod, no checkout" branch even though the suite itself runs
// from a checkout: an explicit context is taken verbatim (no existence check), but it
// holds no apps/edge tree, so the dev-tag signature is empty and the plain published
// version is used.
const NO_CHECKOUT = "/definitely/not/an/openship/checkout";

describe("pinnedEdgeImage", () => {
  it("pins the tag to this API's own version (no checkout → published tag)", () => {
    clearRefEnv();
    process.env.OPENSHIP_EDGE_BUILD_CONTEXT = NO_CHECKOUT;
    expect(pinnedEdgeImage()).toBe(`ghcr.io/oblien/openship-edge:${APP_VERSION}`);
  });

  it("honours a configured registry", () => {
    clearRefEnv();
    process.env.OPENSHIP_IMAGE_REGISTRY = "docker.io/oblien";
    process.env.OPENSHIP_EDGE_BUILD_CONTEXT = NO_CHECKOUT;
    expect(pinnedEdgeImage()).toBe(`docker.io/oblien/openship-edge:${APP_VERSION}`);
  });

  it("suffixes the tag with a content hash when a source checkout is present", () => {
    clearRefEnv();
    delete process.env.OPENSHIP_EDGE_BUILD_CONTEXT; // auto-detect the real repo root
    // Running from a checkout, so apps/edge exists and the tag becomes a dev virtual
    // version — an unpublished tag that only a from-source build can satisfy, which is
    // what makes the drift scan honest after a manual edit.
    const pattern = new RegExp(`:${APP_VERSION.replace(/\./g, "\\.")}-dev\\.[0-9a-f]{12}$`);
    expect(pinnedEdgeImage()).toMatch(pattern);
  });
});

describe("withPinnedEdgeImage", () => {
  it("OVERWRITES a caller-supplied image", () => {
    // The component-install endpoints forward `body.config` into InstallerConfig
    // unvalidated. The edge runs host-networked with /etc/letsencrypt mounted, so a
    // caller-named image would be arbitrary root-level container execution on that
    // box — server-admin is not authorization for that.
    const config = withPinnedEdgeImage({
      edgeImage: "evil.example.com/backdoor:latest",
    } as Parameters<typeof withPinnedEdgeImage>[0]);

    expect(config.edgeImage).toBe(pinnedEdgeImage());
    expect(config.edgeImage).not.toContain("evil.example.com");
  });

  it("preserves the rest of the config", () => {
    const config = withPinnedEdgeImage({
      acmeEmail: "ops@example.com",
      edgePolicy: { mode: "takeover", stopTargets: [] },
    });

    expect(config.acmeEmail).toBe("ops@example.com");
    expect(config.edgePolicy?.mode).toBe("takeover");
    expect(config.edgeImage).toBe(pinnedEdgeImage());
  });

  it("works on an empty config", () => {
    expect(withPinnedEdgeImage().edgeImage).toBe(pinnedEdgeImage());
  });
});

describe("edgeBuildSpec", () => {
  it("returns the explicit OPENSHIP_EDGE_BUILD_CONTEXT (with the dockerfile) when set", () => {
    process.env.OPENSHIP_EDGE_BUILD_CONTEXT = "/srv/openship-checkout";
    expect(edgeBuildSpec()).toEqual({ context: "/srv/openship-checkout", dockerfile: EDGE_DOCKERFILE });
  });

  it("auto-detects a repo root that actually holds apps/edge/Dockerfile", () => {
    delete process.env.OPENSHIP_EDGE_BUILD_CONTEXT;
    const spec = edgeBuildSpec();
    // Running from a source checkout, so the anchor above apps/api IS the repo root.
    // Assert the context is a real dir holding the Dockerfile rather than hardcoding a
    // path — the guard is what keeps a bundled install from returning a bogus context.
    expect(spec).toBeDefined();
    expect(existsSync(join(spec!.context, "apps", "edge", "Dockerfile"))).toBe(true);
  });

  it("returns undefined when no checkout holds the Dockerfile (compiled/prod → pull)", () => {
    // The shared guard: auto-detect with a path that can't exist under the repo root
    // yields undefined, so bring-up falls through to the registry pull. This is the
    // branch that makes a published binary NOT try to build from a nonexistent tree.
    delete process.env.OPENSHIP_EDGE_BUILD_CONTEXT;
    expect(detectBuildContext(join("apps", "does-not-exist", "Dockerfile"), "OPENSHIP_EDGE_BUILD_CONTEXT")).toBeUndefined();
  });
});
