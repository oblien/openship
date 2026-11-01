import { beforeEach, expect, it, vi } from "vitest";
const db = vi.hoisted(() => ({ active: vi.fn(), workspace: vi.fn() }));
vi.mock("@repo/db", () => ({
  repos: {
    cloudBuildActivity: { listActive: db.active },
    cloudWorkspace: { findByIdInOrganization: db.workspace },
  },
}));
import { buildCacheProtection } from "@repo/platform/engine/lib/build-cache-protection";

beforeEach(() => {
  vi.clearAllMocks();
  db.active.mockResolvedValue([]);
  db.workspace.mockResolvedValue({ activity: null });
});
it("protects pending commands under the exact workspace and organization", async () => {
  db.active.mockResolvedValue([
    { projectId: "idle", commands: [] },
    { projectId: "pending", commands: [{ marker: "lost-start-reply" }] },
  ]);
  expect(await buildCacheProtection("org-a", "workspace-a")).toEqual({
    projectIds: ["pending"],
    all: false,
  });
  expect(db.active).toHaveBeenCalledWith("workspace-a", "org-a");
  expect(db.workspace).toHaveBeenCalledWith("workspace-a", "org-a");
});
it("protects all state during a linked controller's unconfirmed command", async () => {
  db.workspace.mockResolvedValue({ activity: { commands: [{ marker: "pending" }] } });
  expect((await buildCacheProtection("org-a", "workspace-a")).all).toBe(true);
});
it("fails closed when host ownership cannot be revalidated", async () => {
  db.workspace.mockResolvedValue(null);
  await expect(buildCacheProtection("org-a", "workspace-a")).rejects.toThrow(/ownership changed/);
});
