import "../mail/_setup-env";
import { beforeEach, describe, expect, it, vi } from "vitest";

const deploymentRepo = vi.hoisted(() => ({ findById: vi.fn() }));
const serverRepo = vi.hoisted(() => ({ get: vi.fn() }));

vi.mock("@repo/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@repo/db")>();
  return {
    ...actual,
    repos: {
      ...actual.repos,
      deployment: deploymentRepo,
      server: serverRepo,
    },
  };
});

import { enrichProject } from "../../../src/modules/projects/project-crud.service";

const baseProject = {
  id: "proj_1",
  organizationId: "org_1",
  groupId: null,
  slug: "app",
  name: "App",
  port: 3000,
  cloudWorkspaceId: null,
  resources: null,
  buildResources: null,
  sleepMode: "auto_sleep",
} as any;

// The durable project.serverId is the source of truth for the server binding;
// meta.serverId is a per-deploy snapshot a fresh/partial deploy can drop. These
// pin the coalesce: meta wins when present, the column fills in when it doesn't.
describe("enrichProject serverId coalesce", () => {
  beforeEach(() => {
    deploymentRepo.findById.mockReset();
    serverRepo.get.mockReset();
    serverRepo.get.mockResolvedValue(null);
  });

  it("uses the deploy meta serverId when present (column ignored)", async () => {
    deploymentRepo.findById.mockResolvedValue({
      id: "dep_1",
      meta: { deployTarget: "server", serverId: "srv_meta" },
      version: 2,
      status: "success",
    });
    serverRepo.get.mockResolvedValue({ name: "Meta Box" });

    const enriched = await enrichProject({
      ...baseProject,
      activeDeploymentId: "dep_1",
      serverId: "srv_col",
    });

    expect(enriched.serverId).toBe("srv_meta");
    expect(enriched.serverName).toBe("Meta Box");
    expect(enriched.deployTarget).toBe("server");
    expect(serverRepo.get).toHaveBeenCalledWith("srv_meta");
  });

  it("coalesces to the durable column when meta dropped serverId", async () => {
    deploymentRepo.findById.mockResolvedValue({
      id: "dep_1",
      meta: { deployTarget: "server" },
      version: 3,
      status: "success",
    });
    serverRepo.get.mockResolvedValue({ name: null, sshHost: "1.2.3.4" });

    const enriched = await enrichProject({
      ...baseProject,
      activeDeploymentId: "dep_1",
      serverId: "srv_col",
    });

    expect(enriched.serverId).toBe("srv_col");
    expect(enriched.serverName).toBe("1.2.3.4");
    expect(serverRepo.get).toHaveBeenCalledWith("srv_col");
  });

  it("resolves the column server even with no active deployment", async () => {
    serverRepo.get.mockResolvedValue({ name: "Col Box" });

    const enriched = await enrichProject({
      ...baseProject,
      activeDeploymentId: null,
      serverId: "srv_col",
    });

    expect(deploymentRepo.findById).not.toHaveBeenCalled();
    expect(enriched.serverId).toBe("srv_col");
    expect(enriched.serverName).toBe("Col Box");
    expect(enriched.deployTarget).toBeNull();
  });

  it("leaves serverId/serverName null when neither meta nor column has one", async () => {
    const enriched = await enrichProject({
      ...baseProject,
      activeDeploymentId: null,
      serverId: null,
    });

    expect(enriched.serverId).toBeNull();
    expect(enriched.serverName).toBeNull();
    expect(serverRepo.get).not.toHaveBeenCalled();
  });
});
