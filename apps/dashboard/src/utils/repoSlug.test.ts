import { describe, expect, it } from "vitest";

import {
  decodeSlug,
  encodeLocalSlug,
  encodeProjectSlug,
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

  it("treats a slash in the repo arg as a nested GitLab-style owner path", () => {
    // Encoding joins "owner/repo"; decoding takes the LAST segment as the
    // repo and everything before it as the owner (GitLab nested namespaces).
    const slug = encodeRepoSlug("acme", "widgets/extra");
    expect(decodeSlug(slug)).toEqual({ kind: "repo", owner: "acme/widgets", repo: "extra" });
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

  it("keeps nested path segments as the owner (GitLab namespaces)", () => {
    expect(decodeSlug(b64url("owner/repo/extra"))).toEqual({
      kind: "repo",
      owner: "owner/repo",
      repo: "extra",
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
  it("parses a plain HTTPS GitHub URL", () => {
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

  it("parses an SSH GitHub URL", () => {
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

  it("parses a GitLab HTTPS URL", () => {
    expect(extractOwnerRepoFromUrl("https://gitlab.com/acme/widgets")).toEqual({
      owner: "acme",
      repo: "widgets",
      provider: "gitlab",
    });
  });

  it("parses a nested GitLab namespace", () => {
    expect(extractOwnerRepoFromUrl("https://gitlab.com/group/sub/widgets.git")).toEqual({
      owner: "group/sub",
      repo: "widgets",
      provider: "gitlab",
    });
  });

  it("treats a non-GitHub HTTPS forge URL as GitLab (self-hosted)", () => {
    expect(extractOwnerRepoFromUrl("https://git.example.com/acme/widgets")).toEqual({
      owner: "acme",
      repo: "widgets",
      provider: "gitlab",
    });
  });

  it("returns null when the path has no owner/repo pair", () => {
    expect(extractOwnerRepoFromUrl("https://gitlab.com/only-owner")).toBeNull();
  });

  it("bug: a trailing slash after the repo name is captured as part of the repo", () => {
    // repo becomes "widgets/", not "widgets" — the non-greedy `.+?` still has
    // to consume up to the end of the string since there's no `.git` to stop
    // at, so the trailing slash comes along with it.
    expect(extractOwnerRepoFromUrl("https://github.com/acme/widgets/")).toEqual({
      owner: "acme",
      repo: "widgets/",
      provider: "github",
    });
  });

  it("bug: a GitHub tree/blob URL captures the whole trailing path as the repo name", () => {
    // Pasting a URL to a specific branch or file (a very common copy-paste
    // source) does not extract just the repo name.
    expect(extractOwnerRepoFromUrl("https://github.com/acme/widgets/tree/main")).toEqual({
      owner: "acme",
      repo: "widgets/tree/main",
      provider: "github",
    });
  });
});
