import { describe, expect, it } from "vitest";

import {
  decodeSlug,
  encodeGitSourceSlug,
  encodeLocalSlug,
  encodeProjectSlug,
  encodeProviderRepoSlug,
  encodeRepoSlug,
  encodeUploadSlug,
  extractOwnerRepoFromUrl,
} from "./repoSlug";

describe("encodeRepoSlug / decodeSlug round trip", () => {
  it("round-trips a plain owner/repo pair", () => {
    expect(decodeSlug(encodeRepoSlug("acme", "widgets"))).toEqual({
      kind: "repo",
      owner: "acme",
      repo: "widgets",
    });
  });

  it("produces a URL-safe slug with no +, /, or = characters", () => {
    // base64 of this input contains all three standard-alphabet characters
    // that base64url must translate away.
    const slug = encodeRepoSlug("some org~!", "repo name/with/slashes?");
    expect(slug).not.toMatch(/[+/=]/);
  });

  it("drops everything after the first '/' in the repo name on round trip", () => {
    // The legacy encoding just joins "owner/repo" and decodes by splitting
    // on the first two '/'-separated segments, so a repo name that itself
    // contains a slash does not survive the round trip intact.
    const slug = encodeRepoSlug("acme", "widgets/extra");
    expect(decodeSlug(slug)).toEqual({ kind: "repo", owner: "acme", repo: "widgets" });
  });
});

describe("encodeLocalSlug / decodeSlug round trip", () => {
  it("round-trips a local path", () => {
    expect(decodeSlug(encodeLocalSlug("/Users/me/project"))).toEqual({
      kind: "local",
      path: "/Users/me/project",
    });
  });

  it("rejects an empty path", () => {
    expect(decodeSlug(encodeLocalSlug(""))).toBeNull();
  });

  it("keeps a whitespace-only path (only the empty string is treated as falsy)", () => {
    expect(decodeSlug(encodeLocalSlug("   "))).toEqual({ kind: "local", path: "   " });
  });
});

describe("encodeUploadSlug / decodeSlug round trip", () => {
  it("round-trips an upload session id", () => {
    expect(decodeSlug(encodeUploadSlug("sess-123"))).toEqual({
      kind: "upload",
      sessionId: "sess-123",
    });
  });

  it("rejects an empty session id", () => {
    expect(decodeSlug(encodeUploadSlug(""))).toBeNull();
  });
});

describe("encodeProjectSlug / decodeSlug round trip", () => {
  it("round-trips a project id", () => {
    expect(decodeSlug(encodeProjectSlug("proj-abc"))).toEqual({
      kind: "project",
      projectId: "proj-abc",
    });
  });

  it("rejects an empty project id", () => {
    expect(decodeSlug(encodeProjectSlug(""))).toBeNull();
  });
});

describe("decodeSlug legacy owner/repo format", () => {
  const b64url = (s: string) =>
    Buffer.from(s).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");

  it("decodes a plain 'owner/repo' payload with no prefix", () => {
    expect(decodeSlug(b64url("acme/widgets"))).toEqual({
      kind: "repo",
      owner: "acme",
      repo: "widgets",
    });
  });

  it("silently discards everything past the second segment", () => {
    expect(decodeSlug(b64url("owner/repo/extra"))).toEqual({
      kind: "repo",
      owner: "owner",
      repo: "repo",
    });
  });

  it("rejects a payload with no '/' at all", () => {
    expect(decodeSlug(b64url("owner-only"))).toBeNull();
  });
});

describe("decodeSlug repo:v2 format", () => {
  const encodeV2 = (payload: unknown) =>
    Buffer.from("repo:v2:" + JSON.stringify(payload))
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=/g, "");

  it("decodes owner/repo plus optional branch and projectId", () => {
    const slug = encodeV2({ owner: "acme", repo: "widgets", branch: "main", projectId: "p1" });
    expect(decodeSlug(slug)).toEqual({
      kind: "repo",
      owner: "acme",
      repo: "widgets",
      branch: "main",
      projectId: "p1",
    });
  });

  it("omits branch and projectId when absent rather than including them as undefined", () => {
    const slug = encodeV2({ owner: "acme", repo: "widgets" });
    const result = decodeSlug(slug);
    expect(result).toEqual({ kind: "repo", owner: "acme", repo: "widgets" });
    expect(result && "branch" in result).toBe(false);
  });

  it("rejects a payload missing owner", () => {
    expect(decodeSlug(encodeV2({ repo: "widgets" }))).toBeNull();
  });

  it("rejects a payload missing repo", () => {
    expect(decodeSlug(encodeV2({ owner: "acme" }))).toBeNull();
  });

  it("round-trips an Azure org/project/repo via encodeProviderRepoSlug", () => {
    const slug = encodeProviderRepoSlug("azure", "myorg", "myrepo", "myproject");
    expect(decodeSlug(slug)).toEqual({
      kind: "repo",
      owner: "myorg",
      repo: "myrepo",
      provider: "azure",
      project: "myproject",
    });
  });

  it("keeps GitHub on the legacy owner/repo encoding", () => {
    const slug = encodeProviderRepoSlug("github", "acme", "widgets");
    expect(slug).toBe(encodeRepoSlug("acme", "widgets"));
    expect(decodeSlug(slug)).toEqual({ kind: "repo", owner: "acme", repo: "widgets" });
  });

  it("encodeGitSourceSlug routes Azure through v2", () => {
    const slug = encodeGitSourceSlug({
      provider: "azure",
      owner: "myorg",
      repo: "myrepo",
      project: "myproject",
    });
    expect(decodeSlug(slug)).toMatchObject({ provider: "azure", project: "myproject" });
  });

  it("rejects an Azure v2 payload missing project", () => {
    expect(decodeSlug(encodeV2({ owner: "myorg", repo: "myrepo", provider: "azure" }))).toBeNull();
  });

  it("rejects malformed JSON after the prefix", () => {
    const slug = Buffer.from("repo:v2:{not json")
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=/g, "");
    expect(decodeSlug(slug)).toBeNull();
  });

  it("ignores a non-string branch instead of throwing", () => {
    const slug = encodeV2({ owner: "acme", repo: "widgets", branch: 123 });
    expect(decodeSlug(slug)).toEqual({ kind: "repo", owner: "acme", repo: "widgets" });
  });
});

describe("decodeSlug invalid input", () => {
  it("returns null for an empty string", () => {
    expect(decodeSlug("")).toBeNull();
  });

  it("returns null for a slug that is not valid base64", () => {
    expect(decodeSlug("!!!not-base64!!!")).toBeNull();
  });
});

describe("extractOwnerRepoFromUrl", () => {
  it("parses a plain HTTPS URL", () => {
    expect(extractOwnerRepoFromUrl("https://github.com/acme/widgets")).toEqual({
      owner: "acme",
      repo: "widgets",
      provider: "github",
    });
  });

  it("strips a trailing .git suffix", () => {
    expect(extractOwnerRepoFromUrl("https://github.com/acme/widgets.git")).toEqual({
      owner: "acme",
      repo: "widgets",
      provider: "github",
    });
  });

  it("parses an SSH URL", () => {
    expect(extractOwnerRepoFromUrl("git@github.com:acme/widgets.git")).toEqual({
      owner: "acme",
      repo: "widgets",
      provider: "github",
    });
  });

  it("keeps a dot inside the repo name that isn't the .git suffix", () => {
    expect(extractOwnerRepoFromUrl("https://github.com/acme/widgets.js")).toEqual({
      owner: "acme",
      repo: "widgets.js",
      provider: "github",
    });
  });

  it("returns null for a non-GitHub host", () => {
    expect(extractOwnerRepoFromUrl("https://gitlab.com/acme/widgets")).toBeNull();
  });

  it("strips a trailing slash after the repo name", () => {
    expect(extractOwnerRepoFromUrl("https://github.com/acme/widgets/")).toEqual({
      owner: "acme",
      repo: "widgets",
      provider: "github",
    });
  });

  it("takes only owner/repo from a GitHub tree URL", () => {
    expect(extractOwnerRepoFromUrl("https://github.com/acme/widgets/tree/main")).toEqual({
      owner: "acme",
      repo: "widgets",
      provider: "github",
    });
  });

  it("parses an Azure DevOps HTTPS URL", () => {
    expect(extractOwnerRepoFromUrl("https://dev.azure.com/myorg/myproject/_git/myrepo")).toEqual({
      owner: "myorg",
      repo: "myrepo",
      provider: "azure",
      project: "myproject",
    });
  });

  it("parses a visualstudio.com Azure URL", () => {
    expect(
      extractOwnerRepoFromUrl("https://myorg.visualstudio.com/myproject/_git/myrepo"),
    ).toEqual({
      owner: "myorg",
      repo: "myrepo",
      provider: "azure",
      project: "myproject",
    });
  });

  it("parses Azure SSH and never embeds a token", () => {
    expect(
      extractOwnerRepoFromUrl("git@ssh.dev.azure.com:v3/myorg/myproject/myrepo"),
    ).toEqual({
      owner: "myorg",
      repo: "myrepo",
      provider: "azure",
      project: "myproject",
    });
    expect(
      extractOwnerRepoFromUrl("https://:secret@dev.azure.com/myorg/myproject/_git/myrepo"),
    ).toEqual({
      owner: "myorg",
      repo: "myrepo",
      provider: "azure",
      project: "myproject",
    });
  });
});
