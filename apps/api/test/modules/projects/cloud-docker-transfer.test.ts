import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ read: vi.fn(), export: vi.fn(), remove: vi.fn(), restore: vi.fn(), teardown: vi.fn() }));
vi.mock("@repo/db", async original => ({
  ...await original<typeof import("@repo/db")>(),
  db: { select: () => ({ from: () => ({ where: h.read }) }) },
  deleteProjectSubgraph: h.remove, restoreSubgraph: h.restore,
}));
vi.mock("@repo/platform/engine/lib/cloud/client", () => ({ cloudClient: () => ({ exportSubgraph: h.export }) }));
vi.mock("@repo/platform/engine/modules/projects/project-teardown", () => ({ teardownProject: h.teardown }));

import { transferProjectToSelfHosted } from "@repo/platform/engine/modules/projects/transfer.service";

beforeEach(() => {
  vi.resetAllMocks();
  h.read.mockResolvedValue([{ id: "project", slug: "app", organizationId: "org", cloudWorkspaceId: "shared-vm" }]);
  h.export.mockResolvedValue({ ok: true, dump: { tables: { cloud_docker_workspace: [{ projectId: "project", workspaceId: "shared-vm" }] } } });
});
describe("Cloud Docker transfer boundary", () => {
  it("refuses a record-only transfer before erasing local ownership or the Cloud disk", async () => {
    await expect(transferProjectToSelfHosted({ projectId: "project", organizationId: "org" })).rejects.toThrow("Migrate that data");
    expect(h.remove).not.toHaveBeenCalled();
    expect(h.restore).not.toHaveBeenCalled();
    expect(h.teardown).not.toHaveBeenCalled();
  });
  it("does not export a project belonging to another organization", async () => {
    await expect(transferProjectToSelfHosted({ projectId: "project", organizationId: "foreign" })).rejects.toThrow("not found");
    expect(h.export).not.toHaveBeenCalled();
    expect(h.remove).not.toHaveBeenCalled();
  });
});
