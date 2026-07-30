import { describe, expect, it, afterEach } from "vitest";

import { pinnedEdgeImage, withPinnedEdgeImage } from "../../src/lib/edge-image";
import { APP_VERSION } from "../../src/lib/app-version";

const saved = { ...process.env };
afterEach(() => {
  process.env = { ...saved };
});

describe("pinnedEdgeImage", () => {
  it("pins the tag to this API's own version", () => {
    delete process.env.OPENSHIP_EDGE_TAG;
    expect(pinnedEdgeImage()).toBe(`ghcr.io/oblien/openship-edge:${APP_VERSION}`);
  });

  it("honours a configured registry", () => {
    process.env.OPENSHIP_IMAGE_REGISTRY = "docker.io/oblien";
    delete process.env.OPENSHIP_EDGE_TAG;
    expect(pinnedEdgeImage()).toBe(`docker.io/oblien/openship-edge:${APP_VERSION}`);
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
