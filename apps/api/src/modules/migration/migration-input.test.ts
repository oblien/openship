import { describe, it, expect } from "vitest";
import {
  sanitizeGitSource,
  sanitizeSubpaths,
  sanitizeRenames,
  sanitizeVolumeStrategies,
  sanitizeServiceEnv,
  sanitizeCustomPaths,
  sanitizeRoutes,
} from "./migration-input";

describe("sanitizeCustomPaths", () => {
  it("keeps well-formed absolute source→dest pairs, trimmed", () => {
    expect(
      sanitizeCustomPaths([
        { source: " /a/data ", dest: " /b/data " },
        { source: "/x", dest: "/y" },
      ]),
    ).toEqual([
      { source: "/a/data", dest: "/b/data" },
      { source: "/x", dest: "/y" },
    ]);
  });
  it("drops non-absolute, traversal, and malformed entries", () => {
    expect(
      sanitizeCustomPaths([
        { source: "rel/path", dest: "/ok" },
        { source: "/ok", dest: "rel" },
        { source: "/a/../etc", dest: "/b" },
        { source: "/a", dest: "/b/../c" },
        { source: "/a" },
        "nope",
        null,
      ]),
    ).toBeUndefined();
  });
  it("returns undefined for a non-array / empty", () => {
    expect(sanitizeCustomPaths(undefined)).toBeUndefined();
    expect(sanitizeCustomPaths([])).toBeUndefined();
  });
  it("caps at 50 entries", () => {
    const many = Array.from({ length: 60 }, (_, i) => ({ source: `/s${i}`, dest: `/d${i}` }));
    expect(sanitizeCustomPaths(many)).toHaveLength(50);
  });
});

describe("sanitizeGitSource", () => {
  it("accepts a well-formed GitHub source and trims", () => {
    expect(sanitizeGitSource({ provider: "github", owner: " acme ", repo: " web ", branch: " main " })).toEqual({
      provider: "github",
      owner: "acme",
      repo: "web",
      branch: "main",
    });
  });

  it("omits an empty/whitespace branch", () => {
    expect(sanitizeGitSource({ provider: "github", owner: "acme", repo: "web", branch: "  " })).toEqual({
      provider: "github",
      owner: "acme",
      repo: "web",
    });
  });

  it("rejects non-GitHub providers (v1 GitHub only)", () => {
    expect(sanitizeGitSource({ provider: "gitlab", owner: "acme", repo: "web" })).toBeUndefined();
  });

  it("rejects missing owner or repo", () => {
    expect(sanitizeGitSource({ provider: "github", owner: "", repo: "web" })).toBeUndefined();
    expect(sanitizeGitSource({ provider: "github", owner: "acme", repo: "   " })).toBeUndefined();
  });

  it("rejects non-object / null input", () => {
    expect(sanitizeGitSource(undefined)).toBeUndefined();
    expect(sanitizeGitSource(null)).toBeUndefined();
    expect(sanitizeGitSource("acme/web")).toBeUndefined();
  });
});

describe("sanitizeSubpaths", () => {
  it("keeps non-empty string entries (trimmed) and drops the rest", () => {
    expect(
      sanitizeSubpaths({ web: " services/api ", worker: "", db: 5 as unknown as string }),
    ).toEqual({ web: "services/api" });
  });

  it("returns undefined when nothing survives", () => {
    expect(sanitizeSubpaths({ web: "   " })).toBeUndefined();
    expect(sanitizeSubpaths(undefined)).toBeUndefined();
    expect(sanitizeSubpaths([] as unknown as Record<string, unknown>)).toBeUndefined();
  });
});

describe("sanitizeRenames", () => {
  it("keeps discovered→repo string entries (trimmed), drops non-strings and identity renames", () => {
    expect(
      sanitizeRenames({
        postgres: " db ", // → repo service "db"
        web: "web", // identity → dropped (no rename needed)
        worker: "", // empty → dropped
        cache: 5 as unknown as string, // non-string → dropped
      }),
    ).toEqual({ postgres: "db" });
  });

  it("returns undefined when nothing survives", () => {
    expect(sanitizeRenames({ web: "web", api: "  " })).toBeUndefined();
    expect(sanitizeRenames(undefined)).toBeUndefined();
    expect(sanitizeRenames([] as unknown as Record<string, unknown>)).toBeUndefined();
  });
});

describe("sanitizeVolumeStrategies", () => {
  it("keeps only reuse/copy values", () => {
    expect(
      sanitizeVolumeStrategies({ db: "copy", cache: "reuse", bad: "wipe" as unknown as string }),
    ).toEqual({ db: "copy", cache: "reuse" });
  });

  it("returns undefined when empty", () => {
    expect(sanitizeVolumeStrategies({})).toBeUndefined();
    expect(sanitizeVolumeStrategies(undefined)).toBeUndefined();
  });
});

describe("sanitizeServiceEnv", () => {
  it("keeps string→string env maps per service, dropping non-string values", () => {
    expect(
      sanitizeServiceEnv({
        api: { NODE_ENV: "production", PORT: 3000 as unknown as string, "": "skip" },
        web: { KEY: "v" },
      }),
    ).toEqual({ api: { NODE_ENV: "production" }, web: { KEY: "v" } });
  });

  it("keeps an explicitly-cleared service (empty map = 'remove all env')", () => {
    expect(sanitizeServiceEnv({ api: {} })).toEqual({ api: {} });
  });

  it("returns undefined for non-object / empty input", () => {
    expect(sanitizeServiceEnv(undefined)).toBeUndefined();
    expect(sanitizeServiceEnv({})).toBeUndefined();
    expect(sanitizeServiceEnv({ api: "nope" as unknown as Record<string, unknown> })).toBeUndefined();
  });
});

describe("sanitizeRoutes", () => {
  it("keeps a domain-bearing spec and normalizes a non-root targetPath (fan-out)", () => {
    expect(
      sanitizeRoutes({
        web: { domainType: "custom", customDomain: "API.onvo.me" },
        api: { domainType: "custom", customDomain: "api.onvo.me", targetPath: "v3", exposedPort: 1020 },
      }),
    ).toEqual({
      web: { domainType: "custom", customDomain: "api.onvo.me" },
      api: { domainType: "custom", customDomain: "api.onvo.me", exposedPort: "1020", targetPath: "/v3" },
    });
  });

  it("omits a root ('/') targetPath and rejects `..` traversal → root (no targetPath)", () => {
    expect(sanitizeRoutes({ a: { domainType: "custom", customDomain: "x.com", targetPath: "/" } })).toEqual({
      a: { domainType: "custom", customDomain: "x.com" },
    });
    expect(sanitizeRoutes({ a: { domainType: "custom", customDomain: "x.com", targetPath: "/../etc" } })).toEqual({
      a: { domainType: "custom", customDomain: "x.com" },
    });
  });

  it("drops a spec with no resolvable domain, and returns undefined when nothing is left", () => {
    expect(sanitizeRoutes({ a: { domainType: "free" } })).toBeUndefined();
    expect(sanitizeRoutes(undefined)).toBeUndefined();
  });
});
