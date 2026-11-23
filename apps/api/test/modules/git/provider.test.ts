import { describe, expect, it, vi, afterEach } from "vitest";
import { createGitReader } from "@repo/platform/engine/modules/deployments/project-reader";
import {
  assertProjectRepositoryAccess,
  getGitProvider,
  gitRepository,
  projectRepositoryRef,
} from "@repo/platform/engine/modules/git/provider";
import { cloneOnServerAvailable } from "@repo/platform/engine/modules/git/clone-credentials";
import type { ExecutionContext } from "@repo/platform";
import type { GitRepository } from "@repo/platform/engine/modules/git/types";

afterEach(() => vi.restoreAllMocks());

describe("Git provider boundary", () => {
  it("keeps full namespaces and the explicit provider when adapting persisted projects", () => {
    expect(
      projectRepositoryRef({ gitProvider: "future", gitOwner: "group/team", gitRepo: "app" }),
    ).toEqual({ provider: "future", namespace: "group/team", name: "app" });
    expect(projectRepositoryRef({ gitOwner: "acme", gitRepo: "app" }).provider).toBe("github");
    expect(() => projectRepositoryRef({ gitProvider: "local" })).toThrow(
      "no longer has a repository",
    );
  });

  it.each(["local", "upload", "release"])(
    "does not apply Git credentials to a %s source with retained repository metadata",
    async (provider) => {
      const fetch = vi.spyOn(globalThis, "fetch");
      await assertProjectRepositoryAccess({} as ExecutionContext, {
        gitProvider: provider,
        gitOwner: "acme",
        gitRepo: "app",
      });
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it.each(["unknown", "bitbucket", "", "__proto__"])(
    "does not borrow GitHub authority for %j",
    (provider) => {
      const fetch = vi.spyOn(globalThis, "fetch");
      expect(() => getGitProvider(provider)).toThrow("not supported");
      expect(() =>
        gitRepository({} as ExecutionContext, { provider, namespace: "acme", name: "app" }),
      ).toThrow("not supported");
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it("reads provider-neutral files at one immutable revision and shares one tree read", async () => {
    const files = {
      "package.json": '{"scripts":{"start":"node index.js"}}',
      "broken.json": "not json",
    };
    const readFile = vi.fn(async (path: string) => {
      if (!(path in files)) throw new Error("missing file");
      return {
        sha: "blob",
        size: 40,
        content: files[path as keyof typeof files],
        downloadUrl: null,
      };
    });
    const tree = vi.fn(async () => [{ path: "package.json", type: "file" as const }]);
    // No GitHub response fields, credentials or API methods are needed by detection.
    const repository = {
      ref: { provider: "fixture", namespace: "group/team", name: "app" },
      file: readFile,
      tree,
      files: vi.fn(async () => [{ name: "package.json", type: "file" as const }]),
    } as unknown as GitRepository;
    const reader = createGitReader(repository, "immutable-commit");
    expect(await reader.readJson("package.json")).toEqual({ scripts: { start: "node index.js" } });
    expect(await reader.readJson("broken.json")).toBeUndefined();
    expect(await reader.readText("absent")).toBeUndefined();
    expect(await reader.listDirectory("")).toEqual([{ name: "package.json", type: "file" }]);
    expect(readFile).toHaveBeenCalledWith("package.json", "immutable-commit");
    expect(await Promise.all([reader.listTree(), reader.listTree()])).toEqual([
      [{ path: "package.json", type: "file" }],
      [{ path: "package.json", type: "file" }],
    ]);
    expect(tree).toHaveBeenCalledOnce();
    expect(tree).toHaveBeenCalledWith("immutable-commit");
  });

  it("keeps an API-host credential off the target even though a token was resolved", () => {
    expect(cloneOnServerAvailable({ token: "local-only", apiHostFallback: true }).available).toBe(
      false,
    );
    expect(cloneOnServerAvailable({ token: "repository-scoped" }).available).toBe(true);
    expect(cloneOnServerAvailable({ anonymous: true }).available).toBe(true);
  });
});
