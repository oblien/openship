import { beforeEach, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({
  server: vi.fn(),
  connection: vi.fn(),
  stream: vi.fn(),
  executor: vi.fn(),
  exec: vi.fn(),
  dispose: vi.fn(),
}));
vi.mock("@repo/db", () => ({ repos: { server: { getInOrganization: h.server } } }));
vi.mock("../src/engine/lib/cloud-workspace-host", () => ({
  readCloudWorkspaceConnection: h.connection,
  openCloudWorkspaceExecutor: h.executor,
}));
import {
  normalizeResourceUsage,
  streamCloudResourceUsage,
} from "../src/engine/lib/cloud-resource-usage";

beforeEach(() => {
  vi.resetAllMocks();
  h.executor.mockResolvedValue({
    exec: h.exec,
    dispose: h.dispose,
    runWithAbortSignal: (_signal: AbortSignal, work: () => unknown) => work(),
  });
  h.exec.mockResolvedValue(
    JSON.stringify({
      cpu: 10,
      memUsed: 4938 * 1048576,
      memAvail: 3021 * 1048576,
      memTotal: 7959 * 1048576,
      diskUsed: 100,
      diskAvail: 900,
      diskTotal: 1000,
      uptime: "10",
      load1: "0",
      load5: "0",
      load15: "0",
    }),
  );
  h.server.mockResolvedValue({ workspaceId: "space-owned" });
  h.connection.mockResolvedValue({
    binding: { workspaceId: "vm-owned" },
    provider: { workspace: { status: "running" } },
    client: { streamWorkspaceMetrics: h.stream },
  });
  h.stream.mockImplementation(async function* () {
    yield { cpuUsage: 25 };
  });
});
it("converts guest bytes, uses quota-relative CPU, and strips provider-only fields", () => {
  const sample = normalizeResourceUsage({
    cpuUsage: 12.5,
    guestMemoryUsed: 1048576,
    guestMemoryTotal: 8388608,
    memoryUsedMB: 99,
    memoryTotalMB: 100,
    guestDiskUsed: 2097152,
    guestDiskTotal: 16777216,
    token: "private",
    apiCalls: 42,
  });
  expect(sample).toMatchObject({
    cpuPercent: 12.5,
    memoryUsedMb: 1,
    memoryAvailableMb: 7,
    diskUsedMb: 2,
    diskTotalMb: 16,
    diskAvailableMb: 14,
  });
  expect(JSON.stringify(sample)).not.toMatch(/private|apiCalls|token/);
  expect(
    normalizeResourceUsage({ cpuUsage: 0, memoryUsedMB: 16, memoryTotalMB: 128 }),
  ).toMatchObject({ cpuPercent: 0, memoryUsedMb: null, memoryAvailableMb: null, diskUsedMb: null });
});
it("preserves missing data as unknown and rejects wholly unreadable metrics", () => {
  expect(
    normalizeResourceUsage({ cpuUsage: 8, guestDiskUsed: -1, guestMemoryUsed: Infinity }),
  ).toMatchObject({ cpuPercent: 8, memoryUsedMb: null, diskUsedMb: null });
  expect(
    normalizeResourceUsage({ cpuUsage: 0, guestMemoryUsed: 1048576, memoryTotalMB: 8 }),
  ).toMatchObject({
    memoryUsedMb: null,
    memoryAvailableMb: null,
  });
  for (const raw of [null, [], {}, { cpuUsage: "25", memoryUsedMB: NaN }])
    expect(() => normalizeResourceUsage(raw)).toThrow();
});
it("streams the owned binding using the scoped client and propagates cancellation", async () => {
  const abort = new AbortController();
  const source = streamCloudResourceUsage("org-a", "server-a", abort.signal);
  const event = (await source.next()).value!;
  expect(event.event).toBe("usage");
  expect(JSON.parse(event.data)).toMatchObject({ cpuPercent: 25, diskUsedMb: null });
  expect(h.server).toHaveBeenCalledWith("server-a", "org-a");
  expect(h.connection).toHaveBeenCalledWith("org-a", "space-owned");
  expect(h.stream).toHaveBeenCalledWith("vm-owned", abort.signal);
  abort.abort();
  await source.return();
  expect(h.dispose).toHaveBeenCalledOnce();
});
it("uses real guest RAM when provider metrics only contain hypervisor memory and reuses the bounded sample", async () => {
  h.stream.mockImplementation(async function* () {
    for (let i = 0; i < 3; i++)
      yield {
        cpuUsage: 10,
        memoryUsedMB: 8448,
        memoryTotalMB: 8448,
        guestMemoryUsedKiB: 0,
        guestMemoryTotalKiB: 0,
      };
  });
  const events = [];
  for await (const event of streamCloudResourceUsage("org-a", "server-a"))
    events.push(JSON.parse(event.data));
  expect(events).toHaveLength(3);
  for (const sample of events)
    expect(sample).toMatchObject({ memoryUsedMb: 4938, memoryAvailableMb: 3021 });
  expect(h.executor).toHaveBeenCalledExactlyOnceWith("org-a", "space-owned");
  expect(h.exec).toHaveBeenCalledOnce();
  expect(h.dispose).toHaveBeenCalledOnce();
});
it("accepts guest KiB/byte counters without opening a second measurement connection", async () => {
  h.stream.mockImplementation(async function* () {
    yield {
      cpuUsage: 0,
      guestMemoryUsedKiB: 1024,
      guestMemoryTotalKiB: 8192,
      guestDiskUsedBytes: 2097152,
      guestDiskTotalBytes: 16777216,
    };
  });
  const source = streamCloudResourceUsage("org-a", "server-a");
  expect(JSON.parse((await source.next()).value!.data)).toMatchObject({
    memoryUsedMb: 1,
    memoryAvailableMb: 7,
    diskUsedMb: 2,
    diskTotalMb: 16,
  });
  await source.return();
  expect(h.executor).not.toHaveBeenCalled();
});
it("does not replace a failed guest read with hypervisor memory and closes the connection", async () => {
  h.exec.mockRejectedValue(new Error("Guest connection lost"));
  await expect(streamCloudResourceUsage("org-a", "server-a").next()).rejects.toThrow(
    "Guest connection lost",
  );
  expect(h.dispose).toHaveBeenCalledOnce();
});
it("never opens a stream for a missing server, failed ownership check, or stopped space", async () => {
  h.server.mockResolvedValueOnce(null);
  await expect(streamCloudResourceUsage("org-a", "foreign").next()).rejects.toThrow();
  expect(h.connection).not.toHaveBeenCalled();
  h.connection.mockRejectedValueOnce(new Error("Ownership changed"));
  await expect(streamCloudResourceUsage("org-a", "server-a").next()).rejects.toThrow(
    "Ownership changed",
  );
  h.connection.mockResolvedValueOnce({
    provider: { workspace: { status: "active", info: { is_running: false } } },
  });
  await expect(streamCloudResourceUsage("org-a", "server-a").next()).rejects.toMatchObject({
    code: "CLOUD_WORKSPACE_NOT_RUNNING",
  });
  expect(h.stream).not.toHaveBeenCalled();
});
