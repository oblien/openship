import { beforeEach, describe, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({
  binding: vi.fn(),
  namespace: vi.fn(),
  admin: vi.fn(),
  list: vi.fn(),
  construct: vi.fn(),
}));
vi.mock("@repo/db", () => ({ repos: { cloudDockerWorkspace: { find: h.binding } } }));
vi.mock("@repo/adapters", () => ({
  CloudInfraProvider: class {
    constructor(client: unknown, options: unknown) {
      h.construct(client, options);
    }
    listProjectRouteHostnames() {
      return h.list();
    }
  },
  cloudDockerProjectPaths: (id: string) => ({ routes: `/projects/${id}/routes` }),
}));
vi.mock("@repo/platform/engine/lib/openship-cloud", () => ({ getNamespaceClient: h.namespace }));
vi.mock("@repo/platform/engine/lib/cloud-tenant-admin", () => ({
  createTenantCloudAdmin: h.admin,
}));
vi.mock("@repo/platform/engine/config/env", () => ({ env: { CLOUD_MODE: true } }));
import { listCloudProjectRouteHostnames } from "@repo/platform/engine/lib/cloud-route.service";
const project = {
  id: "project-a",
  organizationId: "org-a",
  workspaceId: "server-a",
  activeDeploymentId: "deployment-a",
};
beforeEach(() => {
  vi.clearAllMocks();
  h.binding.mockResolvedValue({ workspaceId: "vm-a", namespace: "namespace-a" });
  h.namespace.mockResolvedValue({ client: "client-a", namespace: "namespace-a" });
  h.admin.mockReturnValue("scoped-admin");
  h.list.mockResolvedValue(["owned.opsh.io"]);
});
describe("Cloud hostname ownership before deployment", () => {
  it("uses the project's subscribed server and namespace instead of a draft domain claim", async () => {
    expect(await listCloudProjectRouteHostnames(project)).toEqual(["owned.opsh.io"]);
    expect(h.binding).toHaveBeenCalledWith({ ownerWorkspaceId: "server-a" }, "org-a");
    expect(h.admin).toHaveBeenCalledWith("org-a", "namespace-a", "server-a");
    expect(h.construct).toHaveBeenCalledWith(
      "client-a",
      expect.objectContaining({ workspaceId: "vm-a", routeRoot: "/projects/project-a/routes" }),
    );
  });
  it("rejects a binding whose namespace no longer matches", async () => {
    h.binding.mockResolvedValue({ workspaceId: "vm-a", namespace: "another-tenant" });
    await expect(listCloudProjectRouteHostnames(project)).rejects.toThrow("namespace changed");
    expect(h.list).not.toHaveBeenCalled();
  });
  it("does not claim draft hostnames without a provisioned server", async () => {
    h.binding.mockResolvedValue(null);
    expect(await listCloudProjectRouteHostnames(project)).toEqual([]);
    expect(h.namespace).not.toHaveBeenCalled();
  });
});
