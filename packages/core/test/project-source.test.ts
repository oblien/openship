import { describe, expect, it } from "vitest";

import {
  SOURCE_PROVIDERS,
  isReleaseProvider,
  parseGitRepoUrl,
  buildGitUrl,
  renderAssetName,
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

  it("azure is a member of SOURCE_PROVIDERS", () => {
    expect(SOURCE_PROVIDERS).toContain("azure");
  });
});

describe("parseGitRepoUrl", () => {
  it("parses a GitHub HTTPS URL", () => {
    expect(parseGitRepoUrl("https://github.com/acme/widgets")).toEqual({
      provider: "github",
      owner: "acme",
      repo: "widgets",
    });
  });

  it("strips .git and ignores a GitHub tree path", () => {
    expect(parseGitRepoUrl("https://github.com/acme/widgets.git")).toEqual({
      provider: "github",
      owner: "acme",
      repo: "widgets",
    });
    expect(parseGitRepoUrl("https://github.com/acme/widgets/tree/main")).toEqual({
      provider: "github",
      owner: "acme",
      repo: "widgets",
    });
  });

  it("parses a GitHub SSH URL", () => {
    expect(parseGitRepoUrl("git@github.com:acme/widgets.git")).toEqual({
      provider: "github",
      owner: "acme",
      repo: "widgets",
    });
  });

  it("parses Azure DevOps HTTPS", () => {
    expect(parseGitRepoUrl("https://dev.azure.com/myorg/myproject/_git/myrepo")).toEqual({
      provider: "azure",
      owner: "myorg",
      project: "myproject",
      repo: "myrepo",
    });
  });

  it("parses Azure DevOps old visualstudio.com host", () => {
    expect(parseGitRepoUrl("https://myorg.visualstudio.com/myproject/_git/myrepo")).toEqual({
      provider: "azure",
      owner: "myorg",
      project: "myproject",
      repo: "myrepo",
    });
  });

  it("parses Azure DevOps SSH (clone still uses HTTPS)", () => {
    expect(parseGitRepoUrl("git@ssh.dev.azure.com:v3/myorg/myproject/myrepo")).toEqual({
      provider: "azure",
      owner: "myorg",
      project: "myproject",
      repo: "myrepo",
    });
  });

  it("strips an embedded PAT from an Azure clone URL", () => {
    expect(
      parseGitRepoUrl("https://:secret@dev.azure.com/myorg/myproject/_git/myrepo"),
    ).toEqual({
      provider: "azure",
      owner: "myorg",
      project: "myproject",
      repo: "myrepo",
    });
  });

  it("returns null for unknown hosts", () => {
    expect(parseGitRepoUrl("https://gitlab.com/acme/widgets")).toBeNull();
    expect(parseGitRepoUrl("not-a-url")).toBeNull();
    expect(parseGitRepoUrl("")).toBeNull();
    expect(parseGitRepoUrl(null)).toBeNull();
  });
});

describe("buildGitUrl", () => {
  it("builds a GitHub clone URL", () => {
    expect(buildGitUrl("github", "acme", "widgets")).toBe("https://github.com/acme/widgets.git");
  });

  it("builds an Azure DevOps HTTPS clone URL without embedding a token", () => {
    expect(buildGitUrl("azure", "myorg", "myrepo", "myproject")).toBe(
      "https://dev.azure.com/myorg/myproject/_git/myrepo",
    );
    expect(buildGitUrl("azure", "myorg", "myrepo", "myproject")).not.toMatch(/@/);
  });

  it("refuses Azure without a project", () => {
    expect(() => buildGitUrl("azure", "myorg", "myrepo")).toThrow(/project/i);
  });

  it("round-trips Azure HTTPS through parse + build", () => {
    const url = "https://dev.azure.com/myorg/myproject/_git/myrepo";
    const parsed = parseGitRepoUrl(url)!;
    expect(buildGitUrl(parsed.provider, parsed.owner, parsed.repo, parsed.project)).toBe(url);
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
