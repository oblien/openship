import { describe, expect, it } from "vitest";

import {
  SOURCE_PROVIDERS,
  isReleaseProvider,
  renderAssetName,
  renderImageTemplate,
} from "../src/project-source";

describe("isReleaseProvider", () => {
  it("is true only for the exact 'release' provider", () => {
    expect(isReleaseProvider("release")).toBe(true);
    expect(isReleaseProvider("github")).toBe(false);
    expect(isReleaseProvider("local")).toBe(false);
    expect(isReleaseProvider("upload")).toBe(false);
    expect(isReleaseProvider(null)).toBe(false);
    expect(isReleaseProvider(undefined)).toBe(false);
    expect(isReleaseProvider("")).toBe(false);
  });

  it("release is a member of SOURCE_PROVIDERS", () => {
    expect(SOURCE_PROVIDERS).toContain("release");
  });
});

describe("renderAssetName", () => {
  it("substitutes {tag}/{version}/{os}/{arch}", () => {
    expect(
      renderAssetName("openship-{tag}-{os}-{arch}.tar.gz", {
        version: "1.2.3",
        os: "darwin",
        arch: "arm64",
      }),
    ).toBe("openship-v1.2.3-darwin-arm64.tar.gz");
  });

  it("defaults os→linux and arch→amd64", () => {
    expect(renderAssetName("app-{os}-{arch}.tgz", { version: "0.4.0" })).toBe(
      "app-linux-amd64.tgz",
    );
  });

  it("tolerates a leading 'v' on the version (tag stays single-v, version strips it)", () => {
    expect(renderAssetName("{tag}|{version}", { version: "v2.0.0" })).toBe("v2.0.0|2.0.0");
  });

  it("replaces every occurrence of a placeholder", () => {
    expect(renderAssetName("{version}/{version}", { version: "9.9.9" })).toBe("9.9.9/9.9.9");
  });

  it("refuses a template with an unknown placeholder, naming it", () => {
    // Silently kept, `{platform}` reaches the download URL and the operator gets
    // "release dist not found at <cache dir>" — a message about the wrong thing.
    expect(() => renderAssetName("app-{platform}-{arch}.tgz", { version: "1.0.0" })).toThrow(
      /\{platform\}/,
    );
  });

  it("a fully-substituted name with literal braces nowhere left is fine", () => {
    expect(renderAssetName("openship-{tag}-linux-amd64.tar.gz", { version: "0.6.1" })).toBe(
      "openship-v0.6.1-linux-amd64.tar.gz",
    );
  });
});

describe("renderImageTemplate", () => {
  it("substitutes {version} in image template", () => {
    expect(
      renderImageTemplate("ghcr.io/orangecoding/fredy:{version}", { version: "26.7.0" }),
    ).toBe("ghcr.io/orangecoding/fredy:26.7.0");
  });

  it("substitutes {tag} with raw release tag or version", () => {
    expect(
      renderImageTemplate("ghcr.io/orangecoding/fredy:{tag}", { version: "26.7.0", tag: "v26.7.0" }),
    ).toBe("ghcr.io/orangecoding/fredy:v26.7.0");
  });

  it("replaces existing image tag if no placeholder is provided", () => {
    expect(
      renderImageTemplate("ghcr.io/orangecoding/fredy:26.6.0", { version: "26.7.0" }),
    ).toBe("ghcr.io/orangecoding/fredy:26.7.0");
  });

  it("appends version if image ref has no tag", () => {
    expect(
      renderImageTemplate("ghcr.io/orangecoding/fredy", { version: "26.7.0" }),
    ).toBe("ghcr.io/orangecoding/fredy:26.7.0");
  });

  it("handles registry host with port correctly", () => {
    expect(
      renderImageTemplate("registry.example.com:5000/fredy:26.6.0", { version: "26.7.0" }),
    ).toBe("registry.example.com:5000/fredy:26.7.0");
  });

  it("strips leading 'v' from version", () => {
    expect(
      renderImageTemplate("ghcr.io/orangecoding/fredy:{version}", { version: "v26.7.0" }),
    ).toBe("ghcr.io/orangecoding/fredy:26.7.0");
  });

  it("refuses unknown placeholders", () => {
    expect(() =>
      renderImageTemplate("ghcr.io/orangecoding/fredy:{arch}", { version: "26.7.0" }),
    ).toThrow(/\{arch\}/);
  });
});
