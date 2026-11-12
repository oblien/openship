import { Readable } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BackupExecutor, ServiceHandle } from "@repo/adapters";
import type { PlannedImportService } from "@repo/platform/engine/modules/migration/platform-import-plan";
const h = vi.hoisted(() => ({
  pinned: vi.fn(),
  source: vi.fn(),
  target: vi.fn(),
  list: vi.fn(),
  handle: vi.fn(),
  produce: vi.fn(),
  restore: vi.fn(),
  dispose: vi.fn(),
  sourceDispose: vi.fn(),
  resolve: vi.fn(),
  stop: vi.fn(),
  start: vi.fn(),
  activity: vi.fn(),
  workspaceId: undefined as string | undefined,
}));
vi.mock("@repo/adapters/outbound-target", () => ({ resolvePinnedHost: h.pinned }));
vi.mock("@repo/db", () => ({
  repos: {
    project: {
      findById: async () => ({
        id: "project",
        organizationId: "org",
        serverId: "server",
        slug: "app",
        activeDeploymentId: "build",
      }),
    },
    service: { listByProject: h.list },
    deployment: { findById: async () => ({ containerId: "target-container" }) },
  },
}));
vi.mock("@repo/platform/engine/modules/migration/migration-access", () => ({
  requireMigrationServer: async () => ({ id: "server", workspaceId: h.workspaceId }),
}));
vi.mock("@repo/platform/engine/modules/migration/providers/railway-data", () => ({
  openRailwayDataSource: h.source,
}));
vi.mock("@repo/platform/engine/modules/migration/migration-runtime", () => ({
  createMigrationDockerRuntime: async () => ({
    name: "docker",
    sampleStability: vi.fn(),
    dispose: h.dispose,
  }),
}));
vi.mock("@repo/platform/engine/lib/cloud-workspace-lock", () => ({
  withCloudWorkspaceActivity: h.activity,
}));
vi.mock("@repo/platform/engine/lib/project-runtime-lock", () => ({
  withProjectRuntimeLock: async (_id: string, work: () => Promise<unknown>) => work(),
}));
vi.mock("@repo/platform/engine/modules/backups/service-handle", () => ({
  serviceHandleFor: h.handle,
}));
vi.mock("@repo/platform/engine/modules/services/service-container", () => ({
  containerIdForService: vi.fn(),
}));
vi.mock("@repo/adapters", async (original) => ({
  ...(await original<object>()),
  resolveExecutor: h.resolve,
  resolveProducer: () => ({ produce: h.produce, restore: h.restore }),
}));
import {
  copyPlatformData,
  preflightPlatformData,
  postgresImportConnection,
  verifyImportPostgres,
} from "@repo/platform/engine/modules/migration/platform-import-data";

const handle = {
  id: "db",
  name: "db",
  projectId: "project",
  image: "postgres:17",
  env: { POSTGRES_USER: "app", POSTGRES_PASSWORD: "secret", POSTGRES_DB: "app" },
  volumes: [],
  containerId: "container",
  projectSlug: "project",
  namespaceVolumes: true,
} as ServiceHandle;
const service = {
  source: {
    id: "db",
    name: "db",
    kind: "database",
    database: "pg_dump",
    image: "postgres:17",
    instanceId: "source-container",
    externalDatabase: "postgres://app:secret@source.example/app?sslmode=require",
    env: handle.env,
    volumes: [{ id: "data", mountPath: "/data" }],
  },
  data: "copy",
  create: { name: "DB", volumes: ["data-0:/data"] },
  environment: handle.env,
} as PlannedImportService;
const probeExecutor = (version: string, extensions: string) =>
  ({
    execStream: vi.fn(async (_h, cmd: string[]) => ({
      stdout: Readable.from([cmd.at(-1) === "SHOW server_version_num" ? version : extensions]),
      awaitExit: Promise.resolve({ code: 0, stderr: "" }),
    })),
  }) as unknown as BackupExecutor;
let target: BackupExecutor;
beforeEach(() => {
  vi.resetAllMocks();
  h.workspaceId = undefined;
  h.list.mockResolvedValue([{ id: "db", name: "db", projectId: "project" }]);
  h.handle.mockResolvedValue(handle);
  h.activity.mockImplementation(async (_id: string, work: () => Promise<unknown>) => work());
  h.pinned.mockResolvedValue({ ip: "203.0.113.8" });
  target = {
    ...probeExecutor("170001", "plpgsql"),
    stopService: h.stop,
    startService: h.start,
  } as BackupExecutor;
  h.resolve.mockReturnValue(target);
  h.source.mockResolvedValue({
    executor: probeExecutor("170000", "plpgsql"),
    dispose: h.sourceDispose,
  });
});
describe("provider data copy", () => {
  it("rejects a missing native target service before opening a source or restoring data", async () => {
    h.list.mockResolvedValue([{ id: "other-service", name: "api", projectId: "project" }]);
    await expect(copyPlatformData({
      runId: "run", service, projectId: "project", serviceId: "db", deploymentId: "build",
      signal: new AbortController().signal, log: vi.fn(), progress: vi.fn(),
    })).rejects.toMatchObject({ code: "IMPORT_TARGET_SERVICE_MISSING" });
    expect(h.source).not.toHaveBeenCalled();
    expect(h.restore).not.toHaveBeenCalled();
    expect(h.handle).not.toHaveBeenCalled();
  });
  it("leaves a destination changed by the operator untouched", async () => {
    await expect(
      copyPlatformData({
        runId: "run",
        service,
        projectId: "project",
        serviceId: "db",
        deploymentId: "replaced-build",
        signal: new AbortController().signal,
        log: vi.fn(),
        progress: vi.fn(),
      }),
    ).rejects.toMatchObject({ code: "IMPORT_TARGET_CHANGED" });
    expect(h.resolve).not.toHaveBeenCalled();
    expect(h.source).not.toHaveBeenCalled();
    expect(h.restore).not.toHaveBeenCalled();
  });

  it("requires TLS and pins a public database address without exposing credentials in errors", async () => {
    const signal = new AbortController().signal;
    const connection = await postgresImportConnection(
      "postgres://app:p%40ss@db.example/app?sslmode=require&channel_binding=require",
      signal,
    );
    expect(connection).toMatchObject({
      host: "db.example",
      hostAddress: "203.0.113.8",
      password: "p@ss",
      sslMode: "require",
      channelBinding: "require",
    });
    expect(h.pinned).toHaveBeenCalledWith("db.example", false, signal);
    for (const query of ["sslmode=disable", "options=-c+something", "channel_binding=unknown"]) {
      await expect(
        postgresImportConnection(`postgres://user:secret@db.example/app?${query}`, signal),
      ).rejects.toMatchObject({ code: "IMPORT_DATABASE_URL_INVALID" });
    }
  });
  it("stops before restoring an incompatible PostgreSQL major or unavailable extension", async () => {
    const signal = new AbortController().signal;
    await expect(
      verifyImportPostgres(handle, handle, probeExecutor("160010", "plpgsql"), target, signal),
    ).rejects.toMatchObject({ code: "IMPORT_DATABASE_VERSION_MISMATCH" });
    await expect(
      verifyImportPostgres(
        handle,
        handle,
        probeExecutor("170010", "plpgsql\nvector"),
        target,
        signal,
      ),
    ).rejects.toMatchObject({ code: "IMPORT_DATABASE_EXTENSIONS_MISSING" });
  });
  it("streams every byte with backpressure, verifies after restore and closes both transports", async () => {
    const targetRow = { id: "db", name: "database", projectId: "project" };
    h.list.mockResolvedValue([
      { id: "api", name: "api", projectId: "project" }, targetRow,
    ]);
    const payload = Buffer.alloc(256 * 1024, 0x41);
    let producerCompleted = false;
    h.produce.mockImplementation(async function* () {
      yield {
        name: "dump",
        stream: Readable.from([payload]),
        metadata: {},
        payloadKind: "pg_dump",
      };
      producerCompleted = true;
    });
    let restored = Buffer.alloc(0);
    h.restore.mockImplementation(async (_target, _executor, artifact) => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      const chunks: Buffer[] = [];
      for await (const chunk of await artifact.open()) chunks.push(Buffer.from(chunk));
      restored = Buffer.concat(chunks);
    });
    const progress = vi.fn();
    await copyPlatformData({
      runId: "run",
      service,
      projectId: "project",
      serviceId: "db",
      deploymentId: "build",
      signal: new AbortController().signal,
      log: vi.fn(),
      progress,
    });
    expect(restored).toEqual(payload);
    expect(h.handle).toHaveBeenCalledWith(targetRow, expect.objectContaining({ projectSlug: "app" }));
    expect(producerCompleted).toBe(true);
    expect(h.dispose).toHaveBeenCalledOnce();
    expect(h.source).not.toHaveBeenCalled();
    expect(progress).toHaveBeenCalled();
  });
  it("fails when the exporter exits unsuccessfully after writing a complete-looking payload", async () => {
    h.produce.mockImplementation(async function* () {
      yield {
        name: "dump",
        stream: Readable.from(["partial"]),
        metadata: {},
        payloadKind: "pg_dump",
      };
      throw new Error("export failed");
    });
    h.restore.mockImplementation(async (_target, _executor, artifact) => {
      for await (const _chunk of await artifact.open()) {
        /* consume restore input */
      }
    });
    await expect(
      copyPlatformData({
        runId: "run",
        service,
        projectId: "project",
        serviceId: "db",
        deploymentId: "build",
        signal: new AbortController().signal,
        log: vi.fn(),
        progress: vi.fn(),
      }),
    ).rejects.toThrow("export failed");
    expect(h.dispose).toHaveBeenCalledOnce();
  });
  it("does not report a copied database when the export yielded no artifacts", async () => {
    h.produce.mockImplementation(async function* () {
      /* no output */
    });
    await expect(
      copyPlatformData({
        runId: "run",
        service,
        projectId: "project",
        serviceId: "db",
        deploymentId: "build",
        signal: new AbortController().signal,
        log: vi.fn(),
        progress: vi.fn(),
      }),
    ).rejects.toMatchObject({ code: "IMPORT_DATABASE_EMPTY_EXPORT" });
  });
});

it("holds the owning Cloud workspace activity lock for the whole transfer", async () => {
  h.workspaceId = "owned-workspace";
  h.produce.mockImplementation(async function* () {
    yield { name: "dump", stream: Readable.from(["data"]), metadata: {}, payloadKind: "pg_dump" };
  });
  h.restore.mockImplementation(async (_target, _executor, artifact) => {
    for await (const _chunk of await artifact.open()) {
      /* consume verified stream */
    }
  });
  const signal = new AbortController().signal;
  await copyPlatformData({
    runId: "run",
    service,
    projectId: "project",
    serviceId: "db",
    deploymentId: "build",
    signal,
    log: vi.fn(),
    progress: vi.fn(),
  });
  expect(h.activity).toHaveBeenCalledWith("owned-workspace", expect.any(Function), signal, {
    scope: "migration:run",
  });
  expect(h.restore).toHaveBeenCalledOnce();
});
it("rejects an obsolete per-engine Railway plan before source mutation", async () => {
  const legacy = { ...service, source: { ...service.source, externalDatabase: undefined } };
  await expect(preflightPlatformData([legacy], new AbortController().signal)).rejects.toMatchObject(
    { code: "IMPORT_TRANSFER_PLAN_INVALID" },
  );
  expect(h.source).not.toHaveBeenCalled();
});
it("does not require database tools or engine recognition for a cold volume", async () => {
  const cold = {
    ...service,
    transfer: "cold-volume" as const,
    source: {
      ...service.source,
      externalDatabase: undefined,
      database: undefined,
      image: "custom/store:1",
    },
  };
  await preflightPlatformData([cold], new AbortController().signal);
  expect(h.source).not.toHaveBeenCalled();
  expect(h.resolve).not.toHaveBeenCalled();
});
