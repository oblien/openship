import { beforeEach, describe, expect, it, vi } from "vitest";
import { repos, db, schema, seedOwner } from "../jobs/_harness";
import { seedProject, seedDeployment, setActive } from "../../helpers/seed";
import type { ExecutionContext } from "@repo/platform";
import type { RouteConfig } from "@repo/adapters";

// Real SQL, pause/resume, static route planner, canonical policy registrar and
// readback. Replace host/provider transport, reconciliation I/O, Lua pushes and
// health only. This proves lifecycle/configuration intent, not running nginx.
const h = vi.hoisted(() => ({
  routes: new Map<string, any>(),
  supports: true,
  cloudDown: false,
  routing: {} as any,
  resolved: {} as any,
  edge: vi.fn(),
  ssh: vi.fn(),
  sync: vi.fn(),
  reconcile: vi.fn(),
}));
vi.mock("@repo/platform/engine/lib/platform-config", () => ({
  platform: () => ({ target: "selfhosted", runtime: { name: "bare" }, routing: h.routing }),
}));
vi.mock("@repo/platform/engine/lib/deployment-runtime", async (original) => ({
  ...(await original<object>()),
  disposePlatform: () => {},
  resolveDeploymentPlatform: async () => h.resolved,
  withDeploymentPlatform: async (_dep: unknown, work: (value: any) => unknown) =>
    work({ ...h.resolved.platform, effectiveTarget: "server", serverId: "fixture-server" }),
}));
vi.mock("@repo/platform/engine/lib/route-apply.service", async (original) => ({
  ...(await original<object>()),
  reconcileProjectRoutes: h.reconcile,
}));
vi.mock("@repo/platform/engine/lib/managed-edge-proxy", async (original) => ({
  ...(await original<object>()),
  syncManagedEdgeRoutes: h.sync,
  deregisterManagedEdgeRoutes: async () => ({ failures: [] }),
}));
vi.mock("@repo/platform/engine/lib/ssh-manager", () => ({ sshManager: { withExecutor: h.ssh } }));
vi.mock("@repo/platform/engine/lib/edge-reconcile", () => ({
  reconcileServerEdge: async () => ({ converted: false, updated: false, edgeDown: false }),
}));
vi.mock("@repo/adapters", async (original) => ({
  ...(await original<object>()),
  edgeProxy: h.edge,
  checkEdge: async () => ({ healthy: true, message: "fixture health" }),
}));
vi.mock("@repo/platform/engine/modules/route-rules/route-rule.service", async (original) => ({
  ...(await original<object>()),
  pushProjectRules: async () => {},
}));
vi.mock("@repo/platform/engine/modules/analytics/analytics-config.service", async (original) => ({
  ...(await original<object>()),
  pushProjectAnalyticsConfig: async () => {},
}));
vi.mock("@repo/platform/engine/lib/self-app-routing", () => ({
  canRouteSelfApp: async () => false,
}));

import { registerProjectRoute } from "@repo/platform/engine/lib/project-route-registration";
import { reapplyProjectLiveRoutes } from "@repo/platform/engine/modules/domains/project-route.service";
import { updateDomain } from "@repo/platform/engine/modules/domains/domain.service";
import {
  disableProject,
  enableProject,
} from "@repo/platform/engine/modules/projects/project-runtime.service";
import { readProjectEdgeConfig } from "@repo/platform/engine/modules/projects/edge-config.service";

beforeEach(() => {
  vi.clearAllMocks();
  h.routes.clear();
  h.supports = true;
  h.cloudDown = false;
  h.routing = {
    get supportsDomainProxy() {
      return h.supports;
    },
    registerRoute: async (route: RouteConfig) => {
      h.routes.set(route.domain, structuredClone(route));
    },
    removeRoute: async (host: string) => {
      h.routes.delete(host);
    },
  };
  h.resolved = {
    platform: { routing: h.routing, runtime: { name: "bare" }, executor: {} },
    effectiveTarget: "server",
    serverId: "fixture-server",
  };
  h.ssh.mockImplementation(async (_id, work) => work({}));
  h.edge.mockImplementation(async () => ({
    kind: "openresty",
    ours: false,
    siteFor: async (host: string) => {
      const route = h.routes.get(host);
      return route
        ? {
            serverNames: [host],
            ssl: false,
            target: { kind: "static", root: route.staticRoot },
            proxy: route.proxy,
          }
        : null;
    },
  }));
  h.sync.mockImplementation(async (targets) => ({
    failures: h.cloudDown ? targets.map((target: any) => target.hostname) : [],
  }));
  h.reconcile.mockImplementation(async (project, options) => {
    for (const remove of options.removes ?? []) h.routes.delete(remove.hostname);
    for (const route of options.registers ?? []) {
      await registerProjectRoute(project, h.routing, {
        domain: route.hostname,
        staticRoot: route.staticRoot,
        tls: false,
      });
    }
  });
});
async function fixture(active = true, projectProxy = true) {
  const owner = await seedOwner();
  const serverId = `server-${owner.orgId}`;
  await db
    .insert(schema.servers)
    .values({ id: serverId, organizationId: owner.orgId, sshHost: "192.0.2.20", isLocal: false });
  const label = owner.userId.replace(/[^a-z0-9-]/gi, "-").toLowerCase();
  const project = await seedProject(owner.orgId, {
    slug: label,
    serverId,
    workloadType: "static",
    hasServer: false,
    routingConfig: projectProxy ? { proxy: { clientMaxBodySize: "5m" } } : null,
  });
  const domain = await repos.domain.create({
    projectId: project.id,
    hostname: `${label}.example.com`,
    domainType: "custom",
    targetPath: "/",
    verified: true,
    status: "active",
    proxy: { clientMaxBodySize: "1m" },
  });
  if (active) {
    const deployment = await seedDeployment(project, {
      containerId: "/srv/releases/body-cap",
      meta: { deployTarget: "server", serverId },
    });
    await setActive(project.id, deployment.id);
  }
  const ctx = { organizationId: owner.orgId, userId: owner.userId } as ExecutionContext;
  return { owner, domain, ctx, project: (await repos.project.findById(project.id))! };
}

describe("domain body cap persisted lifecycle", () => {
  it.each([{ clientMaxBodySize: "2m" }, null, {}])(
    "keeps a paused static route absent for %j until explicit resume",
    async (proxy) => {
      const { project, domain, owner, ctx } = await fixture();
      await reapplyProjectLiveRoutes(project, [domain.hostname]);
      expect(h.routes.has(domain.hostname)).toBe(true);
      await disableProject(project.id, owner.orgId);
      const paused = (await repos.project.findById(project.id))!.disabledAt;
      expect(paused).not.toBeNull();
      expect(h.routes.size).toBe(0);
      h.edge.mockClear();
      h.reconcile.mockClear();
      await updateDomain(ctx, domain.id, { proxy });
      expect((await repos.domain.findById(domain.id))?.proxy).toEqual(proxy);
      expect((await repos.project.findById(project.id))!.disabledAt).toEqual(paused);
      expect(h.routes.size).toBe(0);
      expect(h.edge).not.toHaveBeenCalled();
      expect(h.reconcile).not.toHaveBeenCalled();
      await enableProject(project.id, owner.orgId);
      expect((await repos.project.findById(project.id))!.disabledAt).toBeNull();
      expect(h.routes.get(domain.hostname)).toMatchObject({
        staticRoot: "/srv/releases/body-cap",
        proxy: { clientMaxBodySize: proxy && "clientMaxBodySize" in proxy ? "2m" : "5m" },
      });
    },
  );
  it("does not resync an unchanged managed sibling when Cloud sync would fail", async () => {
    const { project, domain, ctx } = await fixture();
    const sibling = await repos.domain.create({
      projectId: project.id,
      hostname: `${project.slug}.opsh.io`,
      domainType: "free",
      targetPath: "/",
      verified: true,
      status: "active",
    });
    h.cloudDown = true;
    await expect(
      updateDomain(ctx, domain.id, { proxy: { clientMaxBodySize: "2m" } }),
    ).resolves.toMatchObject({ proxy: { clientMaxBodySize: "2m" } });
    expect(h.routes.has(sibling.hostname)).toBe(true);
    expect(h.sync).not.toHaveBeenCalled();
  });
  it("saves supported predeployment intent while real readback remains unobservable", async () => {
    const { project, domain, ctx } = await fixture(false, false);
    const before = await readProjectEdgeConfig(project);
    expect(before.reachable).toBe(false);
    expect(before.hosts[0]?.bodyLimit.configurationMatches).toBeNull();
    await expect(
      updateDomain(ctx, domain.id, { proxy: { clientMaxBodySize: "2m" } }),
    ).resolves.toMatchObject({ proxy: { clientMaxBodySize: "2m" } });
    expect(h.edge).not.toHaveBeenCalled();
    expect(h.ssh).not.toHaveBeenCalled();
    expect(h.reconcile).not.toHaveBeenCalled();
    const report = await readProjectEdgeConfig((await repos.project.findById(project.id))!);
    expect(report.reachable).toBe(false);
    expect(report.hosts[0]?.bodyLimit).toMatchObject({
      saved: { clientMaxBodySize: "2m" },
      effective: "2m",
      source: "domain",
      observed: null,
      configurationMatches: null,
    });
    await updateDomain(ctx, domain.id, { proxy: null });
    const inherited = await readProjectEdgeConfig((await repos.project.findById(project.id))!);
    expect(inherited.hosts[0]?.bodyLimit).toMatchObject({
      saved: null,
      effective: null,
      source: "edge",
      observed: null,
      configurationMatches: null,
    });
  });
});
