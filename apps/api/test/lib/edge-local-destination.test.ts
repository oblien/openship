import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Project } from "@repo/db";

/**
 * A local deployment records no serverId: "local" is the absence of a binding.
 * The edge reader must still reach that box through the pooled host channel, or a
 * supported local deployment can never save an explicit domain body cap
 * (EDGE_UNAVAILABLE before the row is written). Only the I/O seams are faked here;
 * the executor selection and the edge report are the real code.
 */
const h = vi.hoisted(() => ({
  meta: { deployTarget: "local" } as Record<string, unknown>,
  cloud: false,
  server: vi.fn(),
  withHost: vi.fn(),
  withExecutor: vi.fn(),
  access: vi.fn(),
  domains: vi.fn(),
  edgeProxy: vi.fn(),
}));
vi.mock("@repo/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@repo/db")>()),
  repos: {
    domain: { listByProject: h.domains },
    server: { getInOrganization: h.server },
  },
}));
vi.mock("@repo/platform/engine/config/env", () => ({
  env: {
    get CLOUD_MODE() {
      return h.cloud;
    },
  },
}));
vi.mock("@repo/platform/engine/lib/active-deployment", () => ({
  findActiveDeployment: async () => ({ meta: h.meta }),
}));
vi.mock("@repo/platform/engine/lib/ssh-manager", () => ({
  sshManager: { withHostExecutor: h.withHost, withExecutor: h.withExecutor },
}));
vi.mock("@repo/platform/engine/lib/box-org", () => ({ isLocalHostRow: async () => false }));
vi.mock("@repo/platform/engine/lib/deployment-runtime", () => ({
  assertLocalDeploymentAccess: h.access,
}));
vi.mock("@repo/adapters", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@repo/adapters")>()),
  edgeProxy: h.edgeProxy,
  detectOpenRestyPaths: async () => ({ nginxVersion: null }),
}));

import { withDeploymentEdgeExecutor } from "@repo/platform/engine/lib/edge-host-executor";
import { readProjectEdgeConfig } from "@repo/platform/engine/modules/projects/edge-config.service";

const project = {
  id: "project-a",
  organizationId: "org-a",
  activeDeploymentId: "dep-a",
  workspaceId: null,
  routingConfig: null,
} as unknown as Project;

beforeEach(() => {
  vi.resetAllMocks();
  h.meta = { deployTarget: "local" };
  h.cloud = false;
  h.access.mockResolvedValue(undefined);
  h.server.mockResolvedValue(null);
  h.withHost.mockImplementation(async (work) => work({ via: "host" }));
  h.withExecutor.mockImplementation(async (_id, work) => work({ via: "ssh" }));
  h.domains.mockResolvedValue([{ id: "d1", hostname: "api.example.com", proxy: null }]);
  h.edgeProxy.mockResolvedValue({
    kind: "openresty",
    ours: true,
    siteFor: async () => ({ ssl: true, proxy: { clientMaxBodySize: "2m" }, proxyRaw: {} }),
  });
});

describe("edge inspection for a local deployment without serverId", () => {
  it("reads the edge through the host channel so the cap gate sees a reachable supported proxy", async () => {
    const report = await readProjectEdgeConfig(project);
    expect(h.access).toHaveBeenCalledWith("org-a");
    expect(h.withHost).toHaveBeenCalledTimes(1);
    expect(h.withExecutor).not.toHaveBeenCalled();
    expect(report).toMatchObject({ reachable: true, proxyKind: "openresty", ours: true });
  });

  it("does not use the host channel when the organization may not deploy locally", async () => {
    h.access.mockRejectedValue(new Error("LOCAL_HOST_ACCESS_DENIED"));
    const work = vi.fn();
    expect(await withDeploymentEdgeExecutor(project, work)).toBeNull();
    expect(h.withHost).not.toHaveBeenCalled();
    expect(work).not.toHaveBeenCalled();
    expect((await readProjectEdgeConfig(project)).reachable).toBe(false);
  });

  it.each([{ deployTarget: "cloud" }, { deployTarget: "cluster" }])(
    "never falls back to the control-plane host for a $deployTarget destination",
    async (meta) => {
      h.meta = meta;
      const work = vi.fn();
      expect(await withDeploymentEdgeExecutor(project, work)).toBeNull();
      expect(h.withHost).not.toHaveBeenCalled();
      expect(work).not.toHaveBeenCalled();
    },
  );

  it("does not turn a foreign server destination into a local read", async () => {
    h.meta = { deployTarget: "server", serverId: "someone-elses" };
    const work = vi.fn();
    expect(await withDeploymentEdgeExecutor(project, work)).toBeNull();
    expect(h.withHost).not.toHaveBeenCalled();
    expect(h.withExecutor).not.toHaveBeenCalled();
    expect(work).not.toHaveBeenCalled();
  });

  it("keeps using the pooled SSH executor for an owned server destination", async () => {
    h.meta = { deployTarget: "server", serverId: "srv-1" };
    h.server.mockResolvedValue({ id: "srv-1" });
    expect(await withDeploymentEdgeExecutor(project, async (exec) => exec)).toEqual({ via: "ssh" });
    expect(h.withHost).not.toHaveBeenCalled();
  });

  it("returns nothing in Cloud", async () => {
    h.cloud = true;
    expect(await withDeploymentEdgeExecutor(project, async () => "x")).toBeNull();
    expect(h.withHost).not.toHaveBeenCalled();
  });
});
