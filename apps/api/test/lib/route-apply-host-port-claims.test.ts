import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db, HOST_PORT_QUARANTINE_OWNER, repos, schema, type HostPortClaim } from "@repo/db";
import {
  allocateHostPort,
  loopbackPortInventoryFor,
  NginxProvider,
  OPENRESTY_DEFAULT_PATHS,
  rootChecked,
  type CommandExecutor,
  type Platform,
  type RuntimeAdapter,
} from "@repo/adapters";
import type { HostPortTargetIdentity } from "@repo/platform/engine/lib/host-port-target";
import { reconcileProjectRoutes } from "@repo/platform/engine/lib/route-apply.service";
import {
  allocateAndReservePinnedHostPort,
  prepareTargetPinnedHostPorts,
  reserveTargetPinnedHostPort,
  withHostPortTargetLock,
} from "@repo/platform/engine/modules/deployments/pinned-host-ports";

// Real claim repository, target lock, inventory and route reconciliation. Only
// edge I/O is controlled; Vitest gives @repo/db an isolated in-memory PGlite.
const localTarget: HostPortTargetIdentity = {
  targetKey: "local",
  legacyTargetKeys: [],
  stable: true,
};
const remoteTarget: HostPortTargetIdentity = {
  targetKey: `host:${"a".repeat(64)}`,
  legacyTargetKeys: ["server:srv_1"],
  stable: true,
};
const project = {
  id: "proj_1",
  slug: "app",
  organizationId: "org_1",
  workspaceId: null,
  activeDeploymentId: "dep_1",
};
const owner = { projectId: project.id, serviceId: "svc_api", containerPort: 3000, port: 23000 };

function routeOptions(hostPortTarget = localTarget) {
  const registerRoute = vi.fn(async () => {});
  const removeRoute = vi.fn(async () => {});
  const runtime = {
    supports: vi.fn((capability: string) => capability === "containerInfo"),
    getContainerInfo: vi.fn<RuntimeAdapter["getContainerInfo"]>(async () => ({
      containerId: "container_api",
      status: "running",
      hostPort: owner.port,
      hostPortByContainerPort: { [owner.containerPort]: owner.port },
    })),
  };
  return {
    hostPortTarget,
    runtime,
    routing: { registerRoute, removeRoute } as unknown as Platform["routing"],
    registerRoute,
    removeRoute,
    // The second port belongs to an unknown vhost and must stay quarantined.
    edgeProxy: { listLoopbackUpstreamPortsStrict: async () => new Set([23000, 24000]) },
    registers: [
      {
        hostname: "app.example.com",
        isCustomDomain: true,
        targetUrl: "http://127.0.0.1:23000",
        observedLoopbackPublishes: [
          {
            serviceId: owner.serviceId,
            containerId: "container_api" as string | undefined,
            containerPort: owner.containerPort,
            hostPort: owner.port,
          },
        ],
      },
    ],
  };
}

describe("live route host-port recovery (#915)", () => {
  beforeAll(async () => {
    await db.insert(schema.organization).values({ id: project.organizationId, name: "Routing" });
    const group = await repos.projectGroup.create({
      organizationId: project.organizationId, name: "Routing", slug: "routing",
    });
    await db.insert(schema.project).values({ ...project, groupId: group.id, name: "App" });
  });

  beforeEach(async () => {
    await db.delete(schema.hostPortClaim);
  });

  it("quarantines a stale route before allocating through a disabled host channel", async () => {
    // There is no database claim or listener for this orphan vhost. A Docker
    // bind on 20000 would succeed and serve the new workload on its old hostname.
    let dump =
      "http { server { listen 80; server_name old.example.com; location / { proxy_pass http://127.0.0.1:20000; } } }";
    const command = vi.fn(async () => dump);
    const routing = new NginxProvider({
      paths: OPENRESTY_DEFAULT_PATHS,
      containerEdge: true,
      executor: rootChecked({ exec: command } as unknown as CommandExecutor, "test socket edge"),
    });
    const host = {
      exec: vi.fn(async () => {
        throw new Error("host channel unavailable");
      }),
    } as unknown as CommandExecutor;
    const inventory = loopbackPortInventoryFor(routing, host);
    const allocated = await withHostPortTargetLock(localTarget, async () => {
      const claims = await prepareTargetPinnedHostPorts({
        target: localTarget,
        edgeProxy: inventory,
      });
      return allocateAndReservePinnedHostPort({
        target: localTarget,
        claims,
        owner: { projectId: project.id, serviceId: owner.serviceId, containerPort: 8080 },
        allocate: (options) => allocateHostPort(host, options),
      });
    });
    expect(allocated.port).toBe(20001);
    expect(await repos.hostPortClaim.listHostPortClaims(localTarget.targetKey)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ port: 20000, projectId: HOST_PORT_QUARANTINE_OWNER }),
        expect.objectContaining({ port: 20001, projectId: project.id }),
      ]),
    );
    // Route mutation must refresh through the same socket, not retain a stale dump.
    dump = "http { server { listen 80; server_name _; return 404; } }";
    await expect(inventory.listLoopbackUpstreamPortsStrict({ refresh: true })).resolves.toEqual(
      new Set(),
    );
    dump = "";
    await expect(inventory.listLoopbackUpstreamPortsStrict({ refresh: true })).rejects.toThrow(
      "config dump was empty",
    );
  });

  it("uses the routing provider's inventory when repairing a live loopback route", async () => {
    const options = routeOptions();
    options.edgeProxy.listLoopbackUpstreamPortsStrict = async () => {
      throw new Error("host channel unavailable");
    };
    options.routing.listLoopbackUpstreamPortsStrict = async () => new Set([23000, 24000]);
    await reconcileProjectRoutes(project, options);
    expect(options.registerRoute).toHaveBeenCalledOnce();
    expect(await repos.hostPortClaim.listHostPortClaims(localTarget.targetKey)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ ...owner }),
        expect.objectContaining({ port: 24000, projectId: HOST_PORT_QUARANTINE_OWNER }),
      ]),
    );
  });

  describe.each([
    ["local", localTarget],
    ["remote", remoteTarget],
  ] as const)("%s target", (_name, target) => {
    it("atomically recovers an existing quarantine and keeps repeated retries idempotent", async () => {
      const quarantined = await repos.hostPortClaim.reserveQuarantinedHostPortClaim({
        targetKey: target.targetKey,
        port: owner.port,
      });
      // New allocations have no live ownership proof and must still fail.
      await expect(reserveTargetPinnedHostPort(target, owner)).rejects.toThrow("already reserved");
      const options = routeOptions(target);
      const claimsAtRegistration: HostPortClaim[][] = [];
      options.registerRoute.mockImplementation(async () => {
        claimsAtRegistration.push(await repos.hostPortClaim.listHostPortClaims(target.targetKey));
      });

      await reconcileProjectRoutes(project, options);
      await reconcileProjectRoutes(project, options);

      expect(options.registerRoute).toHaveBeenCalledTimes(2);
      expect(options.runtime.getContainerInfo).toHaveBeenCalledExactlyOnceWith("container_api");
      for (const claims of claimsAtRegistration) {
        expect(claims).toContainEqual(expect.objectContaining({ ...owner, id: quarantined.id }));
      }
      expect(await repos.hostPortClaim.listHostPortClaims(target.targetKey)).toEqual([
        expect.objectContaining({ ...owner, id: quarantined.id }),
        expect.objectContaining({ port: 24000, projectId: HOST_PORT_QUARANTINE_OWNER }),
      ]);
    });

    it("recovers a live upstream quarantined by the same retry's inventory", async () => {
      const options = routeOptions(target);

      await reconcileProjectRoutes(project, options);

      expect(options.registerRoute).toHaveBeenCalledOnce();
      expect(await repos.hostPortClaim.listHostPortClaims(target.targetKey)).toEqual([
        expect.objectContaining(owner),
        expect.objectContaining({ port: 24000, projectId: HOST_PORT_QUARANTINE_OWNER }),
      ]);
    });
  });

  describe("unverified bindings", () => {
    it("rechecks the binding after waiting for another target mutation", async () => {
      const quarantined = await repos.hostPortClaim.reserveQuarantinedHostPortClaim({
        targetKey: localTarget.targetKey,
        port: owner.port,
      });
      const options = routeOptions();
      let release!: () => void;
      let entered!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const held = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const mutation = withHostPortTargetLock(localTarget, async () => {
        entered();
        await gate;
      });
      await held;
      const retry = expect(reconcileProjectRoutes(project, options)).rejects.toThrow();
      // The metadata was captured before a concurrent deploy changed the bind.
      // Recovery must inspect after this mutation releases the target lock.
      options.runtime.getContainerInfo.mockResolvedValue({
        containerId: "container_api",
        status: "running",
        hostPortByContainerPort: { 3000: 23001 },
      });
      release();
      await mutation;
      await retry;

      expect(options.registerRoute).not.toHaveBeenCalled();
      expect(await repos.hostPortClaim.listHostPortClaims(localTarget.targetKey)).toContainEqual(
        quarantined,
      );
    });

    it.each([
      ["a stopped container", "stopped", { 3000: 23000 }],
      ["a changed host port", "running", { 3000: 23001 }],
      ["another container port", "running", { 4000: 23000 }],
      ["an ambiguous scalar publish", "running", undefined],
    ] as const)("keeps quarantine for %s", async (_name, status, bindings) => {
      const quarantined = await repos.hostPortClaim.reserveQuarantinedHostPortClaim({
        targetKey: localTarget.targetKey,
        port: owner.port,
      });
      const options = routeOptions();
      options.runtime.getContainerInfo.mockResolvedValue({
        containerId: "container_api",
        status,
        hostPort: owner.port,
        hostPortByContainerPort: bindings,
      });

      await expect(reconcileProjectRoutes(project, options)).rejects.toThrow();

      expect(options.registerRoute).not.toHaveBeenCalled();
      expect(await repos.hostPortClaim.listHostPortClaims(localTarget.targetKey)).toContainEqual(
        quarantined,
      );
    });

    it.each(["unsupported", "unreachable", "missing identity"])(
      "keeps quarantine when runtime verification is %s",
      async (condition) => {
        const quarantined = await repos.hostPortClaim.reserveQuarantinedHostPortClaim({
          targetKey: localTarget.targetKey,
          port: owner.port,
        });
        const options = routeOptions();
        if (condition === "unsupported") options.runtime.supports.mockReturnValue(false);
        if (condition === "unreachable") {
          options.runtime.getContainerInfo.mockRejectedValue(new Error("runtime unreachable"));
        }
        if (condition === "missing identity") {
          options.registers[0]!.observedLoopbackPublishes[0]!.containerId = undefined;
        }

        await expect(reconcileProjectRoutes(project, options)).rejects.toThrow();

        expect(options.registerRoute).not.toHaveBeenCalled();
        expect(await repos.hostPortClaim.listHostPortClaims(localTarget.targetKey)).toContainEqual(
          quarantined,
        );
      },
    );
  });

  it.each([
    { projectId: "another_project" },
    { serviceId: "another_service" },
    { containerPort: 4000 },
  ])("preserves a conflicting workload %j before any edge mutation", async (otherOwner) => {
    const existing = await repos.hostPortClaim.reserveHostPortClaim({
      targetKey: localTarget.targetKey,
      ...owner,
      ...otherOwner,
    });
    const options = routeOptions();

    await expect(
      reconcileProjectRoutes(project, {
        ...options,
        removes: [{ hostname: "old.example.com", isCustomDomain: true }],
      }),
    ).rejects.toThrow("already reserved");

    expect(options.registerRoute).not.toHaveBeenCalled();
    expect(options.removeRoute).not.toHaveBeenCalled();
    expect(await repos.hostPortClaim.listHostPortClaims(localTarget.targetKey)).toContainEqual(
      existing,
    );
  });

  it("still refines a matching legacy scalar claim without replacing its identity", async () => {
    const existing = await repos.hostPortClaim.reserveHostPortClaim({
      targetKey: localTarget.targetKey,
      ...owner,
      containerPort: null,
    });
    const options = routeOptions();

    await reconcileProjectRoutes(project, options);

    expect(options.registerRoute).toHaveBeenCalledOnce();
    expect(await repos.hostPortClaim.listHostPortClaims(localTarget.targetKey)).toContainEqual(
      expect.objectContaining({ ...owner, id: existing.id }),
    );
  });

  it("leaves the same port on another physical host untouched", async () => {
    const otherHost = await repos.hostPortClaim.reserveHostPortClaim({
      targetKey: remoteTarget.targetKey,
      ...owner,
      projectId: "another_project",
    });

    await reconcileProjectRoutes(project, routeOptions(localTarget));

    expect(await repos.hostPortClaim.listHostPortClaims(remoteTarget.targetKey)).toEqual([
      otherHost,
    ]);
    expect(await repos.hostPortClaim.listHostPortClaims(localTarget.targetKey)).toContainEqual(
      expect.objectContaining(owner),
    );
  });
});

describe("control-plane dashboard route recovery (#1019)", () => {
  const selfApp = {
    ...project,
    id: "proj_openship",
    slug: "openship",
    activeDeploymentId: "dep_adopt",
  };
  const dashboard = { serviceId: null, containerPort: 3001, hostPort: 3001 };

  beforeAll(async () => {
    await db
      .insert(schema.organization)
      .values({ id: project.organizationId, name: "Routing" })
      .onConflictDoNothing();
    const group = await repos.projectGroup.create({
      organizationId: project.organizationId,
      name: "Self app",
      slug: "self-app",
    });
    await db.insert(schema.project).values({
      ...selfApp,
      groupId: group.id,
      name: "Openship",
      appTemplateId: "openship",
    });
  });

  // The adopted dashboard is a host process: no container, no runtime proof.
  function dashboardRoute(controlPlanePort?: number) {
    const registerRoute = vi.fn(async () => {});
    return {
      hostPortTarget: localTarget,
      runtime: { supports: vi.fn(() => false), getContainerInfo: vi.fn() },
      routing: {
        registerRoute,
        removeRoute: vi.fn(async () => {}),
      } as unknown as Platform["routing"],
      registerRoute,
      // A dashboard vhost from the previous setup run with no durable claim.
      edgeProxy: { listLoopbackUpstreamPortsStrict: async () => new Set([3001]) },
      ...(controlPlanePort ? { controlPlanePort } : {}),
      registers: [
        {
          hostname: "new-domain.example.com",
          isCustomDomain: true,
          targetUrl: "http://127.0.0.1:3001",
          observedLoopbackPublishes: [{ ...dashboard, containerId: undefined }],
        },
      ],
    };
  }

  beforeEach(async () => {
    await db.delete(schema.hostPortClaim);
  });

  it("recovers the quarantined dashboard port for the control plane's own route", async () => {
    const options = dashboardRoute(3001);

    await reconcileProjectRoutes(selfApp, options);
    await reconcileProjectRoutes(selfApp, options);

    expect(options.registerRoute).toHaveBeenCalledTimes(2);
    expect(await repos.hostPortClaim.listHostPortClaims(localTarget.targetKey)).toEqual([
      expect.objectContaining({
        projectId: selfApp.id,
        serviceId: null,
        port: 3001,
        containerPort: 3001,
      }),
    ]);
  });

  it("keeps the quarantine for a route that is not the control plane's", async () => {
    const options = dashboardRoute();

    await expect(reconcileProjectRoutes(selfApp, options)).rejects.toThrow(
      "Host port 3001 is already reserved on local",
    );
    expect(options.registerRoute).not.toHaveBeenCalled();
    expect(await repos.hostPortClaim.listHostPortClaims(localTarget.targetKey)).toEqual([
      expect.objectContaining({ port: 3001, projectId: HOST_PORT_QUARANTINE_OWNER }),
    ]);
  });

  it("never takes the dashboard port from another workload's claim", async () => {
    const other = await repos.hostPortClaim.reserveHostPortClaim({
      targetKey: localTarget.targetKey,
      projectId: "another_project",
      serviceId: "svc_other",
      port: 3001,
      containerPort: 3001,
    });
    const options = dashboardRoute(3001);

    await expect(reconcileProjectRoutes(selfApp, options)).rejects.toThrow("already reserved");
    expect(options.registerRoute).not.toHaveBeenCalled();
    expect(await repos.hostPortClaim.listHostPortClaims(localTarget.targetKey)).toEqual([other]);
  });
});
