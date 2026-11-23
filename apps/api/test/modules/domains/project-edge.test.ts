import { beforeEach, describe, expect, it, vi } from "vitest";
import { db, repos, schema } from "@repo/db";
import type { CommandExecutor } from "@repo/adapters";
import type { ExecutionContext } from "@repo/platform";
import { seedDeployment, seedOrg, seedProject, seedService, seedServiceDeployment, setActive } from "../../helpers/seed";

const io = vi.hoisted(() => ({
  events: [] as string[],
  reuse: vi.fn(),
  verify: vi.fn(),
  provision: vi.fn(),
  siteFor: vi.fn(),
  getContainerInfo: vi.fn(),
  dispose: vi.fn(),
}));
vi.mock("@repo/adapters", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  edgeProxyFor: () => ({ siteFor: io.siteFor }),
}));
vi.mock("@repo/platform/engine/lib/deployment-runtime", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  resolveDeploymentRuntimeForRead: async () => ({
    runtime: {
      name: "docker",
      supports: (capability: string) => capability === "containerInfo",
      getContainerInfo: io.getContainerInfo,
      dispose: io.dispose,
    },
  }),
  withDeploymentPlatform: async (_deployment: unknown, run: (platform: unknown) => unknown) =>
    run({ routing: {} }),
}));
vi.mock("@repo/platform/engine/lib/edge-challenge", () => ({
  ensureEdgeChallengeReady: async () => {
    io.events.push("challenge");
  },
}));
vi.mock("@repo/platform/engine/lib/edge-vhost-repair", () => ({
  repairEdgeVhosts: async () => {
    io.events.push("repair");
  },
}));
vi.mock("@repo/platform/engine/lib/self-app-routing", () => ({
  canRouteSelfApp: async () => false,
}));
vi.mock("@repo/platform/engine/modules/domains/project-route.service", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  reapplyProjectLiveRoutes: async () => {
    io.events.push("project routes");
  },
}));
vi.mock("@repo/platform/engine/modules/domains/routing-apply.service", () => ({
  applyProjectRouting: async () => {
    io.events.push("service paths");
  },
}));
vi.mock("@repo/platform/engine/modules/domains/domain.service", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  reuseServerCertForDomain: io.reuse,
  verifyDomain: io.verify,
}));
vi.mock("@repo/platform/engine/lib/domain-ssl", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  manageDomainSsl: io.provision,
}));

import { applyProjectEdgeRoutes, staleProjectEdgeUpstreams } from "@repo/platform/engine/modules/domains/project-edge.service";

describe("pending domains recover after edge setup without a restart", () => {
  let ctx: ExecutionContext;
  let projectId: string;
  let sequence = 0;
  beforeEach(async () => {
    vi.clearAllMocks();
    io.events.length = 0;
    ctx = (await seedOrg()) as ExecutionContext;
    const server = await repos.server.create({
      organizationId: ctx.organizationId,
      sshHost: "192.0.2.20",
    });
    const project = await seedProject(ctx.organizationId, { serverId: server.id });
    projectId = project.id;
    const deployment = await seedDeployment(project, {
      meta: { deployTarget: "server", serverId: server.id },
    });
    await setActive(projectId, deployment.id);
    io.reuse.mockImplementation(async (_ctx, id: string) => {
      io.events.push(`reuse ${id}`);
      return false;
    });
    io.verify.mockImplementation(async (_ctx, id: string) => {
      io.events.push(`verify ${id}`);
      await repos.domain.update(id, { verified: true, sslStatus: "active" });
      return { verified: true };
    });
    io.provision.mockImplementation(async (hostname: string) => {
      io.events.push(`provision ${hostname}`);
      return { verified: true };
    });
  }, 30_000);

  async function domain(overrides: Partial<typeof schema.domain.$inferInsert> = {}) {
    const id = `edge-test-${sequence++}`;
    const [row] = await db
      .insert(schema.domain)
      .values({
        id,
        hostname: `${id}.example.com`,
        projectId,
        verificationToken: "test",
        domainType: "custom",
        ...overrides,
      })
      .returning();
    return row;
  }

  it("applies complete service paths before reusing a carried certificate or retrying verification", async () => {
    const carried = await domain();
    const fresh = await domain();
    io.reuse.mockImplementation(async (_ctx, id: string) => {
      io.events.push(`reuse ${id}`);
      if (id !== carried.id) return false;
      await repos.domain.update(id, { verified: true, sslStatus: "active" });
      return true;
    });
    expect(await applyProjectEdgeRoutes(ctx, projectId, { onLog: () => {} })).toEqual([]);
    expect(io.events.slice(0, 4)).toEqual([
      "challenge",
      "repair",
      "project routes",
      "service paths",
    ]);
    expect(io.verify).toHaveBeenCalledTimes(1);
    expect(io.verify).toHaveBeenCalledWith(ctx, fresh.id, expect.any(Object));
    expect((await repos.domain.findById(carried.id))?.sslStatus).toBe("active");
    expect((await repos.domain.findById(fresh.id))?.verified).toBe(true);
  });

  it("retries a verified domain's failed first certificate, while respecting manual and external TLS", async () => {
    const pending = await domain({ verified: true, sslStatus: "error" });
    await domain({ verified: true, sslStatus: "none", manualSsl: true });
    await domain({ verified: true, sslStatus: "external", externalIngress: true });
    await domain({ verified: true, sslStatus: "active" });
    await domain({ verified: true, sslStatus: "none", domainType: "free" });
    expect(await applyProjectEdgeRoutes(ctx, projectId, { onLog: () => {} })).toEqual([]);
    expect(io.provision).toHaveBeenCalledExactlyOnceWith(pending.hostname, {
      action: "provision",
      projectId,
    });
    expect(io.reuse).not.toHaveBeenCalled();
    expect(io.verify).not.toHaveBeenCalled();
  });

  it("reports remaining verification failures while leaving the active workload and saved domains intact", async () => {
    const pending = await domain();
    const before = await repos.project.findById(projectId);
    io.verify.mockResolvedValue({
      verified: false,
      message: "The challenge could not reach this server",
    });
    expect(await applyProjectEdgeRoutes(ctx, projectId, { onLog: () => {} })).toEqual([
      `${pending.hostname}: The challenge could not reach this server`,
    ]);
    expect((await repos.project.findById(projectId))?.activeDeploymentId).toBe(
      before?.activeDeploymentId,
    );
    expect(await repos.domain.findById(pending.id)).toBeDefined();
    expect(io.events).toContain("service paths");
  });

  it("reports an owned route on an old bridge IP and clears after the edge is repaired", async () => {
    const project = (await repos.project.findById(projectId))!;
    const web = await seedService(project.id, { name: "web" });
    const internal = await seedService(project.id, { name: "internal" });
    await seedServiceDeployment(project.activeDeploymentId!, web, {
      containerId: "current-web",
      ip: "172.19.0.2",
    });
    await seedServiceDeployment(project.activeDeploymentId!, internal, {
      containerId: "internal",
      ip: "172.19.0.4",
    });
    const routed = await domain({ serviceId: web.id });
    const loopback = await domain({ serviceId: web.id });
    const read = (hostname: string) => ({
      target: {
        kind: "proxy",
        url: hostname === loopback.hostname ? "http://127.0.0.1:8080" : "http://172.19.0.2:80",
      },
    });
    io.siteFor.mockImplementation(read);
    io.getContainerInfo.mockResolvedValue({ status: "running", ip: "172.19.0.5" });
    const executor = {} as CommandExecutor;

    expect(await staleProjectEdgeUpstreams({ ...project, routeStrategy: "container-ip" }, executor))
      .toEqual([routed.hostname]);
    expect(io.getContainerInfo).toHaveBeenCalledExactlyOnceWith("current-web");
    expect(io.dispose).toHaveBeenCalledOnce();
    expect(await staleProjectEdgeUpstreams({ ...project, routeStrategy: "loopback-port" }, executor))
      .toEqual([]);

    io.siteFor.mockReturnValue({ target: { kind: "proxy", url: "http://172.19.0.5:80" } });
    expect(await staleProjectEdgeUpstreams({ ...project, routeStrategy: "container-ip" }, executor))
      .toEqual([]);
  });
});
