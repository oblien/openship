import { beforeEach, describe, expect, it, vi } from "vitest";

const { listByProject, findDeployment, resolveRuntime, reconcile } = vi.hoisted(() => ({
  listByProject: vi.fn(),
  findDeployment: vi.fn(),
  resolveRuntime: vi.fn(),
  reconcile: vi.fn(),
}));

vi.mock("@repo/db", () => ({
  repos: {
    domain: { listByProject },
    deployment: { findById: findDeployment },
  },
}));

vi.mock("../../../src/lib/deployment-runtime", () => ({
  resolveDeploymentRuntime: resolveRuntime,
}));

vi.mock("../../../src/lib/route-apply.service", () => ({
  reconcileProjectRoutes: reconcile,
}));

vi.mock("../../../src/modules/route-rules/route-rule.service", () => ({
  pushProjectRules: vi.fn().mockResolvedValue(undefined),
}));

import {
  deriveEnvironmentPublicEndpoints,
  reapplyProjectLiveRoutes,
  shouldRefuseLoopbackRoute,
} from "../../../src/modules/domains/project-route.service";

describe("shouldRefuseLoopbackRoute", () => {
  it("refuses a tenant project's public route to the dashboard port on loopback", () => {
    expect(shouldRefuseLoopbackRoute("127.0.0.1", 3001, { isSelfApp: false })).toBe(true);
  });

  it("refuses a tenant project's public route to the admin API port on loopback", () => {
    expect(shouldRefuseLoopbackRoute("127.0.0.1", 4000, { isSelfApp: false })).toBe(true);
  });

  it("allows the self-app's own public route to the dashboard port on loopback", () => {
    expect(shouldRefuseLoopbackRoute("127.0.0.1", 3001, { isSelfApp: true })).toBe(false);
  });

  it("allows a non-reserved port on loopback regardless of self-app status", () => {
    expect(shouldRefuseLoopbackRoute("127.0.0.1", 8080, { isSelfApp: false })).toBe(false);
  });

  it("allows any port on a non-loopback host (container IP)", () => {
    expect(shouldRefuseLoopbackRoute("172.17.0.5", 3001, { isSelfApp: false })).toBe(false);
  });
});

describe("deriveEnvironmentPublicEndpoints", () => {
  it("clones an explicit proxy target without inventing a fallback port", () => {
    expect(
      deriveEnvironmentPublicEndpoints(
        [{ port: 4010 }],
        "preview-app",
      ),
    ).toEqual([
      { port: 4010, domain: "preview-app", domainType: "free" },
    ]);
  });

  it("clones an explicit static path target without inventing a port", () => {
    expect(
      deriveEnvironmentPublicEndpoints(
        [{ targetPath: "/docs" }],
        "preview-docs",
      ),
    ).toEqual([
      { targetPath: "/docs", domain: "preview-docs", domainType: "free" },
    ]);
  });

  it("returns no endpoints when the base project has no explicit destination", () => {
    expect(deriveEnvironmentPublicEndpoints([], "preview-app")).toEqual([]);
  });
});

// Behavioral regression for issue #129: the self-app's own boot route to its
// dashboard port on loopback was refused, so OpenResty never bound 443 and the
// domain was unreachable. Drives the ACTUAL failing branch (bare adopt runtime,
// resolveTargetUrl) rather than just the shouldRefuseLoopbackRoute predicate.
describe("reapplyProjectLiveRoutes self-app loopback route (issue #129)", () => {
  // Mirrors the real self-app adopt deployment: meta { runtimeMode: "bare" } →
  // the app runs on the host, so the runtime resolves the upstream to
  // 127.0.0.1:<dashboard port> rather than a container IP.
  const project = {
    id: "proj-openship",
    slug: "openship",
    port: 3001,
    cloudWorkspaceId: null,
    activeDeploymentId: "dep-1",
    organizationId: "org-1",
    webhookDomain: null,
  };

  beforeEach(() => {
    reconcile.mockReset().mockResolvedValue(undefined);
    resolveRuntime.mockReset();
    findDeployment.mockReset();
    listByProject.mockReset();

    // One public hostname → the dashboard port, no static path.
    listByProject.mockResolvedValue([
      {
        id: "dom-1",
        hostname: "panel.example.com",
        isPrimary: true,
        serviceId: null,
        targetPort: 3001,
        targetPath: null,
        domainType: "free",
      },
    ]);
    // Bare adopt deployment: truthy containerId (so we reach resolveTargetUrl),
    // runtime does NOT support containerIp → host resolves to 127.0.0.1.
    findDeployment.mockResolvedValue({
      id: "dep-1",
      containerId: "dep-1",
      meta: { runtimeMode: "bare" },
      organizationId: "org-1",
    });
    resolveRuntime.mockResolvedValue({
      routing: { provider: "bare" },
      runtime: { supports: () => false },
      effectiveTarget: "local",
      serverId: null,
    });
  });

  it("registers the self-app's own loopback dashboard route when isSelfApp is set", async () => {
    await reapplyProjectLiveRoutes(project, [], { isSelfApp: true });

    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(reconcile.mock.calls[0][1].registers).toEqual([
      { hostname: "panel.example.com", targetUrl: "http://127.0.0.1:3001", isCustomDomain: false },
    ]);
  });

  it("still refuses the same loopback dashboard route for an ordinary tenant project", async () => {
    await reapplyProjectLiveRoutes(project, []);

    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(reconcile.mock.calls[0][1].registers).toEqual([]);
  });
});
