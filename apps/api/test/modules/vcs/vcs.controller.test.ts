import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import { vcsRoutes } from "../../../src/modules/vcs/vcs.routes";
import { VcsStrategyFactory } from "../../../src/modules/vcs/vcs.factory";
import { VcsProviderStrategy } from "../../../src/modules/vcs/vcs.strategy";
import { getRequestContext } from "../../../src/lib/request-context";
import { AppError } from "@repo/core";

vi.mock("../../../src/lib/request-context", () => ({
  getRequestContext: vi.fn(() => ({
    userId: "user-1",
    organizationId: "org-1",
  })),
}));

vi.mock("../../../src/middleware/auth", () => ({
  authMiddleware: async (c: any, next: any) => next(),
}));

vi.mock("../../../src/middleware/rate-limiter", () => ({
  rateLimiterFor: () => async (c: any, next: any) => next(),
}));

vi.mock("../../../src/lib/route-permission", async (importOriginal) => {
  const actual = await importOriginal<any>();
  return {
    ...actual,
    requirePermission: () => async (c: any, next: any) => {
      // simulate permission stash
      c.set("sourcePath", c.req.query("path") || undefined);
      c.set("sourceReadPaths", ["dir", "dir/file1.txt", ""]);
      await next();
    },
    registerRoute: vi.fn(),
  };
});

describe("VCS Controller", () => {
  let app: Hono;
  let mockStrategy: any;

  beforeEach(() => {
    vi.clearAllMocks();
    app = new Hono();
    // Mount the secureRouter
    app.route("/api/vcs", vcsRoutes);

    app.onError((err, c) => {
      
      if (err instanceof AppError) {
        return c.json({ error: err.message, code: (err as any).code }, (err as any).statusCode || 400);
      }
      return c.json({ error: err.message }, 500);
    });

    mockStrategy = {
      getRepository: vi.fn(),
      getFileContent: vi.fn(),
      listFiles: vi.fn(),
      getTree: vi.fn(),
      listRepositories: vi.fn(),
      listBranches: vi.fn(),
      getCloneToken: vi.fn(),
      listWebhooks: vi.fn(),
      registerWebhook: vi.fn(),
      deleteWebhook: vi.fn(),
    };

    vi.spyOn(VcsStrategyFactory, "getStrategy").mockReturnValue(mockStrategy as unknown as VcsProviderStrategy);
  });

  it("returns 404 client error for unknown provider", async () => {
    const res = await app.request("/api/vcs/unknown-provider/repos/owner1/repo1");
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body).toEqual({ error: "Unknown VCS provider: unknown-provider", code: "NOT_FOUND" });
  });

  it("getRepo?branches=true passes opts to strategy", async () => {
    mockStrategy.getRepository.mockResolvedValue({ name: "repo1" });
    const res = await app.request("/api/vcs/github/repos/owner1/repo1?branches=true");
    expect(res.status).toBe(200);
    expect(mockStrategy.getRepository).toHaveBeenCalledWith(
      expect.anything(),
      "owner1",
      "repo1",
      { withBranches: true }
    );
  });

  it("getFile parses JSON when path ends in .json", async () => {
    mockStrategy.getFileContent.mockResolvedValue({ content: { key: "value" } });
    const res = await app.request("/api/vcs/github/repos/owner1/repo1/file?path=config.json");
    expect(res.status).toBe(200);
    expect(mockStrategy.getFileContent).toHaveBeenCalledWith(
      expect.anything(),
      "owner1",
      "repo1",
      "config.json",
      { branch: undefined, json: true }
    );
  });

  it("listFiles on a directory path returns entries as array", async () => {
    mockStrategy.listFiles.mockResolvedValue([{ name: "file1.txt", path: "dir/file1.txt", type: "file" }]);
    const res = await app.request("/api/vcs/github/repos/owner1/repo1/files?path=dir");
    expect(res.status).toBe(200);
    expect(mockStrategy.listFiles).toHaveBeenCalledWith(
      expect.anything(),
      "owner1",
      "repo1",
      { branch: undefined, path: "dir" }
    );
    const body = await res.json();
    expect(body.data).toEqual([{ name: "file1.txt", path: "dir/file1.txt", type: "file" }]);
  });
});
