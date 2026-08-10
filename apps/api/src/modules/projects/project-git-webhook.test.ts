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
vi.mock("../github/github.service", () => ({ registerWebhook, updateWebhook }));

import { ensureSharedWebhook, findSharedWebhookId } from "./project-git-webhook";

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
      { id: "pX", organizationId: "oOther", gitOwner: "acme", gitRepo: "app", webhookId: null }, // other org — excluded
    ]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const project = { id: "p1", organizationId: "o1", webhookId: null } as any;

    const hookId = await ensureSharedWebhook(ctx, project, "acme", "app");

    expect(hookId).toBe(100);
    const updatedIds = projectUpdate.mock.calls.map((c) => c[0]);
    expect(updatedIds).toContain("p1");
    expect(updatedIds).toContain("p2");
    expect(updatedIds).not.toContain("pX"); // never crosses the org boundary
    expect(projectUpdate).toHaveBeenCalledWith("p1", { webhookId: 100 });
  });

  it("deactivates a superseded hook when the repo already had a different one", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const project = { id: "p1", organizationId: "o1", webhookId: 55 } as any;
    registerWebhook.mockResolvedValue({ hookId: 100, events: [] });

    await ensureSharedWebhook(ctx, project, "acme", "app");

    expect(updateWebhook).toHaveBeenCalledWith(ctx, "acme", "app", 55, { active: false });
  });

  it("returns null and fans out nothing when registration yields no hook", async () => {
    registerWebhook.mockResolvedValue({ hookId: null, events: [] });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const project = { id: "p1", organizationId: "o1", webhookId: null } as any;

    const hookId = await ensureSharedWebhook(ctx, project, "acme", "app");

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
    expect(await findSharedWebhookId("o1", "acme", "app")).toBe(77);
  });

  it("returns null when no same-repo project carries one", async () => {
    findByGitRepo.mockResolvedValue([
      { id: "p1", organizationId: "o1", gitOwner: "acme", gitRepo: "app", webhookId: null },
    ]);
    expect(await findSharedWebhookId("o1", "acme", "app")).toBeNull();
  });
});
