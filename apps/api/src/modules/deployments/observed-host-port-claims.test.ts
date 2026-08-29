import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HostPortTargetIdentity } from "../../lib/host-port-target";
import {
  observedLoopbackPublishFromUrl,
  reserveObservedLoopbackPublishes,
  reserveResolvedLoopbackRoutes,
} from "./observed-host-port-claims";

const reserve = vi.hoisted(() => vi.fn());
vi.mock("./pinned-host-ports", () => ({ reserveTargetPinnedHostPort: reserve }));

const target: HostPortTargetIdentity = {
  targetKey: "local",
  legacyTargetKeys: [],
  stable: true,
};

describe("observed host-port claims", () => {
  beforeEach(() => reserve.mockReset().mockResolvedValue({}));

  it("extracts only concrete HTTP(S) loopback publishes", () => {
    expect(
      observedLoopbackPublishFromUrl({
        targetUrl: "http://127.0.0.1:23000",
        serviceId: "svc_api",
        containerPort: 3000,
      }),
    ).toEqual({ serviceId: "svc_api", containerPort: 3000, hostPort: 23000 });
    expect(
      observedLoopbackPublishFromUrl({
        targetUrl: "https://[::1]:24443",
        serviceId: null,
        containerPort: 8443,
      }),
    ).toEqual({ serviceId: null, containerPort: 8443, hostPort: 24443 });
    expect(
      observedLoopbackPublishFromUrl({
        targetUrl: "http://172.18.0.4:3000",
        serviceId: "svc_api",
        containerPort: 3000,
      }),
    ).toBeNull();
    expect(
      observedLoopbackPublishFromUrl({
        targetUrl: "tcp://127.0.0.1:23000",
        serviceId: "svc_api",
        containerPort: 3000,
      }),
    ).toBeNull();
  });

  it("reserves every distinct exact mapping under the physical target", async () => {
    await reserveObservedLoopbackPublishes({
      target,
      projectId: "proj_1",
      publishes: [
        { serviceId: "svc_api", containerPort: 3000, hostPort: 23000 },
        { serviceId: "svc_api", containerPort: 3001, hostPort: 23001 },
        { serviceId: "svc_api", containerPort: 3000, hostPort: 23000 },
      ],
    });

    expect(reserve.mock.calls).toEqual([
      [target, { projectId: "proj_1", serviceId: "svc_api", containerPort: 3000, port: 23000 }],
      [target, { projectId: "proj_1", serviceId: "svc_api", containerPort: 3001, port: 23001 }],
    ]);
  });

  it("propagates a conflict and does not reserve later mappings", async () => {
    const conflict = new Error("reserved by another owner");
    reserve.mockRejectedValueOnce(conflict);

    await expect(
      reserveObservedLoopbackPublishes({
        target,
        projectId: "proj_1",
        publishes: [
          { serviceId: "svc_api", containerPort: 3000, hostPort: 23000 },
          { serviceId: "svc_api", containerPort: 3001, hostPort: 23001 },
        ],
      }),
    ).rejects.toBe(conflict);
    expect(reserve).toHaveBeenCalledTimes(1);
  });

  it("ignores bridge URLs but requires a physical target for loopback", async () => {
    await expect(
      reserveResolvedLoopbackRoutes({
        target: null,
        projectId: "proj_1",
        routes: [
          {
            targetUrl: "http://172.18.0.4:3000",
            serviceId: "svc_api",
            containerPort: 3000,
          },
        ],
      }),
    ).resolves.toBeUndefined();

    await expect(
      reserveResolvedLoopbackRoutes({
        target: null,
        projectId: "proj_1",
        routes: [
          {
            targetUrl: "http://127.0.0.1:23000",
            serviceId: "svc_api",
            containerPort: 3000,
          },
        ],
      }),
    ).rejects.toThrow("without a resolved physical host-port target");
  });

  it("rejects loopback routes whose workload owner has no valid container port", async () => {
    await expect(
      reserveResolvedLoopbackRoutes({
        target,
        projectId: "proj_1",
        routes: [
          {
            targetUrl: "http://127.0.0.1:23000",
            serviceId: "svc_api",
            containerPort: 0,
          },
        ],
      }),
    ).rejects.toThrow("without a valid container-port owner");
    expect(reserve).not.toHaveBeenCalled();
  });
});
