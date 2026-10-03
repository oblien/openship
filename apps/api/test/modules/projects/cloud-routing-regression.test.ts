import "../mail/_setup-env";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CloudDockerRuntime } from "@repo/adapters";
import type { Deployment, Domain, Project } from "@repo/db";
import { managedRoutingFixture } from "../../../../../packages/adapters/test/managed-routing-fixture";

const h = vi.hoisted(() => ({
  project: {} as Project,
  deployment: {} as Deployment,
  domains: [] as Domain[],
  services: [] as any[],
  liveRows: [] as any[],
  fixture: null as unknown as ReturnType<typeof managedRoutingFixture>,
  runtime: {} as CloudDockerRuntime,
  syncManagedEdge: vi.fn(),
  deregisterManagedEdge: vi.fn(),
  updateDeployment: vi.fn(),
}));
vi.mock("@repo/db", async (original) => ({
  ...(await original<typeof import("@repo/db")>()),
  withAdvisoryLock: async (_key: string, work: () => Promise<unknown>) => work(),
  repos: {
    project: { findById: vi.fn(async () => h.project) },
    deployment: { findById: vi.fn(async () => h.deployment), updateStatus: h.updateDeployment },
    domain: {
      listByProject: vi.fn(async () => h.domains),
      findByHostname: vi.fn(async (hostname: string) => h.domains.find(row => row.hostname === hostname)),
      findOrCreateWithStatus: vi.fn(async (input) => ({ domain: { id: `domain-${input.hostname}`, ...input }, created: true })),
      update: vi.fn(async () => {}),
    },
    service: { listByProject: vi.fn(async () => h.services), listByDeployment: vi.fn(async () => h.liveRows) },
  },
}));
// Cross-controller activity admission is covered with real databases separately.
vi.mock("@repo/platform/engine/lib/cloud-workspace-lock", () => ({
  withCloudWorkspaceActivity: async (_id: unknown, work: () => Promise<unknown>) => work(),
}));
vi.mock("@repo/platform/engine/lib/cloud-route.service", () => ({
  removeCloudProjectRoute: async (_project: unknown, route: { hostname: string }) => h.fixture.infra.removeRoute(route.hostname),
}));
vi.mock("@repo/platform/engine/lib/platform-config", () => ({
  platform: () => ({ target: "cloud", runtime: h.runtime }),
}));
vi.mock("@repo/platform/engine/lib/deployment-runtime", async (original) => ({
  ...(await original<typeof import("@repo/platform/engine/lib/deployment-runtime")>()),
  resolveDeploymentPlatform: vi.fn(async () => ({
    effectiveTarget: "cloud", serverId: "managed-server",
    platform: { runtime: h.runtime, routing: h.fixture.infra, executor: h.fixture.executor },
  })),
  disposePlatform: vi.fn(),
}));
vi.mock("@repo/platform/engine/lib/managed-edge-proxy", async (original) => ({
  ...(await original<typeof import("@repo/platform/engine/lib/managed-edge-proxy")>()),
  syncManagedEdgeRoutes: h.syncManagedEdge, deregisterManagedEdgeRoutes: h.deregisterManagedEdge,
}));

import { retryProjectRouting } from "@repo/platform/engine/modules/projects/project-runtime.service";
import { reapplyProjectLiveRoutes } from "@repo/platform/engine/modules/domains/project-route.service";
import { applyProjectRouting } from "@repo/platform/engine/modules/domains/routing-apply.service";
import { reconcileProjectRoutes } from "@repo/platform/engine/lib/route-apply.service";

// Real routing compiler, reconciler and provider adapter; only SQL and provider
// I/O are simulated. The same Docker container ports drive edits and repair.
beforeEach(() => {
  vi.clearAllMocks();
  h.fixture = managedRoutingFixture();
  h.project = {
    id: h.fixture.projectId, organizationId: "org-a", slug: "app", port: 8000,
    workspaceId: "subscribed-server", serverId: "managed-server", activeDeploymentId: "deployment-a",
    hasServer: true, workloadType: "web", runtimeMode: "docker", routingConfig: null,
  } as Project;
  h.deployment = {
    id: "deployment-a", projectId: h.project.id, organizationId: h.project.organizationId,
    containerId: "container-a", status: "ready",
    meta: { deployTarget: "cloud", runtimeMode: "docker", serverId: h.project.serverId!,
      managedWorkspaceId: h.project.workspaceId!,
      managedServer: { projectId: h.project.id, workspaceId: h.fixture.workspaceId, ownerWorkspaceId: h.project.workspaceId! },
      edgeUnsynced: true, deployWarning: "Previous route failure" },
  } as Deployment;
  h.domains = [{
    id: "domain-a", projectId: h.project.id, hostname: "app.opsh.io", domainType: "free",
    serviceId: null, isPrimary: true, verified: true, targetPort: 8000, targetPath: null,
  }] as Domain[];
  h.services = [];
  h.liveRows = [];
  h.runtime = Object.assign(Object.create(CloudDockerRuntime.prototype), { name: "docker" });
  vi.mocked(h.fixture.scope.resolveTarget).mockImplementation(async (id, port) => {
    if (id !== "container-a" || ![8000, 9000].includes(port)) throw new Error("unowned service port");
    return port === 8000 ? 32000 : 32001;
  });
  vi.mocked(h.fixture.scope.resolveUrl).mockImplementation(async url => {
    if (!/^http:\/\/127\.0\.0\.1:3200[01]$/.test(url)) throw new Error("unowned upstream");
    return Number(new URL(url).port);
  });
  h.updateDeployment.mockImplementation(async (_id, _status, changes) => Object.assign(h.deployment, changes));
});

async function editRoutes(previous: string[]) {
  await reapplyProjectLiveRoutes(h.project, previous);
  await applyProjectRouting(h.project.id);
}

describe("managed Cloud route port edits and repair", () => {
  it("edits a route on the existing server and anchor instead of creating another resource", async () => {
    await editRoutes([]);
    h.domains[0]!.targetPort = 9000;
    await editRoutes(["app.opsh.io"]);
    expect(h.fixture.pages.create).toHaveBeenCalledOnce();
    expect(h.fixture.routes.set).toHaveBeenLastCalledWith("app.opsh.io", expect.objectContaining({
      routes: [{ match: { path: "/", type: "prefix" }, action: { kind: "proxy", workspace: h.fixture.workspaceId, port: 32001 } }],
    }));
    expect(h.syncManagedEdge).not.toHaveBeenCalled();
  });

  it("keeps a custom domain on the same provider anchor and preserves existing ingress ports", async () => {
    h.domains[0] = { ...h.domains[0]!, hostname: "app.example.com", domainType: "custom" };
    await editRoutes(["app.example.com"]);
    expect(h.fixture.pages.connectDomain).toHaveBeenCalledWith(expect.any(String), { domain: "app.example.com" });
    expect(h.fixture.workspace.network.update).toHaveBeenCalledWith(expect.objectContaining({ ingress_ports: [443, 32000] }));
    expect(h.fixture.routes.set).toHaveBeenCalledWith("app.example.com", expect.objectContaining({
      routes: expect.arrayContaining([expect.objectContaining({ action: { kind: "proxy", workspace: h.fixture.workspaceId, port: 32000 } })]),
    }));
  });

  it("removes the previous hostname through its owned provider anchor", async () => {
    await editRoutes([]);
    h.domains[0]!.hostname = "next.opsh.io";
    await editRoutes(["app.opsh.io"]);
    expect(h.fixture.pages.delete).toHaveBeenCalledWith("app");
    expect(h.fixture.records.has("app")).toBe(false);
    expect(h.fixture.records.has("next")).toBe(true);
    expect(h.deregisterManagedEdge).not.toHaveBeenCalled();
  });

  it("clears a warning only after the complete route table and verification succeed", async () => {
    const verifyDomains = vi.fn(async () => {
      expect(h.fixture.routes.set).toHaveBeenCalledOnce();
      expect(h.updateDeployment).not.toHaveBeenCalled();
      return [];
    });
    expect(await retryProjectRouting(h.project.id, h.project.organizationId, { verifyDomains })).toEqual({ ok: true });
    expect(verifyDomains).toHaveBeenCalledOnce();
    expect(h.deployment.meta).not.toHaveProperty("edgeUnsynced");
    expect(h.deployment.meta).toHaveProperty("managedServer.workspaceId", h.fixture.workspaceId);
  });

  it("keeps a provider rejection retryable with its original error", async () => {
    h.fixture.routes.set.mockRejectedValueOnce(new Error("Provider route update unavailable"));
    const result = await retryProjectRouting(h.project.id, h.project.organizationId);
    expect(result).toMatchObject({ ok: false, warning: expect.stringContaining("Provider route update unavailable") });
    expect(h.deployment.meta).toMatchObject({ edgeUnsynced: true, deployWarning: expect.stringContaining("Provider route update unavailable") });
    expect(h.syncManagedEdge).not.toHaveBeenCalled();
  });

  it("publishes each service port without collapsing a multiport service to its first port", async () => {
    h.deployment.containerId = "compose";
    h.services = [{ id: "service-a", name: "web", enabled: true, kind: "compose", ports: ["8000", "9000"], exposed: false }];
    h.liveRows = [{ serviceId: "service-a", containerId: "container-a" }];
    h.domains.push({ ...h.domains[0]!, id: "domain-b", hostname: "console.opsh.io", targetPort: 9000, isPrimary: false });
    expect(await retryProjectRouting(h.project.id, h.project.organizationId)).toEqual({ ok: true });
    expect(h.fixture.routes.set.mock.calls.map(([host, table]) => [host, table.routes[0]?.action])).toEqual([
      ["app.opsh.io", { kind: "proxy", workspace: h.fixture.workspaceId, port: 32000 }],
      ["console.opsh.io", { kind: "proxy", workspace: h.fixture.workspaceId, port: 32001 }],
    ]);
  });

  it("refuses a deployment from another project before any provider write", async () => {
    await expect(reconcileProjectRoutes(h.project, {
      deployment: { ...h.deployment, projectId: "other-project" },
      registers: [{ hostname: "app.opsh.io", port: 8000, isCustomDomain: false }],
    })).rejects.toThrow("active deployment changed");
    expect(h.fixture.pages.create).not.toHaveBeenCalled();
    expect(h.fixture.routes.set).not.toHaveBeenCalled();
  });
});
