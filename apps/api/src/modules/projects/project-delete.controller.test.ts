import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

const h = vi.hoisted(() => ({
  teardownProject: vi.fn(),
  getActiveProjectState: vi.fn(async () => ({ blocking: false })),
}));

vi.mock("../../lib/request-context", () => ({
  getRequestContext: () => ({ userId: "user-1", organizationId: "org-1" }),
}));

vi.mock("../../lib/permission", () => ({
  permission: { assert: vi.fn(async () => {}) },
}));

vi.mock("../../lib/audit", () => ({
  audit: { recordAsync: vi.fn() },
  auditContextFrom: vi.fn(() => ({})),
}));

vi.mock("@repo/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@repo/db")>();
  return {
    ...actual,
    repos: {
      ...actual.repos,
      project: {
        ...actual.repos.project,
        findById: vi.fn(async () => ({
          id: "project-1",
          organizationId: "org-1",
          appTemplateId: null,
          deletionInProgress: false,
        })),
      },
    },
  };
});

vi.mock("./project-teardown", () => ({
  teardownProject: h.teardownProject,
  getActiveProjectState: h.getActiveProjectState,
}));

import { remove } from "./project.controller";

function app() {
  const api = new Hono();
  api.onError((error, c) =>
    c.json({ error: error.message }, error instanceof SyntaxError ? 400 : 500),
  );
  api.delete("/projects/:id", remove);
  return api;
}

describe("DELETE project option transport", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.getActiveProjectState.mockResolvedValue({ blocking: false });
    h.teardownProject.mockResolvedValue({
      ok: true,
      rowDeleted: true,
      steps: [],
      unrecoverable: [],
      orphaned: [],
      unlinked: [],
      canForceOrphan: false,
    });
  });

  it("passes a JSON forceOrphan request through as force + forceOrphan", async () => {
    const response = await app().request("/projects/project-1", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ forceOrphan: true }),
    });

    expect(response.status).toBe(200);
    expect(h.getActiveProjectState).not.toHaveBeenCalled();
    expect(h.teardownProject).toHaveBeenCalledWith(
      { userId: "user-1", organizationId: "org-1" },
      "project-1",
      {
        force: true,
        forceOrphan: true,
        wipeVolumes: false,
        recordOnly: false,
      },
    );
  });

  it("passes the legacy orphan body flag through the same force-orphan path", async () => {
    const response = await app().request("/projects/project-1", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ orphan: true }),
    });

    expect(response.status).toBe(200);
    expect(h.teardownProject).toHaveBeenCalledWith(
      { userId: "user-1", organizationId: "org-1" },
      "project-1",
      expect.objectContaining({ force: true, forceOrphan: true }),
    );
  });

  it("rejects malformed non-empty JSON instead of silently dropping force flags", async () => {
    const response = await app().request("/projects/project-1", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: '{"forceOrphan":',
    });

    expect(response.status).toBe(400);
    expect(h.teardownProject).not.toHaveBeenCalled();
  });

  it("returns the authoritative active-work rejection captured under the delete lock", async () => {
    h.teardownProject.mockResolvedValueOnce({
      ok: false,
      rowDeleted: false,
      steps: [],
      unrecoverable: [],
      orphaned: [],
      unlinked: [],
      canForceOrphan: false,
      rejection: "active_work",
      active: {
        blocking: true,
        summary: "Cannot delete while in-flight: 1 active deployment(s), 1 migration(s)",
        hasActiveDeployment: true,
        hasActiveBackup: false,
        hasActiveBackupRestore: false,
        hasActiveMigration: true,
        activeDeploymentIds: ["dep-race"],
        activeBackupRunIds: [],
        activeBackupRestoreIds: [],
        activeMigrationIds: ["migration-race"],
      },
    });

    const response = await app().request("/projects/project-1", { method: "DELETE" });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      code: "PROJECT_HAS_ACTIVE_WORK",
      active: {
        hasActiveMigration: true,
        deploymentIds: ["dep-race"],
        migrationIds: ["migration-race"],
      },
    });
    expect(h.getActiveProjectState).not.toHaveBeenCalled();
  });
});
