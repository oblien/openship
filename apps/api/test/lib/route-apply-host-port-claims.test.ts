import { beforeEach, describe, expect, it, vi } from "vitest";
import { db, HOST_PORT_QUARANTINE_OWNER, repos, schema, type HostPortClaim } from "@repo/db";
import type { Platform, RuntimeAdapter } from "@repo/adapters";
import type { HostPortTargetIdentity } from "@repo/platform/engine/lib/host-port-target";
import { reconcileProjectRoutes } from "@repo/platform/engine/lib/route-apply.service";
import {
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
  beforeEach(async () => {
    await db.delete(schema.hostPortClaim);
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
