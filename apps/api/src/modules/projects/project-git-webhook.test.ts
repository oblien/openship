import { beforeEach, describe, expect, it, vi } from "vitest";

// Isolate the reconciler: the DB repo + the GitHub webhook calls are mocked, so
// the test asserts ONLY the org+repo fan-out + stale-hook deactivation logic.
const { findByGitRepo, projectUpdate, registerWebhook, updateWebhook } = vi.hoisted(() => ({
  findByGitRepo: vi.fn(),
  projectUpdate: vi.fn(),
  registerWebhook: vi.fn(),
  updateWebhook: vi.fn(),
}));

vi.mock("@repo/db", () => ({
  repos: { project: { findByGitRepo, update: projectUpdate } },
}));
vi.mock("@repo/platform/engine/modules/github/github.service", () => ({ registerWebhook, updateWebhook }));

import { ensureSharedWebhook, findSharedWebhookId } from "@repo/platform/engine/modules/projects/project-git-webhook";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ctx = { userId: "u1", organizationId: "o1" } as any;

beforeEach(() => {
  vi.clearAllMocks();
  findByGitRepo.mockResolvedValue([]);
  projectUpdate.mockResolvedValue(undefined);
  registerWebhook.mockResolvedValue({ hookId: 100, events: [] });
  updateWebhook.mockResolvedValue(undefined);
});

describe("ensureSharedWebhook", () => {
  it("registers, then fans the webhookId across same-org same-repo projects (case-insensitive), not other orgs", async () => {
    findByGitRepo.mockResolvedValue([
      { id: "p1", organizationId: "o1", gitOwner: "acme", gitRepo: "app", webhookId: null },
      { id: "p2", organizationId: "o1", gitOwner: "Acme", gitRepo: "App", webhookId: null }, // case-insensitive match
    ]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const project = { id: "p1", organizationId: "o1", webhookId: null } as any;

    const hookId = await ensureSharedWebhook(ctx, project, { provider: "github", namespace: "acme", name: "app" });

    expect(hookId).toBe("100");
    const updatedIds = projectUpdate.mock.calls.map((c) => c[0]);
    expect(updatedIds).toContain("p1");
    expect(updatedIds).toContain("p2");
    expect(findByGitRepo).toHaveBeenCalledWith({ provider: "github", namespace: "acme", name: "app" }, ["o1"]);
    expect(projectUpdate).toHaveBeenCalledWith("p1", { webhookId: "100" });
  });

  it("deactivates a superseded hook when the repo already had a different one", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const project = { id: "p1", organizationId: "o1", gitOwner: "acme", gitRepo: "app", webhookId: "55" } as any;
    registerWebhook.mockResolvedValue({ hookId: 100, events: [] });

    await ensureSharedWebhook(ctx, project, { provider: "github", namespace: "acme", name: "app" });

    expect(updateWebhook).toHaveBeenCalledWith(ctx, "acme", "app", 55, { active: false });
  });

  it("never deactivates a hook from a previous provider when its numeric ID overlaps", async () => {
    const project = { id: "p1", organizationId: "o1", gitProvider: "gitlab", gitOwner: "acme", gitRepo: "app", webhookId: "55" } as any;
    await ensureSharedWebhook(ctx, project, { provider: "github", namespace: "acme", name: "app" });
    expect(updateWebhook).not.toHaveBeenCalled();
  });

  it("uses the target provider while linking a project that previously had no Git source", async () => {
    const project = { id: "p1", organizationId: "o1", webhookId: null, gitProvider: "upload" } as any;
    expect(await ensureSharedWebhook(ctx, project, { provider: "github", namespace: "acme", name: "app" })).toBe("100");
    expect(registerWebhook).toHaveBeenCalledWith(ctx, "acme", "app", undefined, { projectId: "p1" });
  });

  it("returns null and fans out nothing when registration yields no hook", async () => {
    registerWebhook.mockResolvedValue({ hookId: null, events: [] });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const project = { id: "p1", organizationId: "o1", webhookId: null } as any;

    const hookId = await ensureSharedWebhook(ctx, project, { provider: "github", namespace: "acme", name: "app" });

    expect(hookId).toBeNull();
    expect(projectUpdate).not.toHaveBeenCalled();
    expect(updateWebhook).not.toHaveBeenCalled();
  });
});

describe("findSharedWebhookId", () => {
  it("returns an existing webhookId among same-org same-repo projects", async () => {
    findByGitRepo.mockResolvedValue([
      { id: "p1", organizationId: "o1", gitOwner: "acme", gitRepo: "app", webhookId: null },
      { id: "p2", organizationId: "o1", gitOwner: "acme", gitRepo: "app", webhookId: 77 },
    ]);
    expect(await findSharedWebhookId("o1", { provider: "github", namespace: "acme", name: "app" })).toBe(77);
  });

  it("returns null when no same-repo project carries one", async () => {
    findByGitRepo.mockResolvedValue([
      { id: "p1", organizationId: "o1", gitOwner: "acme", gitRepo: "app", webhookId: null },
    ]);
    expect(await findSharedWebhookId("o1", { provider: "github", namespace: "acme", name: "app" })).toBeNull();
  });
});
