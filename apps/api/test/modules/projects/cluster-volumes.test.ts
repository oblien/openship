import { afterEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { ClusterVolumeAdapter } from "@repo/adapters";
import type { ClusterVolume } from "@repo/core";
import { CLUSTER_STORAGE_STEPS } from "@repo/core";
import { createShip } from "@repo/sdk/native";
import { OpenshipClient } from "@repo/sdk/client";
import { repos, seedOwner, type SeededOwner } from "../jobs/_harness";
import { seedClusterProject } from "../../helpers/cluster-project";
import { projectRoutes } from "../../../src/modules/projects/project.routes";
import { serverManagementRoutes } from "../../../src/modules/system/server-management.routes";
import { healthRoutes } from "../../../src/modules/health/health.routes";
import { handleApiError } from "../../../src/middleware/error-handler";
import { getPlatformKernel } from "@repo/platform/engine/lib/platform";
import * as target from "@repo/platform/engine/lib/cluster-deployment-target";
import * as lifecycle from "@repo/platform/engine/modules/system/network-setup-lifecycle";

const app = new Hono()
  .onError(handleApiError)
  .route("/api/health", healthRoutes)
  .route("/api/projects", projectRoutes)
  .route("/api/system", serverManagementRoutes);
async function clients(owner: SeededOwner) {
  const user = (await repos.user.findById(owner.userId))!;
  const ship = createShip({
    platform: getPlatformKernel(),
    identity: {
      resolve: async () => ({
        user: { id: user.id, name: user.name, email: user.email },
        sessionId: "files-test",
      }),
    },
  });
  const native = await ship.scope({ identity: "verified", organizationId: owner.orgId });
  const remote = new OpenshipClient({
    baseUrl: "http://openship.test",
    organizationId: owner.orgId,
    token: owner.token,
    fetch: ((url, init) => app.request(url as string, init)) as typeof fetch,
  });
  return { native, remote };
}
const files: ClusterVolume = {
  name: "uploads",
  resourceVersion: "1",
  sizeGiB: 5,
  phase: "Bound",
  state: "attached",
  robustness: "healthy",
  volumeName: "disk",
  message: null,
  copies: [],
  desiredCopies: 2,
  backups: [],
  backupSchedule: { frequency: "manual", retain: 7 },
};

afterEach(() => vi.restoreAllMocks());
describe("shared storage through HTTP, native operations and SSE", () => {
  it("persists one setup request and resumes an interrupted attempt only after an explicit retry", async () => {
    const dispatch = vi.spyOn(lifecycle, "deferNetworkSetupWork").mockResolvedValue(undefined);
    const owner = await seedOwner(),
      project = await seedClusterProject(owner);
    const { native, remote } = await clients(owner);
    const input = {
      clusterId: project.clusterId,
      requestId: crypto.randomUUID(),
      config: {
        replicas: 2,
        disks: project.plan.hosts.map((h) => ({
          serverId: h.serverId,
          path: "/var/lib/openship/storage",
          reservedGiB: 5,
        })),
      },
    };
    const created = await remote.servers.setupClusterStorage(input);
    expect(await native.servers.setupClusterStorage(input)).toEqual(created);
    expect(dispatch).toHaveBeenCalledOnce();
    await repos.clusterStorage.interrupt(created.id, created.generation, "Controller restarted");
    for (const client of [native, remote]) {
      const cancel = new AbortController();
      const events = client.servers
        .clusterStorageEvents(project.clusterId, { signal: cancel.signal })
        [Symbol.asyncIterator]();
      try {
        const event = (await events.next()).value!;
        expect(JSON.parse(event.data).run).toMatchObject({
          status: "interrupted",
          error: "Controller restarted",
        });
        expect(event.data).not.toMatch(/leaseExpiresAt|requestId|privateKey/);
      } finally {
        cancel.abort();
        await events.return?.();
      }
    }
    expect(dispatch).toHaveBeenCalledOnce();
    const stopped = await native.servers.getClusterStorage({ clusterId: project.clusterId });
    const retried = await remote.servers.retryClusterStorage({
      clusterId: project.clusterId,
      sequence: stopped!.sequence,
    });
    expect(retried).toMatchObject({ status: "setting_up", generation: created.generation + 1 });
    expect(dispatch).toHaveBeenCalledTimes(2);
    const other = await clients(await seedOwner());
    for (const client of [other.native, other.remote])
      await expect(
        client.servers.getClusterStorage({ clusterId: project.clusterId }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("shares file actions and refreshed snapshots without exposing credentials or replaying mutations", async () => {
    const owner = await seedOwner(),
      project = await seedClusterProject(owner);
    const { native, remote } = await clients(owner);
    const { row } = await repos.clusterStorage.start({
      organizationId: owner.orgId,
      clusterId: project.clusterId,
      runtimeId: project.runtime.id,
      requestId: crypto.randomUUID(),
      config: {
        replicas: 2,
        disks: project.plan.hosts.map((h) => ({
          serverId: h.serverId,
          path: "/var/lib/openship/storage",
          reservedGiB: 5,
        })),
      },
    });
    const progress = {
      steps: CLUSTER_STORAGE_STEPS.map((id) => ({
        id,
        status: "completed" as const,
        message: null,
        startedAt: null,
        finishedAt: null,
      })),
      logs: [],
    };
    await repos.clusterStorage.finish(
      row.id,
      row.generation,
      progress,
      { ready: true, observedAt: new Date().toISOString(), nodes: [], volumes: [] },
      null,
    );
    const dispose = vi.fn(async () => {});
    vi.spyOn(target, "openClusterApi").mockResolvedValue({
      runtime: project.runtime,
      api: { dispose },
    } as unknown as Awaited<ReturnType<typeof target.openClusterApi>>);
    vi.spyOn(ClusterVolumeAdapter.prototype, "list").mockResolvedValue([files]);
    // Archive listing and removal have their own ownership tests in the adapter.
    const { VolumeBackups } =
      await import("../../../../../packages/adapters/src/cluster/volume-backups");
    vi.spyOn(VolumeBackups.prototype, "list").mockResolvedValue([]);
    const create = vi.spyOn(ClusterVolumeAdapter.prototype, "create").mockResolvedValue(files);
    const remove = vi
      .spyOn(ClusterVolumeAdapter.prototype, "remove")
      .mockResolvedValue({ removed: true });
    const input = { name: "uploads", sizeGiB: 5, requestId: crypto.randomUUID() };
    for (const client of [native, remote]) {
      expect(await client.projects.createClusterVolume(project.id, input)).toEqual(files);
      expect(await client.projects.listClusterVolumes(project.id)).toEqual([files]);
      const cancel = new AbortController();
      const events = client.projects
        .streamClusterVolumeEvents(project.id, { signal: cancel.signal })
        [Symbol.asyncIterator]();
      try {
        const event = (await events.next()).value!;
        expect(JSON.parse(event.data).run).toEqual({ volumes: [files], backups: [] });
      } finally {
        cancel.abort();
        await events.return?.();
      }
      await expect(
        client.projects.removeClusterVolume(project.id, {
          name: files.name,
          resourceVersion: "1",
          confirmName: "wrong",
          deleteData: true,
        }),
      ).rejects.toMatchObject({ code: "CLUSTER_VOLUME_CONFIRMATION" });
    }
    expect(create).toHaveBeenCalledTimes(2);
    expect(remove).not.toHaveBeenCalled();
    await remote.projects.removeClusterVolume(project.id, {
      name: files.name,
      resourceVersion: "1",
      confirmName: files.name,
      deleteData: true,
    });
    expect(remove).toHaveBeenCalledWith("uploads", "1");
    const other = await clients(await seedOwner());
    for (const client of [other.native, other.remote])
      await expect(client.projects.createClusterVolume(project.id, input)).rejects.toMatchObject({
        code: "NOT_FOUND",
      });
    expect(create).toHaveBeenCalledTimes(2);
    expect(dispose).toHaveBeenCalled();
  });
});
