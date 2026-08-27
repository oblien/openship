import { describe, expect, it } from "vitest";

import {
  RELEASE_ARTIFACT_KINDS,
  SOURCE_PROVIDERS,
  isReleaseProvider,
  releaseArtifactKind,
  renderAssetName,
  renderReleaseImage,
  validateImageReference,
  validateReleaseRepository,
  validateReleaseVersionUrl,
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

describe("releaseArtifactKind", () => {
  it("exposes the shared persisted values", () => {
    expect(RELEASE_ARTIFACT_KINDS).toEqual(["archive", "image"]);
  });

  it("keeps legacy and explicitly archived sources on the archive path", () => {
    expect(releaseArtifactKind(undefined)).toBe("archive");
    expect(releaseArtifactKind(null)).toBe("archive");
    expect(releaseArtifactKind({})).toBe("archive");
    expect(releaseArtifactKind({ artifactKind: "archive" })).toBe("archive");
  });

  it("requires an explicit image discriminator", () => {
    expect(releaseArtifactKind({ artifactKind: "image" })).toBe("image");
    // imageTemplate alone must not reinterpret a legacy archive row.
    const legacySource = {
      artifactKind: undefined,
      imageTemplate: "ghcr.io/acme/api:{tag}",
    };
    expect(releaseArtifactKind(legacySource)).toBe("archive");
  });

  it("rejects corrupt persisted discriminators instead of silently downloading an archive", () => {
    expect(() =>
      releaseArtifactKind({ artifactKind: "images" } as unknown as Parameters<
        typeof releaseArtifactKind
      >[0]),
    ).toThrow(/Unknown release artifact kind/);
  });
});

describe("validateImageReference", () => {
  it.each([
    "postgres:16-alpine",
    "library/postgres:16",
    "ghcr.io/acme/api:v1.2.3",
    "GHCR.IO/acme/api:v1.2.3",
    "registry.example.com:5000/team/api:release_1.2.3",
    "localhost:5000/team/api:dev",
    "[::1]/team/api:dev",
    "[2001:DB8::1]:5000/team/api:dev",
    "[2001:db8::1]:5000/team/api:dev",
    `ghcr.io/acme/api@sha256:${"a".repeat(64)}`,
    `ghcr.io/acme/api:v1@sha256:${"b".repeat(64)}`,
  ])("accepts a concrete distribution reference: %s", (ref) => {
    expect(validateImageReference(ref)).toBeNull();
  });

  it.each([
    ["", /cannot be empty/],
    [" ghcr.io/acme/api:v1", /surrounding whitespace/],
    ["ghcr.io/acme/api:v 1", /whitespace/],
    ["https://ghcr.io/acme/api:v1", /URL scheme/],
    ["ghcr.io/Acme/api:v1", /lowercase/],
    ["ghcr.io/acme//api:v1", /empty repository path component/],
    ["ghcr.io/_acme/api:v1", /invalid repository path/],
    ["registry.example.com:0/acme/api:v1", /outside 1-65535/],
    ["registry.example.com:not-a-port/acme/api:v1", /non-numeric registry port/],
    ["[:::]:5000/acme/api:v1", /invalid bracketed IPv6/],
    ["[2001:db8::1::2]:5000/acme/api:v1", /invalid bracketed IPv6/],
    ["[1:2:3:4:5:6:7:8:9]:5000/acme/api:v1", /invalid bracketed IPv6/],
    ["[::ffff:192.0.2.1]:5000/acme/api:v1", /invalid bracketed IPv6/],
    ["ghcr.io/acme/api:", /empty tag/],
    ["ghcr.io/acme/api:-v1", /invalid tag/],
    [`ghcr.io/acme/api:${"a".repeat(129)}`, /invalid tag/],
    ["ghcr.io/acme/api@sha256:abcd", /expected 64 hexadecimal/],
    [`ghcr.io/acme/api@sha256:${"g".repeat(64)}`, /expected 64 hexadecimal/],
    ["ghcr.io/acme/api@sha256:abc@sha256:def", /more than one digest separator/],
  ])("rejects an unsafe or malformed reference: %s", (ref, message) => {
    expect(validateImageReference(ref)).toMatch(message);
  });
});

describe("validateReleaseVersionUrl", () => {
  it("accepts a public HTTPS version endpoint", () => {
    expect(validateReleaseVersionUrl("https://versions.example.com/latest.json")).toBeNull();
  });

  it.each([
    ["", /cannot be empty/],
    [" http://versions.example.com/latest", /surrounding whitespace/],
    ["http://versions.example.com/latest", /must use HTTPS/],
    ["https://user:token@versions.example.com/latest", /embedded credentials/],
    ["not a URL", /valid HTTPS URL/],
  ])("rejects an unsafe or malformed version endpoint: %s", (value, message) => {
    expect(validateReleaseVersionUrl(value)).toMatch(message);
  });
});

describe("validateReleaseRepository", () => {
  it.each(["oblien/openship", "Acme-Inc/api.v2", "a/x"])(
    "accepts a GitHub owner/repository identity: %s",
    (value) => {
      expect(validateReleaseRepository(value)).toBeNull();
    },
  );

  it.each([
    ["", /owner\/repository/],
    ["acme", /owner\/repository/],
    ["acme/repo/extra", /owner\/repository/],
    ["../repo", /invalid owner/],
    ["acme/..", /invalid owner/],
    ["-acme/repo", /invalid owner/],
    ["acme-/repo", /invalid owner/],
    [" acme/repo", /surrounding whitespace/],
  ])("rejects an unsafe or malformed repository identity: %s", (value, message) => {
    expect(validateReleaseRepository(value)).toMatch(message);
  });
});

describe("renderReleaseImage", () => {
  it("renders normalized {version} and preserves the upstream {tag}", () => {
    expect(
      renderReleaseImage("ghcr.io/acme/api:{version}", {
        version: "v1.2.3",
        tag: "v1.2.3",
      }),
    ).toBe("ghcr.io/acme/api:1.2.3");
    expect(
      renderReleaseImage("ghcr.io/acme/api:{tag}", {
        version: "1.2.3",
        tag: "release-1.2.3",
      }),
    ).toBe("ghcr.io/acme/api:release-1.2.3");
    expect(
      renderReleaseImage("ghcr.io/acme/api:{version}", {
        version: "V1.2.3",
        tag: "V1.2.3",
      }),
    ).toBe("ghcr.io/acme/api:1.2.3");
  });

  it("allows literals and repeated supported placeholders inside the tag", () => {
    expect(
      renderReleaseImage("ghcr.io/acme/api:release-{version}-{version}-{tag}", {
        version: "v2.0.0",
        tag: "stable",
      }),
    ).toBe("ghcr.io/acme/api:release-2.0.0-2.0.0-stable");
  });

  it.each([
    ["ghcr.io/acme/api:latest", /must contain \{version\} or \{tag\}/],
    ["ghcr.io/{tag}/api:latest", /only in the image tag/],
    ["{version}.example.com/acme/api:latest", /only in the image tag/],
    ["ghcr.io/acme/api@sha256:{version}", /must use a tag, not a digest/],
    ["ghcr.io/acme/api:{channel}", /unknown placeholder/],
    ["ghcr.io/acme/api:{version", /malformed placeholder braces/],
    ["ghcr.io/acme/api-{version}", /explicit image tag/],
  ])("rejects an unsafe or ambiguous template: %s", (template, message) => {
    expect(() => renderReleaseImage(template, { version: "1.2.3", tag: "v1.2.3" })).toThrow(
      message,
    );
  });

  it("validates values after rendering", () => {
    expect(() =>
      renderReleaseImage("ghcr.io/acme/api:{tag}", {
        version: "1.2.3",
        tag: "release/1.2.3",
      }),
    ).toThrow(/invalid tag|invalid repository path/);
  });

  it("never interprets placeholders embedded in resolved release metadata", () => {
    expect(() =>
      renderReleaseImage("ghcr.io/acme/api:{version}", {
        version: "v1{tag}",
        tag: "unexpected",
      }),
    ).toThrow(/invalid tag/);
    expect(() =>
      renderReleaseImage("ghcr.io/acme/api:{tag}", {
        version: "1.2.3",
        tag: "release-{version}",
      }),
    ).toThrow(/invalid tag/);
  });

  it("requires both resolved release identities", () => {
    expect(() =>
      renderReleaseImage("ghcr.io/acme/api:{version}", { version: "", tag: "v1.2.3" }),
    ).toThrow(/version cannot be empty/);
    expect(() =>
      renderReleaseImage("ghcr.io/acme/api:{tag}", { version: "1.2.3", tag: "" }),
    ).toThrow(/tag cannot be empty/);
  });
});
