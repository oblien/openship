import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Project } from "@repo/db";

const h = vi.hoisted(() => ({
  cloud: false,
  owned: vi.fn(),
  unscoped: vi.fn(),
  ssh: vi.fn(),
  local: vi.fn(),
  isLocal: vi.fn(),
}));
vi.mock("@repo/db", () => ({ repos: { server: { getInOrganization: h.owned, get: h.unscoped } } }));
vi.mock("@repo/platform/engine/lib/active-deployment", () => ({
  findActiveDeployment: async () => ({ meta: { serverId: "recorded-server" } }),
}));
vi.mock("@repo/platform/engine/config/env", () => ({
  env: {
    get CLOUD_MODE() {
      return h.cloud;
    },
  },
}));
vi.mock("@repo/platform/engine/lib/ssh-manager", () => ({ sshManager: { withExecutor: h.ssh } }));
vi.mock("@repo/platform/engine/lib/box-org", () => ({ isLocalHostRow: h.isLocal }));
vi.mock("@repo/adapters", () => ({ createExecutor: h.local }));
import {
  resolveServerIdForProject,
  withServerHostExecutor,
  withCertStoreExecutor,
} from "@repo/platform/engine/lib/edge-host-executor";

const project = {
  id: "project-own",
  organizationId: "org-own",
  activeDeploymentId: "deployment-own",
} as Project;
beforeEach(() => {
  vi.resetAllMocks();
  h.cloud = false;
  h.owned.mockResolvedValue(null);
  h.unscoped.mockResolvedValue({
    id: "recorded-server",
    organizationId: "org-other",
    isLocal: false,
  });
  h.isLocal.mockResolvedValue(false);
  h.ssh.mockImplementation(async (_id, work) => work({}));
});

describe("recorded edge targets cannot borrow another tenant's host", () => {
  it("does not treat a saved deployment's serverId as ownership proof", async () => {
    expect(await resolveServerIdForProject(project)).toBeNull();
    expect(h.owned).toHaveBeenCalledWith("recorded-server", "org-own");
  });
  it.each([withServerHostExecutor, withCertStoreExecutor])(
    "refuses foreign execution before connecting or reading certificates",
    async (run) => {
      const read = vi.fn();
      expect(await run(project, read)).toBeNull();
      expect(h.ssh).not.toHaveBeenCalled();
      expect(h.local).not.toHaveBeenCalled();
      expect(read).not.toHaveBeenCalled();
      expect(h.unscoped).not.toHaveBeenCalled();
    },
  );
  it.each([withServerHostExecutor, withCertStoreExecutor])(
    "does not fall back to API-host or SSH certificate reads in Cloud",
    async (run) => {
      h.cloud = true;
      h.owned.mockResolvedValue({
        id: "recorded-server",
        organizationId: "org-own",
        isLocal: true,
      });
      h.isLocal.mockResolvedValue(true);
      const read = vi.fn();
      expect(await run(project, read)).toBeNull();
      expect(h.ssh).not.toHaveBeenCalled();
      expect(h.local).not.toHaveBeenCalled();
      expect(read).not.toHaveBeenCalled();
    },
  );
  it("resolves a never-deployed project's own server binding", async () => {
    const undeployed = {
      ...project,
      activeDeploymentId: null,
      serverId: "bound-server",
    } as Project;
    h.owned.mockResolvedValue({ id: "bound-server", organizationId: "org-own", isLocal: false });
    expect(await resolveServerIdForProject(undeployed)).toBe("bound-server");
    expect(h.owned).toHaveBeenCalledWith("bound-server", "org-own");
  });
  it("does not trust a never-deployed project's binding to a foreign server", async () => {
    const undeployed = {
      ...project,
      activeDeploymentId: null,
      serverId: "bound-server",
    } as Project;
    expect(await resolveServerIdForProject(undeployed)).toBeNull();
  });
  it("preserves an owned self-hosted server's host read", async () => {
    h.owned.mockResolvedValue({ id: "recorded-server", organizationId: "org-own", isLocal: false });
    expect(await withServerHostExecutor(project, async () => "owned result")).toBe("owned result");
    expect(h.ssh).toHaveBeenCalledWith("recorded-server", expect.any(Function));
  });
});
