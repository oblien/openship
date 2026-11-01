import { beforeEach, describe, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({ read: vi.fn(), tree: vi.fn() }));
vi.mock("@repo/platform/engine/modules/github/github.service", () => ({
  getFileContent: h.read,
  listRepositoryTree: h.tree,
}));
import { resolveProjectChangeImpact } from "@repo/platform/engine/modules/github/project-change-impact";
import { runWithRequestStore } from "@repo/platform/engine/lib/request-store";
import { parseOpenshipConfig } from "@repo/core";
const ctx = { organizationId: "org", userId: "owner" } as any;
const project = {
  id: "project",
  rootDirectory: "apps/storefront",
  gitOwner: "owner",
  gitRepo: "shop",
  monorepoSharedPaths: null,
};
const sha = "a".repeat(40);
let files: Map<string, string>;
const put = (path: string, value: unknown) => files.set(path, JSON.stringify(value));
const impact = (...paths: string[]) => resolveProjectChangeImpact(ctx, project, paths, sha);
beforeEach(() => {
  vi.resetAllMocks();
  files = new Map();
  put("package.json", { private: true, workspaces: ["apps/*", "packages/*"] });
  put("apps/storefront/package.json", { name: "storefront", dependencies: { ui: "workspace:*" } });
  put("apps/admin/package.json", { name: "admin" });
  put("packages/ui/package.json", { name: "ui", devDependencies: { config: "workspace:*" } });
  put("packages/config/package.json", { name: "config" });
  put("packages/unused/package.json", { name: "unused" });
  h.read.mockImplementation(async (_ctx, owner, repo, path, opts) => {
    expect([owner, repo, opts.branch]).toEqual(["owner", "shop", sha]);
    if (!files.has(path)) throw Object.assign(new Error("Not found"), { status: 404 });
    return { content: files.get(path), size: files.get(path)!.length };
  });
  h.tree.mockImplementation(async (_ctx, _owner, _repo, opts) => {
    expect(opts).toMatchObject({ branch: sha, requireComplete: true });
    return [...files.keys()].map((path) => ({ path, type: "file" }));
  });
});
describe("automatic workspace impact", () => {
  it("skips unrelated apps and unused packages", async () => {
    expect(await impact("apps/admin/src/page.tsx")).toEqual({
      affected: false,
      reason: "unrelated-workspaces",
    });
    expect(await impact("packages/unused/src/index.ts")).toMatchObject({ affected: false });
  });
  it("includes app files, transitive dependencies and root dependencies", async () => {
    expect(await impact("apps/storefront/page.tsx")).toMatchObject({
      affected: true,
      reason: "project-files",
    });
    expect(h.tree).not.toHaveBeenCalled();
    expect(await impact("packages/config/tsconfig.json")).toMatchObject({
      affected: true,
      reason: "workspace-dependency",
    });
    put("package.json", {
      workspaces: ["apps/*", "packages/*"],
      devDependencies: { unused: "workspace:*" },
    });
    expect(await impact("packages/unused/index.ts")).toMatchObject({ affected: true });
  });
  it.each([
    "package.json",
    "bun.lock",
    "pnpm-lock.yaml",
    "turbo.json",
    "turbo.jsonc",
    "openship.json",
  ])("always includes root build input %s", async (path) => {
    expect(await impact(path)).toMatchObject({ affected: true, reason: "root-config" });
    expect(h.read).not.toHaveBeenCalled();
  });
  it("keeps explicit shared paths authoritative", async () => {
    expect(
      await resolveProjectChangeImpact(
        ctx,
        { ...project, monorepoSharedPaths: ["apps/admin"] },
        ["apps/admin/index.ts"],
        sha,
      ),
    ).toMatchObject({ affected: true, reason: "shared-package" });
    expect(h.read).not.toHaveBeenCalled();
  });
  it("supports pnpm and treats deleted package roots conservatively", async () => {
    put("package.json", { private: true });
    files.set("pnpm-workspace.yaml", "packages:\n  - apps/*\n  - packages/*\n");
    expect(await impact("apps/admin/index.ts")).toMatchObject({ affected: false });
    files.delete("apps/admin/package.json");
    expect(await impact("apps/admin/index.ts")).toMatchObject({
      affected: true,
      reason: "shared-or-unknown-file",
    });
  });
  it("handles dependency cycles", async () => {
    put("packages/config/package.json", { name: "config", dependencies: { ui: "workspace:*" } });
    expect(await impact("apps/admin/index.ts")).toMatchObject({ affected: false });
  });
  it("includes Turbo global inputs and named cross-package tasks", async () => {
    put("turbo.json", {
      globalDependencies: ["config/**"],
      tasks: { build: { dependsOn: ["admin#build"], inputs: ["$TURBO_ROOT$/shared/**"] } },
    });
    expect(await impact("apps/admin/index.ts")).toMatchObject({
      affected: true,
      reason: "workspace-dependency",
    });
    expect(await impact("config/a.json")).toMatchObject({
      affected: true,
      reason: "turbo-global-input",
    });
    expect(await impact("shared/a.json")).toMatchObject({
      affected: true,
      reason: "turbo-global-input",
    });
  });
  it.each([
    "missing-package",
    "duplicate-name",
    "file-link",
    "bad-config",
    "incomplete-tree",
    "api-failure",
    "unknown-workspace",
  ])("deploys safely with %s", async (reason) => {
    if (reason === "missing-package") files.delete("packages/ui/package.json");
    if (reason === "duplicate-name") put("apps/admin/package.json", { name: "ui" });
    if (reason === "file-link")
      put("apps/storefront/package.json", {
        name: "storefront",
        dependencies: { shared: "file:../../shared" },
      });
    if (reason === "bad-config") files.set("turbo.json", "not JSON");
    if (reason === "incomplete-tree") h.tree.mockRejectedValue(new Error("Incomplete tree"));
    if (reason === "api-failure") h.read.mockRejectedValue(new Error("GitHub unavailable"));
    if (reason === "unknown-workspace") put("package.json", { workspaces: ["packages/*"] });
    expect(await impact("apps/admin/index.ts")).toEqual({
      affected: true,
      reason: "analysis-unavailable",
    });
  });
  it("does not skip an unknown diff or mutable revision", async () => {
    expect(await impact()).toMatchObject({ affected: true });
    expect(
      await resolveProjectChangeImpact(ctx, project, ["apps/admin/a.ts"], "main"),
    ).toMatchObject({ affected: true, reason: "unknown-revision" });
    expect(h.read).not.toHaveBeenCalled();
  });
});
describe("explicit openship.json policy", () => {
  it("supports include/exclude without a graph and cannot hide root configuration changes", async () => {
    put("apps/storefront/openship.json", {
      autoDeployPaths: { include: ["apps/storefront/**", "shared/**"], exclude: ["**/*.md"] },
    });
    expect(await impact("apps/storefront/README.md")).toMatchObject({
      affected: false,
      reason: "explicitly-excluded",
    });
    expect(await impact("shared/code.ts")).toMatchObject({
      affected: true,
      reason: "explicitly-included",
    });
    expect(await impact("apps/admin/index.ts")).toMatchObject({
      affected: false,
      reason: "outside-explicit-includes",
    });
    expect(await impact("bun.lock")).toMatchObject({ affected: true });
    expect(h.tree).not.toHaveBeenCalled();
  });
  it("prefers app policy and always deploys changes to that policy", async () => {
    put("openship.json", { autoDeployPaths: { include: [] } });
    put("apps/storefront/openship.json", { autoDeployPaths: { include: ["custom/**"] } });
    expect(await impact("custom/code.ts")).toMatchObject({ affected: true });
    expect(await impact("apps/storefront/openship.json")).toMatchObject({
      affected: true,
      reason: "project-config",
    });
  });
  it.each(["../secret/**", "/absolute/**", "a/{b,c}", "a?", "!src/**", "a/**b", "a\\b"])(
    "rejects ambiguous policy %s",
    (pattern) => {
      expect(
        parseOpenshipConfig({ autoDeployPaths: { include: [pattern] } }).errors.length,
      ).toBeGreaterThan(0);
    },
  );
  it("rejects unknown policy keys", () => {
    expect(parseOpenshipConfig({ autoDeployPaths: { ignored: ["src/**"] } }).errors).not.toEqual(
      [],
    );
  });
});

describe("bounded workspace analysis", () => {
  it("shares the same immutable catalog within a request", async () => {
    await runWithRequestStore(async () => {
      await impact("apps/admin/index.ts");
      await impact("packages/unused/index.ts");
    });
    expect(h.tree).toHaveBeenCalledOnce();
  });
  it("keeps different workspace identities separate even in one request", async () => {
    await runWithRequestStore(async () => {
      await impact("apps/admin/index.ts");
      await resolveProjectChangeImpact(
        { ...ctx, organizationId: "other-org" },
        project,
        ["apps/admin/index.ts"],
        sha,
      );
    });
    expect(h.tree).toHaveBeenCalledTimes(2);
  });
  it("falls back for oversized catalogs", async () => {
    for (let n = 0; n < 51; n++) put(`apps/extra-${n}/package.json`, { name: `extra-${n}` });
    expect(await impact("apps/admin/index.ts")).toEqual({
      affected: true,
      reason: "analysis-unavailable",
    });
  });
  it("forwards cancellation and deploys when its analysis budget expires", async () => {
    const controller = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
    h.read.mockImplementation(
      async (_ctx, _owner, _repo, _path, options) =>
        new Promise((_, reject) => {
          options.signal.addEventListener("abort", () => reject(options.signal.reason), {
            once: true,
          });
        }),
    );
    try {
      const pending = impact("apps/admin/index.ts");
      controller.abort(new Error("Analysis budget expired"));
      expect(await pending).toEqual({ affected: true, reason: "analysis-unavailable" });
    } finally {
      timeout.mockRestore();
    }
  });
});

it.each(["workspace-alias", "cross-package-input"])(
  "keeps deployment enabled for %s",
  async (unsupported) => {
    if (unsupported === "workspace-alias")
      put("apps/storefront/package.json", {
        name: "storefront",
        dependencies: { ui: "workspace:config@*" },
      });
    else put("turbo.json", { tasks: { build: { inputs: ["../../apps/admin/**"] } } });
    expect(await impact("apps/admin/index.ts")).toEqual({
      affected: true,
      reason: "analysis-unavailable",
    });
  },
);

it("keeps nested workspace files in the build context of a required parent package", async () => {
  put("package.json", { workspaces: ["apps/*", "packages/**"] });
  put("packages/ui/fixture/package.json", { name: "nested-fixture" });
  expect(await impact("packages/ui/fixture/index.ts")).toEqual({
    affected: true,
    reason: "workspace-dependency",
  });
});

it.each([{ framework: "docker" }, { framework: "docker-compose" }, { buildKind: "dockerfile" }])(
  "does not infer a custom Docker build context from package dependencies: %j",
  async (custom) => {
    expect(
      await resolveProjectChangeImpact(
        ctx,
        { ...project, ...custom },
        ["apps/admin/index.ts"],
        sha,
      ),
    ).toEqual({ affected: true, reason: "custom-build-context" });
    expect(h.tree).not.toHaveBeenCalled();
    expect(h.read).toHaveBeenCalledTimes(2);
  },
);
