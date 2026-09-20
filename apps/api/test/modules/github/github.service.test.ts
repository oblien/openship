import { beforeEach, describe, expect, it, vi } from "vitest";

const { githubFetch, compareCache } = vi.hoisted(() => ({
  githubFetch: vi.fn(),
  compareCache: new Map<string, unknown>(),
}));

vi.mock("@repo/platform/engine/modules/github/github.auth", () => ({
  githubFetch,
  getUserStatus: vi.fn(),
  getUserInstallations: vi.fn(),
  mapAccounts: vi.fn(),
  getGitHubAuthMode: vi.fn(),
}));

vi.mock("@repo/platform/engine/modules/github/github.local-auth", () => ({
  getLocalGhStatus: vi.fn(),
}));

vi.mock("@repo/platform/engine/lib/cache-store/index", () => ({
  cacheStore: vi.fn(async () => ({
    name: "memory",
    get: async (key: string) => compareCache.get(key) ?? null,
    set: async (key: string, value: unknown) => {
      compareCache.set(key, value);
    },
    delete: async (key: string) => {
      compareCache.delete(key);
    },
    invalidateByPrefix: async (prefix: string) => {
      for (const key of compareCache.keys()) {
        if (key.startsWith(prefix)) compareCache.delete(key);
      }
    },
    dispose: async () => {},
  })),
}));

vi.mock("@repo/platform/engine/config/env", () => ({
  env: {},
  runtimeTarget: { id: "local" },
}));

import { compareCommits, listRepositoryTree } from "@repo/platform/engine/modules/github/github.service";
import type { RequestContext } from "../../../src/lib/request-context";

const ctx = { organizationId: "org_compare_cache" } as RequestContext;

function createFile(name: string, path: string) {
  return {
    name,
    path,
    sha: `${path}-sha`,
    size: 1,
    type: "file" as const,
    download_url: null,
  };
}

function createDir(name: string, path: string) {
  return {
    name,
    path,
    sha: `${path}-sha`,
    size: 0,
    type: "dir" as const,
    download_url: null,
  };
}

describe("listRepositoryTree", () => {
  beforeEach(() => {
    githubFetch.mockReset();
  });

  it("falls back to repository contents when the recursive git tree is truncated", async () => {
    githubFetch.mockImplementation(async ({ url }: { url: string }) => {
      if (url.includes("/git/trees/")) {
        return {
          sha: "tree-sha",
          truncated: true,
          tree: [{ path: "apps", mode: "040000", type: "tree", sha: "apps-sha", url: "" }],
        };
      }

      if (url.endsWith("/contents/")) {
        return [createDir("apps", "apps"), createFile("package.json", "package.json")];
      }

      if (url.endsWith("/contents/apps")) {
        return [createDir("web", "apps/web")];
      }

      if (url.endsWith("/contents/apps/web")) {
        return [createFile("package.json", "apps/web/package.json")];
      }

      throw new Error(`Unexpected URL ${url}`);
    });

    const tree = await listRepositoryTree("user-1", "openship", "repo", { branch: "main" });

    expect(tree).toEqual([
      { path: "apps", type: "dir" },
      { path: "package.json", type: "file" },
      { path: "apps/web", type: "dir" },
      { path: "apps/web/package.json", type: "file" },
    ]);
    expect(githubFetch).toHaveBeenCalledTimes(4);
  });
});

describe("compareCommits", () => {
  beforeEach(() => {
    githubFetch.mockReset();
    compareCache.clear();
  });

  it("includes both sides of renames and reuses an immutable comparison", async () => {
    githubFetch.mockResolvedValue({
      files: [
        {
          filename: "services/client/new.ts",
          previous_filename: "services/backend/old.ts",
        },
      ],
    });
    const base = "1111111111111111111111111111111111111111";
    const head = "2222222222222222222222222222222222222222";

    const first = await compareCommits(ctx, "oblien", "openship", base, head);
    const second = await compareCommits(ctx, "oblien", "openship", base, head);

    expect(first).toEqual({
      files: ["services/client/new.ts", "services/backend/old.ts"],
      truncated: false,
    });
    expect(second).toEqual(first);
    expect(githubFetch).toHaveBeenCalledTimes(1);
  });

  it("marks GitHub's 300-file response cap as truncated", async () => {
    githubFetch.mockResolvedValue({
      files: Array.from({ length: 300 }, (_, i) => ({ filename: `sibling/file-${i}.ts` })),
    });

    const result = await compareCommits(
      ctx,
      "oblien",
      "openship",
      "3333333333333333333333333333333333333333",
      "4444444444444444444444444444444444444444",
    );

    expect(result).toMatchObject({ truncated: true });
    expect(result?.files).toHaveLength(300);
  });

  it("coalesces concurrent comparisons for the same immutable commit pair", async () => {
    let release: (value: { files: Array<{ filename: string }> }) => void = () => {};
    githubFetch.mockReturnValue(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    const base = "5555555555555555555555555555555555555555";
    const head = "6666666666666666666666666666666666666666";

    const first = compareCommits(ctx, "oblien", "openship", base, head);
    const second = compareCommits(ctx, "oblien", "openship", base, head);
    await vi.waitFor(() => expect(githubFetch).toHaveBeenCalledTimes(1));
    release({ files: [{ filename: "services/backend/index.ts" }] });

    await expect(Promise.all([first, second])).resolves.toEqual([
      { files: ["services/backend/index.ts"], truncated: false },
      { files: ["services/backend/index.ts"], truncated: false },
    ]);
    expect(githubFetch).toHaveBeenCalledTimes(1);
  });
});
