import { describe, expect, it } from "vitest";
import {
  releaseImageDraftFromSource,
  releaseImageSourceFromDraft,
  canConfigureReleaseImageSource,
  releaseImageVersionLabels,
  usesReleaseImageSourceSettings,
  type ReleaseImageSourceDraft,
} from "./release-image-source";

const draft = (overrides: Partial<ReleaseImageSourceDraft> = {}): ReleaseImageSourceDraft => ({
  mode: "github",
  imageTemplate: "ghcr.io/acme/api:{tag}",
  repo: "acme/api",
  versionUrl: "",
  pinnedVersion: "",
  ...overrides,
});

describe("release image source editor payload", () => {
  it("routes only non-catalog image projects away from Git settings", () => {
    const releaseSource = releaseImageSourceFromDraft(draft());
    expect(usesReleaseImageSourceSettings({ releaseSource })).toBe(true);
    expect(usesReleaseImageSourceSettings({ isApp: true, releaseSource })).toBe(false);
    expect(
      usesReleaseImageSourceSettings({
        releaseSource: { mode: "github", artifactKind: "archive", repo: "acme/api" },
      }),
    ).toBe(false);
  });

  it("offers the transition only to runnable single-app projects", () => {
    expect(
      canConfigureReleaseImageSource({ framework: "nextjs", options: { workloadType: "web" } }),
    ).toBe(true);
    expect(canConfigureReleaseImageSource({ framework: "docker-compose" })).toBe(false);
    expect(
      canConfigureReleaseImageSource({ framework: "nextjs", options: { workloadType: "static" } }),
    ).toBe(false);
    expect(
      canConfigureReleaseImageSource({ framework: "nextjs", options: { hasServer: false } }),
    ).toBe(false);
  });

  it("never reports a pinned but undeployed version as current", () => {
    expect(
      releaseImageVersionLabels({
        currentVersion: null,
        latestVersion: "9.0.0",
        pinnedVersion: "2.4.1",
        loading: true,
      }),
    ).toEqual({ current: "Not deployed", latest: "2.4.1" });
  });

  it("builds a GitHub release source, preserves its pin, and drops URL-only fields", () => {
    expect(
      releaseImageSourceFromDraft(
        draft({ versionUrl: "https://versions.example.test/latest", pinnedVersion: "2.0.0" }),
      ),
    ).toEqual({
      artifactKind: "image",
      mode: "github",
      imageTemplate: "ghcr.io/acme/api:{tag}",
      repo: "acme/api",
      pinnedVersion: "2.0.0",
    });
  });

  it("does not erase reserved release options during an editor round trip", () => {
    const source = {
      mode: "github" as const,
      artifactKind: "image" as const,
      imageTemplate: "ghcr.io/acme/api:{tag}",
      repo: "acme/api",
      channel: "stable",
      trackReleases: true,
    };

    expect(releaseImageSourceFromDraft(releaseImageDraftFromSource(source))).toEqual(source);
  });

  it("allows a URL source to use an endpoint, a pin, or both", () => {
    expect(
      releaseImageSourceFromDraft(
        draft({
          mode: "url",
          repo: "stale/repo",
          versionUrl: "https://versions.example.test/latest",
          pinnedVersion: "2.4.1",
        }),
      ),
    ).toEqual({
      artifactKind: "image",
      mode: "url",
      imageTemplate: "ghcr.io/acme/api:{tag}",
      versionUrl: "https://versions.example.test/latest",
      pinnedVersion: "2.4.1",
    });
    const pinned = releaseImageSourceFromDraft(
      draft({ mode: "url", repo: "", versionUrl: "", pinnedVersion: "2.4.1" }),
    );
    expect(pinned.mode).toBe("url");
    if (pinned.mode !== "url") throw new Error("Expected URL mode");
    expect(pinned.pinnedVersion).toBe("2.4.1");
  });

  it("rejects an incomplete or insecure upstream", () => {
    expect(() =>
      releaseImageSourceFromDraft(
        draft({ mode: "url", repo: "", versionUrl: "", pinnedVersion: "" }),
      ),
    ).toThrow("version URL or pin");
    expect(() =>
      releaseImageSourceFromDraft(
        draft({ mode: "url", repo: "", versionUrl: "http://versions.test/latest" }),
      ),
    ).toThrow("HTTPS");
    expect(() =>
      releaseImageSourceFromDraft(
        draft({ mode: "url", repo: "", versionUrl: "https://user:token@versions.test/latest" }),
      ),
    ).toThrow("embedded credentials");
  });

  it("uses the runtime image-template validator", () => {
    expect(() =>
      releaseImageSourceFromDraft(draft({ imageTemplate: "ghcr.io/acme/{tag}:latest" })),
    ).toThrow("only in the image tag");
    expect(() =>
      releaseImageSourceFromDraft(draft({ imageTemplate: "ghcr.io/acme/api:latest" })),
    ).toThrow("must contain {version} or {tag}");
  });
});
