import { beforeEach, describe, expect, it, vi } from "vitest";

const reserveObserved = vi.hoisted(() => vi.fn());
const prepareTarget = vi.hoisted(() => vi.fn());
const convergeTarget = vi.hoisted(() => vi.fn());
const withTargetLock = vi.hoisted(() => vi.fn(async (_target, run) => run()));
vi.mock("../modules/deployments/observed-host-port-claims", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../modules/deployments/observed-host-port-claims")>()),
  reserveObservedLoopbackPublishes: reserveObserved,
}));
vi.mock("../modules/deployments/pinned-host-ports", () => ({
  convergeTargetHostPortClaimsUnlocked: convergeTarget,
  prepareTargetPinnedHostPorts: prepareTarget,
  withHostPortTargetLock: withTargetLock,
}));

vi.mock("./controller-helpers", () => ({
  platform: () => ({ routing: { removeRoute: vi.fn() } }),
}));
vi.mock("./deployment-runtime", () => ({
  disposePlatform: vi.fn(),
  resolveDeploymentPlatform: vi.fn(),
}));
vi.mock("./cloud-route.service", () => ({
  reapplyCloudProjectRoute: vi.fn(),
  removeCloudProjectRoute: vi.fn(),
}));

import { reconcileProjectRoutes } from "./route-apply.service";

const target = { targetKey: "local" as const, legacyTargetKeys: [], stable: true };
const edgeProxy = { listLoopbackUpstreamPortsStrict: vi.fn(async () => new Set<number>()) };
const project = {
  id: "proj_1",
  slug: "app",
  organizationId: "org_1",
  activeDeploymentId: "dep_1",
  cloudWorkspaceId: null,
  webhookDomain: null,
  routingConfig: null,
};

describe("reconcileProjectRoutes host-port ownership gate", () => {
  beforeEach(() => {
    reserveObserved.mockReset().mockResolvedValue(undefined);
    prepareTarget.mockReset().mockResolvedValue([]);
    convergeTarget.mockReset().mockResolvedValue({ released: 0, retained: [] });
    withTargetLock.mockClear();
  });

  it("fails closed before any edge mutation when a claim conflicts", async () => {
    const conflict = new Error("host port belongs to another project");
    reserveObserved.mockRejectedValueOnce(conflict);
    const routing = { registerRoute: vi.fn(), removeRoute: vi.fn() };

    await expect(
      reconcileProjectRoutes(project, {
        routing: routing as never,
        hostPortTarget: target,
        edgeProxy,
        removes: [{ hostname: "old.example.com", isCustomDomain: true }],
        registers: [
          {
            hostname: "app.example.com",
            isCustomDomain: true,
            targetUrl: "http://127.0.0.1:23000",
            observedLoopbackPublishes: [
              { serviceId: "svc_1", containerPort: 3000, hostPort: 23000 },
            ],
          },
        ],
      }),
    ).rejects.toBe(conflict);

    expect(routing.removeRoute).not.toHaveBeenCalled();
    expect(routing.registerRoute).not.toHaveBeenCalled();
    expect(withTargetLock).toHaveBeenCalledWith(target, expect.any(Function));
  });

  it("refuses a loopback route whose stable workload metadata is missing", async () => {
    const routing = { registerRoute: vi.fn(), removeRoute: vi.fn() };

    await expect(
      reconcileProjectRoutes(project, {
        routing: routing as never,
        hostPortTarget: target,
        edgeProxy,
        registers: [
          {
            hostname: "app.example.com",
            isCustomDomain: true,
            targetUrl: "http://127.0.0.1:23000",
          },
        ],
      }),
    ).rejects.toThrow("without stable workload ownership");
    expect(reserveObserved).not.toHaveBeenCalled();
    expect(routing.registerRoute).not.toHaveBeenCalled();
  });

  it("reserves all direct and path loopback publishes before registration", async () => {
    const order: string[] = [];
    reserveObserved.mockImplementation(async () => {
      order.push("reserve");
    });
    convergeTarget.mockImplementation(async () => {
      order.push("converge");
      return { released: 0, retained: [] };
    });
    const routing = {
      removeRoute: vi.fn(),
      registerRoute: vi.fn(async () => {
        order.push("register");
      }),
    };

    await reconcileProjectRoutes(project, {
      routing: routing as never,
      hostPortTarget: target,
      edgeProxy,
      registers: [
        {
          hostname: "app.example.com",
          isCustomDomain: true,
          targetUrl: "http://127.0.0.1:23000",
          proxyLocations: [{ pathPrefix: "/api/", targetUrl: "http://127.0.0.1:23001" }],
          observedLoopbackPublishes: [
            { serviceId: "svc_web", containerPort: 3000, hostPort: 23000 },
            { serviceId: "svc_api", containerPort: 4000, hostPort: 23001 },
          ],
        },
      ],
    });

    expect(reserveObserved).toHaveBeenCalledWith({
      target,
      projectId: "proj_1",
      publishes: [
        { serviceId: "svc_web", containerPort: 3000, hostPort: 23000 },
        { serviceId: "svc_api", containerPort: 4000, hostPort: 23001 },
      ],
    });
    expect(convergeTarget).toHaveBeenCalledWith({
      target,
      projectId: "proj_1",
      desiredPublishes: [
        { serviceId: "svc_web", containerPort: 3000, hostPort: 23000 },
        { serviceId: "svc_api", containerPort: 4000, hostPort: 23001 },
      ],
      edgeProxy,
    });
    expect(order).toEqual(["reserve", "register", "converge"]);
  });

  it("does not let one vhost reserve another vhost's port through stray metadata", async () => {
    const routing = { registerRoute: vi.fn(), removeRoute: vi.fn() };

    await reconcileProjectRoutes(project, {
      routing: routing as never,
      hostPortTarget: target,
      edgeProxy,
      registers: [
        {
          hostname: "web.example.com",
          isCustomDomain: true,
          targetUrl: "http://127.0.0.1:23000",
          observedLoopbackPublishes: [
            { serviceId: "svc_web", containerPort: 3000, hostPort: 23000 },
            // This belongs to the API vhost below and must not be attributed to
            // the web registration merely because it is dialled somewhere in
            // the same reconciliation batch.
            { serviceId: "svc_wrong", containerPort: 9999, hostPort: 23001 },
          ],
        },
        {
          hostname: "api.example.com",
          isCustomDomain: true,
          targetUrl: "http://127.0.0.1:23001",
          observedLoopbackPublishes: [
            { serviceId: "svc_api", containerPort: 4000, hostPort: 23001 },
          ],
        },
      ],
    });

    expect(reserveObserved).toHaveBeenCalledWith({
      target,
      projectId: "proj_1",
      publishes: [
        { serviceId: "svc_web", containerPort: 3000, hostPort: 23000 },
        { serviceId: "svc_api", containerPort: 4000, hostPort: 23001 },
      ],
    });
  });

  it("serializes removal-only cleanup and converges with no desired publish", async () => {
    const order: string[] = [];
    const routing = {
      registerRoute: vi.fn(),
      removeRoute: vi.fn(async () => {
        order.push("remove");
      }),
    };
    convergeTarget.mockImplementation(async () => {
      order.push("converge");
      return { released: 1, retained: [] };
    });

    await reconcileProjectRoutes(project, {
      routing: routing as never,
      hostPortTarget: target,
      edgeProxy,
      removes: [{ hostname: "old.example.com", isCustomDomain: true }],
    });

    expect(withTargetLock).toHaveBeenCalledWith(target, expect.any(Function));
    expect(convergeTarget).toHaveBeenCalledWith({
      target,
      projectId: "proj_1",
      desiredPublishes: [],
      edgeProxy,
    });
    expect(order).toEqual(["remove", "converge"]);
  });

  it("converges only publishes whose best-effort route registration succeeded", async () => {
    const routing = {
      removeRoute: vi.fn(),
      registerRoute: vi.fn(async ({ domain }: { domain: string }) => {
        if (domain === "failed.example.com") throw new Error("edge reload failed");
      }),
    };

    await reconcileProjectRoutes(project, {
      routing: routing as never,
      hostPortTarget: target,
      edgeProxy,
      registers: [
        {
          hostname: "live.example.com",
          isCustomDomain: true,
          targetUrl: "http://127.0.0.1:23000",
          observedLoopbackPublishes: [
            { serviceId: "svc_live", containerPort: 3000, hostPort: 23000 },
          ],
        },
        {
          hostname: "failed.example.com",
          isCustomDomain: true,
          targetUrl: "http://127.0.0.1:23001",
          observedLoopbackPublishes: [
            { serviceId: "svc_failed", containerPort: 4000, hostPort: 23001 },
          ],
        },
      ],
    });

    // Both must be collision-gated before the first edge write. The failed
    // write is excluded from desired live state so convergence can release its
    // unused pre-reservation if the fresh edge scan does not observe it.
    expect(reserveObserved).toHaveBeenCalledWith({
      target,
      projectId: "proj_1",
      publishes: [
        { serviceId: "svc_live", containerPort: 3000, hostPort: 23000 },
        { serviceId: "svc_failed", containerPort: 4000, hostPort: 23001 },
      ],
    });
    expect(convergeTarget).toHaveBeenCalledWith({
      target,
      projectId: "proj_1",
      desiredPublishes: [{ serviceId: "svc_live", containerPort: 3000, hostPort: 23000 }],
      edgeProxy,
    });
  });

  it("does not claim an upstream suppressed by a host redirect", async () => {
    const routing = { registerRoute: vi.fn(), removeRoute: vi.fn() };

    await reconcileProjectRoutes(project, {
      routing: routing as never,
      hostPortTarget: target,
      edgeProxy,
      registers: [
        {
          hostname: "www.example.com",
          isCustomDomain: true,
          targetUrl: "http://127.0.0.1:23000",
          redirectHost: { target: "example.com", statusCode: 301 },
        },
      ],
    });

    expect(prepareTarget).not.toHaveBeenCalled();
    expect(reserveObserved).not.toHaveBeenCalled();
    expect(convergeTarget).toHaveBeenCalledWith({
      target,
      projectId: "proj_1",
      desiredPublishes: [],
      edgeProxy,
    });
  });
});
