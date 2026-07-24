import { describe, it, expect } from "vitest";
import {
  sanitizeGitSource,
  sanitizeSubpaths,
  sanitizeVolumeStrategies,
  sanitizeServiceEnv,
} from "./migration-input";

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
