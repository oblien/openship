import { beforeEach, describe, expect, it, vi } from "vitest";
import { Readable } from "node:stream";
import type { BackupExecutor, BackupSource, DockerRuntime, ServiceHandle } from "@repo/adapters";

const h = vi.hoisted(() => ({ project: vi.fn(), services: vi.fn(), updateService: vi.fn() }));
vi.mock("@repo/db", async original => ({ ...(await original<Record<string, unknown>>()),
  repos: { project: { findByIdInOrganization: h.project, findById: h.project },
    service: { listByProject: h.services, update: h.updateService } },
}));
vi.mock("@repo/adapters", async original => ({ ...(await original<Record<string, unknown>>()),
  resolveExecutor: (_kind: string, runtime: { backup: BackupExecutor }) => runtime.backup,
}));
import { planMigrationData, prepareMigrationVolumes, migrationUsesDirectLink,
  resolveMigrationDataItem, transferMigrationItem } from "@repo/platform/engine/modules/migration/migration-data";
import { migrationTargetPath, scopeImportedStorage } from "@repo/platform/engine/modules/migration/migration-storage";

function runtime() {
  const volumes = new Map<string, { Labels: Record<string, string>; empty: boolean }>();
  const paths = new Map<string, { empty: boolean; file?: boolean }>();
  const mounts = new Map<string, BackupSource[]>();
  const runtime = {
    volumes, paths, mounts,
    inspectContainer: vi.fn(async (id: string) => mounts.has(id) ? { state: "running" } : null),
    docker: {
      getVolume: (name: string) => ({ inspect: async () => {
        if (!volumes.has(name)) throw Object.assign(new Error("missing"), { statusCode: 404 });
        return volumes.get(name)!;
      } }),
      listContainers: vi.fn(async () => [] as unknown[]),
      createVolume: vi.fn(async (value: { Name: string; Labels: Record<string, string> }) => {
        if (!volumes.has(value.Name)) volumes.set(value.Name, { Labels: value.Labels, empty: true });
      }),
    },
    backup: {
      listSources: vi.fn(async (handle: ServiceHandle): Promise<BackupSource[]> => {
        if (handle.containerId) return mounts.get(handle.containerId) ?? [];
        return handle.volumes.map(spec => {
          const [source, target] = spec.split(":");
          return { id: source!, source: source!, target: target!, type: source!.startsWith("/") ? "bind" : "volume",
            ...(paths.get(source!)?.file ? { isDirectory: false } : {}) };
        });
      }),
      probeVolume: vi.fn(async (_handle: ServiceHandle, id: string) => ({
        exists: volumes.has(id) || paths.has(id), empty: volumes.get(id)?.empty ?? paths.get(id)?.empty ?? true,
      })),
    },
  };
  return runtime;
}
const sourceVolume = (source = "pgdata", target = "/data"): BackupSource => ({ id: source, source, target, type: "volume" });
const service = (name: string) => ({ id: name, name, volumes: [], image: "postgres:16" });
let a: ReturnType<typeof runtime>, b: ReturnType<typeof runtime>;
beforeEach(() => {
  vi.clearAllMocks();
  a = runtime(); b = runtime();
  h.project.mockResolvedValue({ id: "project", slug: "app", organizationId: "org" });
  h.services.mockResolvedValue([service("db")]);
  a.mounts.set("original", [sourceVolume()]);
});
const plan = (overrides: Partial<Parameters<typeof planMigrationData>[0]> = {}) => planMigrationData({
  projectId: "project", organizationId: "org", sourceRuntime: a as unknown as DockerRuntime,
  targetRuntime: b as unknown as DockerRuntime, scannedContainerIds: { db: "original" },
  sameServer: false, managedTarget: true, volumeStrategies: {}, customPaths: [], conflictResolution: {},
  log: () => {}, ...overrides,
});

describe("shared migration data planning", () => {
  it.each([false, true])("mounts the same anonymous and explicit copies the transfer writes (managed=%s)", async managed => {
    h.services.mockResolvedValue([service("db"), service("attached")]);
    const mounts = ["anonymous-012345", "openship-app-data"].map(source => ({
      type: "volume" as const, source, target: `/${source}`, rw: true,
    }));
    a.mounts.set("original", mounts.map(mount => sourceVolume(mount.source, mount.target)));
    const result = await plan({ sameServer: true, managedTarget: managed,
      targetRuntime: a as unknown as DockerRuntime, volumeStrategies: { db: "copy" } });
    await scopeImportedStorage("project", managed, new Map([["db", mounts]]), true);
    expect(h.updateService).toHaveBeenCalledExactlyOnceWith("db", {
      volumes: result.items.map(item => `${item.dest}:/${item.source}`), namespaceVolumes: managed,
    });
    expect(result.items.map(item => item.dest)).toEqual([
      "openship-app-anonymous-012345", "openship-app-openship-app-data",
    ]);
  });

  it("copies same-server managed file binds into the path mounted by the new service", async () => {
    const source = "/srv/app/config.conf";
    a.mounts.set("original", [{ id: source, source, target: "/config.conf", type: "bind", isDirectory: false }]);
    const result = await plan({ sameServer: true, targetRuntime: a as unknown as DockerRuntime, volumeStrategies: { db: "copy" } });
    await scopeImportedStorage("project", true, new Map([["db", [
      { source, target: "/config.conf", type: "bind", rw: false },
    ]]]), true);
    expect(result.items).toHaveLength(1);
    expect(h.updateService).toHaveBeenCalledWith("db", {
      volumes: [`${result.items[0]!.dest}:/config.conf:ro`], namespaceVolumes: true,
    });
  });

  it("copies live anonymous volumes and file binds into the project's managed storage", async () => {
    a.mounts.set("original", [sourceVolume("012345abcdef"),
      { id: "/srv/app/config.conf", source: "/srv/app/config.conf", target: "/config.conf", type: "bind", isDirectory: false }]);
    const result = await plan();
    expect(result.createdVolumes).toEqual(["openship-app-012345abcdef"]);
    expect(result.items[0]).toMatchObject({ source: "012345abcdef", dest: "openship-app-012345abcdef" });
    expect(result.items[1]).toMatchObject({ source: "/srv/app/config.conf",
      dest: migrationTargetPath("project", "/srv/app/config.conf", true), src: { isFile: true } });
  });

  it("has one writer for a shared volume and skips services without source containers", async () => {
    h.services.mockResolvedValue([service("db"), service("worker"), service("new-from-repo")]);
    a.mounts.set("worker-original", [sourceVolume()]);
    const result = await plan({ scannedContainerIds: { db: "original", worker: "worker-original" } });
    expect(result.items).toHaveLength(1);
    expect(a.inspectContainer).toHaveBeenCalledTimes(2);
  });

  it.each(["keep", "override", "clone"] as const)("refuses a sibling's volume even with %s consent", async action => {
    a.mounts.set("original", [sourceVolume("openship-app-staging-data")]);
    b.volumes.set("openship-app-staging-data", { Labels: { "openship.project": "sibling" }, empty: false });
    await expect(plan({ conflictResolution: { "openship-app-staging-data": action } })).rejects.toMatchObject({ code: "CLOUD_VOLUME_CONFLICT" });
    expect(b.docker.createVolume).not.toHaveBeenCalled();
  });

  it("does not inherit overwrite consent from another volume", async () => {
    b.volumes.set("pgdata", { Labels: {}, empty: false });
    await expect(plan({ managedTarget: false, conflictResolution: { other: "override" } })).rejects.toThrow(/already contains data/);
  });

  it("checks the clone destination instead of assuming a scoped name is empty", async () => {
    b.volumes.set("openship-app-pgdata", { Labels: { "openship.project": "project" }, empty: false });
    await expect(plan({ managedTarget: false, conflictResolution: { pgdata: "clone" } })).rejects.toThrow(/already contains data/);
  });

  it("requires the exact project label AND no users before reusing unfinished data", async () => {
    b.volumes.set("openship-app-pgdata", { Labels: { "openship.project": "project" }, empty: false });
    expect((await plan()).items).toHaveLength(1);
    b.docker.listContainers.mockResolvedValue([{ Id: "stopped-sibling" }]);
    await expect(plan()).rejects.toThrow(/already contains data/);
  });

  it("keeps existing data without copying or adding it to rollback cleanup", async () => {
    b.volumes.set("openship-app-pgdata", { Labels: { "openship.project": "project" }, empty: false });
    expect(await plan({ conflictResolution: { pgdata: "keep" } })).toMatchObject({ items: [], createdVolumes: [] });
    b.volumes.clear();
    await expect(plan({ conflictResolution: { pgdata: "keep" } })).rejects.toThrow(/no longer exists/);
  });

  it("does not remove a pre-existing overwrite target when an unrelated part of planning fails", async () => {
    b.volumes.set("pgdata", { Labels: {}, empty: false });
    const result = await plan({ managedTarget: false, conflictResolution: { pgdata: "override" } });
    expect(result.items).toHaveLength(1);
    expect(result.createdVolumes).toEqual([]);
  });

  it("fails closed when the target volume cannot be inspected", async () => {
    b.volumes.set("openship-app-pgdata", { Labels: { "openship.project": "project" }, empty: false });
    b.backup.probeVolume.mockRejectedValue(new Error("connection lost"));
    await expect(plan()).rejects.toThrow(/could not be verified/);
  });

  it("rechecks persisted ownership if another operation creates the volume after planning", async () => {
    const result = await plan();
    b.volumes.set(result.createdVolumes[0]!, { Labels: { "openship.project": "sibling" }, empty: true });
    await expect(prepareMigrationVolumes({ runtime: b as unknown as DockerRuntime, projectId: "project",
      runId: "run", managed: true, plan: result })).rejects.toThrow(/another operation/);
    expect(b.volumes.get(result.createdVolumes[0]!)?.Labels["openship.project"]).toBe("sibling");
  });

  it("refuses two different sources or overlapping directories writing one target path", async () => {
    await expect(plan({ managedTarget: false, customPaths: [{ source: "/srv/a", dest: "/copy" },
      { source: "/srv/b", dest: "/copy" }] })).rejects.toThrow(/different transfers/);
    await expect(plan({ managedTarget: false, customPaths: [{ source: "/srv/a", dest: "/copy" },
      { source: "/srv/b", dest: "/copy/subdir" }] })).rejects.toThrow(/Overlapping destinations/);
  });

  it("uses the original container's resolved volume for same-server copy", async () => {
    a.mounts.set("original", [sourceVolume("actual-anonymous-volume")]);
    const result = await plan({ sameServer: true, managedTarget: false, targetRuntime: a as unknown as DockerRuntime,
      volumeStrategies: { db: "copy" } });
    expect(result.items[0]).toMatchObject({ source: "actual-anonymous-volume", dest: "openship-app-actual-anonymous-volume" });
    expect(result.items[0]!.src.exec).toBe(result.items[0]!.dst.exec);
  });
});

describe("transport and resume", () => {
  it("uses a direct pull for an external source and streaming for two managed hosts", () => {
    expect(migrationUsesDirectLink({ sameServer: false, managedSource: false, managedTarget: true })).toBe(true);
    expect(migrationUsesDirectLink({ sameServer: false, managedSource: true, managedTarget: true })).toBe(false);
    expect(migrationUsesDirectLink({ sameServer: false, managedSource: false, managedTarget: true, mode: "stream" })).toBe(false);
  });

  it.each([Buffer.from("config=data\n"), Buffer.alloc(0)])("streams a file's bytes and preserves its reviewed destination", async bytes => {
    a.paths.set("/new/config", { empty: bytes.length === 0, file: true });
    const sourceExecutor = { ...a.backup, streamPath: vi.fn(async () => ({
      stdout: Readable.from([bytes]), awaitExit: Promise.resolve({ code: 0, stderr: "" }),
    })) } as unknown as BackupExecutor;
    const written: Buffer[] = [];
    const destination = { ...b.backup, receiveStream: vi.fn(async (_h, _id, input) => {
      for await (const chunk of input) written.push(Buffer.from(chunk));
      return { bytesWritten: Buffer.concat(written).length };
    }) } as unknown as BackupExecutor;
    const item = await resolveMigrationDataItem({ key: "config", kind: "bind", source: "/new/config",
      dest: "/managed/project/config", serviceName: "db", projectId: "project", projectSlug: "app",
      sourceExecutor, targetExecutor: destination });
    await transferMigrationItem(item, { log: () => {}, mode: "stream" });
    expect(Buffer.concat(written)).toEqual(bytes);
    expect(destination.receiveStream).toHaveBeenCalledWith(expect.anything(), "/managed/project/config", expect.anything(),
      expect.objectContaining({ sourceIsFile: true }));
    const link = { transferPath: vi.fn(), transferVolume: vi.fn() };
    await transferMigrationItem(item, { link: link as never, log: () => {} });
    expect(link.transferPath).toHaveBeenCalledWith("/new/config", "/managed/project/config", undefined);
  });
});
