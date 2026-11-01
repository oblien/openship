import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  assertBuildStorage,
  buildKitCacheConfig,
  DOCKER_BUILD_STORAGE_COMMAND,
  ensureProjectBuildCache,
  managedBuildCaches,
  parseBuildStorage,
  projectBuildCacheVolume,
  pruneManagedBuildCaches,
} from "./docker-build-cache";

const GIB = 1024 ** 3;
function volume(projectId: string, bytes = GIB, refs = 0) {
  return {
    Name: projectBuildCacheVolume(projectId),
    Mountpoint: `/cache/${projectId}`,
    Labels: { "openship.build-cache": "1", "openship.build-cache.project": projectId },
    CreatedAt: new Date().toISOString(),
    UsageData: { Size: bytes, RefCount: refs },
  };
}
function fixture(volumes = [volume("a"), volume("b")]) {
  const removed: string[] = [];
  const docker = {
    listVolumes: vi.fn(async () => ({ Volumes: volumes })),
    listContainers: vi.fn(
      async () => [] as Array<{ Mounts: Array<{ Name: string; Source: string }> }>,
    ),
    getVolume: vi.fn((name: string) => ({
      inspect: vi.fn(async () => volumes.find((v) => v.Name === name)!),
      remove: vi.fn(async () => {
        removed.push(name);
      }),
    })),
    createVolume: vi.fn(async () => ({})),
  };
  const exec = vi.fn(async (command: string, _options?: { timeout?: number }) => {
    if (command.includes("df -Pk")) return "104857600 52428800\n200000 100000\n";
    if (command.startsWith("du ")) {
      const v = volumes.find((v) => command.includes(v.Mountpoint))!;
      return `${v.UsageData.Size / 1024}\t${v.Mountpoint}\n`;
    }
    if (command.includes("stat -c"))
      return command.includes(projectBuildCacheVolume("a")) ? "2000000000\n" : "2000000100\n";
    return "";
  });
  return { docker, executor: { exec } as never, exec, removed };
}

describe("bounded project build cache", () => {
  it("validates free bytes and refuses an exhausted filesystem", () => {
    expect(parseBuildStorage("102400 51200\n1000 100")).toEqual({
      totalBytes: 104857600,
      freeBytes: 52428800,
      freeInodes: 100,
    });
    expect(() => parseBuildStorage("bad")).toThrow(/measure/);
    expect(
      parseBuildStorage("login banner\nOPENSHIP_STORAGE 102400 51200\nOPENSHIP_INODES 1000 100\n"),
    ).toEqual({ totalBytes: 104857600, freeBytes: 52428800, freeInodes: 100 });
    expect(() => parseBuildStorage("1024 2048")).toThrow(/measure/);
    expect(() =>
      assertBuildStorage({ totalBytes: 100 * GIB, freeBytes: GIB, freeInodes: 100 }),
    ).toThrow(/too little/);
    expect(() =>
      assertBuildStorage({ totalBytes: 100 * GIB, freeBytes: 10 * GIB, freeInodes: 0 }),
    ).toThrow(/too little/);
  });

  it.skipIf(process.platform === "win32").each([
    { inodes: "0 0 0 -", freeInodes: null, exhausted: false },
    { inodes: "- - - -", freeInodes: null, exhausted: false },
    { inodes: "1000 900 100 90%", freeInodes: 100, exhausted: false },
    { inodes: "1000 1000 0 100%", freeInodes: 0, exhausted: true },
  ])("measures df inode statistics correctly: $inodes", ({ inodes, freeInodes, exhausted }) => {
    const root = mkdtempSync(join(tmpdir(), "openship-storage-probe-"));
    try {
      writeFileSync(
        join(root, "docker"),
        '#!/bin/sh\nprintf "%s\\n" "$OPENSHIP_TEST_STORAGE_ROOT"\n',
      );
      writeFileSync(
        join(root, "df"),
        `#!/bin/sh
if [ "$1" = "-Pk" ]; then
  printf '%s\\n' 'Filesystem 1024-blocks Used Available Capacity Mounted on' 'fixture 524288000 222298112 301989888 43% /fixture'
else
  printf '%s\\n' 'Filesystem Inodes IUsed IFree IUse% Mounted on' 'fixture ${inodes} /fixture'
fi
`,
      );
      chmodSync(join(root, "docker"), 0o755);
      chmodSync(join(root, "df"), 0o755);
      const output = execFileSync("/bin/sh", ["-c", DOCKER_BUILD_STORAGE_COMMAND], {
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${root}:${process.env.PATH}`,
          OPENSHIP_TEST_STORAGE_ROOT: root,
        },
      });
      const storage = parseBuildStorage(output);
      expect(storage).toEqual({ totalBytes: 500 * GIB, freeBytes: 288 * GIB, freeInodes });
      if (exhausted) {
        expect(() => assertBuildStorage(storage)).toThrow(
          expect.objectContaining({ code: "BUILD_STORAGE_LOW" }),
        );
      } else {
        expect(() => assertBuildStorage(storage)).not.toThrow();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each(["", "0 0", "- -", "1000 -1", "1000 1001"])(
    "keeps disk-space admission checks when inode statistics are unknown: %s",
    (inodes) => {
      const storage = parseBuildStorage(
        `OPENSHIP_STORAGE 104857600 1048576\nOPENSHIP_INODES ${inodes}\n`,
      );
      expect(storage.freeInodes).toBeNull();
      expect(() => assertBuildStorage(storage)).toThrow(
        expect.objectContaining({ code: "BUILD_STORAGE_LOW" }),
      );
    },
  );

  it("does not accept foreign, unlabeled, malformed, or unknown-usage volumes", () => {
    expect(
      managedBuildCaches({
        Volumes: [
          volume("a"),
          { ...volume("b"), Name: "database" },
          { ...volume("c"), Labels: {} },
          { ...volume("data"), Labels: { ...volume("data").Labels, "openship.project": "data" } },
          { ...volume("d"), UsageData: { Size: -1, RefCount: 0 } },
        ],
      }),
    ).toHaveLength(1);
    expect(managedBuildCaches({ Volumes: null })).toEqual([]);
    expect(() => managedBuildCaches({})).toThrow(/inventory/);
  });

  it("preserves cache under budget, then evicts the least recently used idle cache", async () => {
    const h = fixture();
    await pruneManagedBuildCaches(h.docker as never, h.executor, {
      keepBytes: 2 * GIB,
      now: 2000000200000,
    });
    expect(h.removed).toEqual([]);
    const result = await pruneManagedBuildCaches(h.docker as never, h.executor, {
      keepBytes: GIB,
      now: 2000000200000,
    });
    expect(h.removed).toEqual([projectBuildCacheVolume("a")]);
    expect(result.spaceReclaimed).toBe(GIB);
  });

  it("keeps healthy under-budget caches when df reports unsupported inode counts", async () => {
    const h = fixture();
    const exec = h.exec.getMockImplementation()!;
    h.exec.mockImplementation((command) =>
      command.includes("df -Pk")
        ? Promise.resolve("OPENSHIP_STORAGE 524288000 301989888\nOPENSHIP_INODES 0 0\n")
        : exec(command),
    );
    const result = await pruneManagedBuildCaches(h.docker as never, h.executor, {
      keepBytes: 2 * GIB,
      now: 2000000200000,
    });
    expect(result).toEqual({ cachesDeleted: [], spaceReclaimed: 0 });
    expect(h.removed).toEqual([]);
  });

  it("scales the automatic cache ceiling to a small host and leaves active state alone", async () => {
    const h = fixture([volume("a"), volume("b"), volume("c")]);
    const exec = h.exec.getMockImplementation()!;
    h.exec.mockImplementation((command) =>
      command.includes("df -Pk")
        ? Promise.resolve("26214400 18874368\n200000 100000\n")
        : exec(command),
    );
    h.docker.listContainers.mockResolvedValue([
      { Mounts: [{ Name: projectBuildCacheVolume("c"), Source: "/cache/c" }] },
    ]);
    await pruneManagedBuildCaches(h.docker as never, h.executor, { now: 2000000200000 });
    expect(h.removed).toEqual([]);
    h.docker.listContainers.mockResolvedValue([]);
    await pruneManagedBuildCaches(h.docker as never, h.executor, { now: 2000000200000 });
    expect(h.removed).toEqual([projectBuildCacheVolume("a")]);
    expect(
      buildKitCacheConfig({ totalBytes: 25 * GIB, freeBytes: 18 * GIB, freeInodes: 100 }),
    ).toContain(`maxUsedSpace = ${2.5 * GIB}`);
    expect(
      buildKitCacheConfig({ totalBytes: 25 * GIB, freeBytes: 18 * GIB, freeInodes: 100 }),
    ).toContain('minFreeSpace = "20%"');
  });

  it("protects attached state even when the host is over budget", async () => {
    const h = fixture();
    h.docker.listContainers.mockResolvedValue([
      { Mounts: [{ Name: projectBuildCacheVolume("a"), Source: "/cache/a" }] },
    ]);
    await pruneManagedBuildCaches(h.docker as never, h.executor, { keepBytes: 0 });
    expect(h.removed).toEqual([projectBuildCacheVolume("b")]);
  });
  it("does not walk attached or pending state while its files can change", async () => {
    const h = fixture([volume("a"), volume("b"), volume("c")]);
    h.docker.listContainers.mockResolvedValue([
      { Mounts: [{ Name: projectBuildCacheVolume("a"), Source: "/cache/a" }] },
    ]);
    await pruneManagedBuildCaches(h.docker as never, h.executor, {
      keepBytes: GIB,
      protectedProjectIds: new Set(["b"]),
    });
    expect(h.exec.mock.calls.filter(([command]) => command.startsWith("du "))).toEqual([
      ["du -sk -- '/cache/c'", { timeout: 15_000 }],
    ]);
    expect(h.removed).toEqual([]);
    h.exec.mockClear();
    await pruneManagedBuildCaches(h.docker as never, h.executor, {
      protectAll: true,
      keepBytes: 0,
    });
    expect(h.exec.mock.calls.some(([command]) => command.startsWith("du "))).toBe(false);
  });
  it("protects durable pending commands even before a worker appears", async () => {
    const h = fixture();
    await pruneManagedBuildCaches(h.docker as never, h.executor, {
      keepBytes: 0,
      protectedProjectIds: new Set(["a"]),
    });
    expect(h.removed).toEqual([projectBuildCacheVolume("b")]);
    await expect(
      pruneManagedBuildCaches(h.docker as never, h.executor, {
        projectId: "a",
        protectedProjectIds: new Set(["a"]),
      }),
    ).rejects.toMatchObject({ code: "BUILD_CACHE_IN_USE" });
    h.removed.length = 0;
    await pruneManagedBuildCaches(h.docker as never, h.executor, {
      keepBytes: 0,
      protectAll: true,
    });
    expect(h.removed).toEqual([]);
  });

  it("removes only the requested project's cache and refuses a live project cache", async () => {
    const h = fixture();
    await pruneManagedBuildCaches(h.docker as never, h.executor, { projectId: "b" });
    expect(h.removed).toEqual([projectBuildCacheVolume("b")]);
    expect(h.exec.mock.calls.filter(([command]) => command.startsWith("du "))).toEqual([
      ["du -sk -- '/cache/b'", { timeout: 120_000 }],
    ]);
    h.docker.listContainers.mockResolvedValue([
      { Mounts: [{ Name: projectBuildCacheVolume("a"), Source: "/cache/a" }] },
    ]);
    await expect(
      pruneManagedBuildCaches(h.docker as never, h.executor, { projectId: "a" }),
    ).rejects.toMatchObject({ code: "BUILD_CACHE_IN_USE" });
  });

  it("retains a cache whose optional size scan times out without blocking healthy builds", async () => {
    const h = fixture();
    const exec = h.exec.getMockImplementation()!;
    h.exec.mockImplementation((command) =>
      command.startsWith("du ") && command.includes("/cache/a")
        ? Promise.reject(new DOMException("Cloud command timed out", "TimeoutError"))
        : exec(command),
    );
    const result = await pruneManagedBuildCaches(h.docker as never, h.executor, { keepBytes: GIB });
    expect(result).toEqual({ cachesDeleted: [], spaceReclaimed: 0 });
    expect(h.removed).toEqual([]);
    expect(h.exec.mock.calls.some(([command]) => command.includes("df -Pk"))).toBe(true);
  });

  it.each([
    { reason: "disk bytes", storage: "104857600 1048576\n200000 100000\n" },
    { reason: "inodes", storage: "104857600 52428800\n200000 0\n" },
  ])(
    "finishes a slow idle-cache scan when $reason already block admission",
    async ({ storage }) => {
      const h = fixture([volume("a", 24 * GIB)]);
      const original = h.exec.getMockImplementation()!;
      h.exec.mockImplementation(async (command, options) => {
        if (command.includes("df -Pk"))
          return h.removed.length ? "104857600 52428800\n200000 100000\n" : storage;
        if (command.startsWith("du ") && (options?.timeout ?? 0) < 20_000)
          throw new DOMException("Cloud command timed out", "TimeoutError");
        return original(command, options);
      });
      const result = await pruneManagedBuildCaches(h.docker as never, h.executor);
      expect(result).toEqual({
        cachesDeleted: [projectBuildCacheVolume("a")],
        spaceReclaimed: 24 * GIB,
      });
      expect(h.exec).toHaveBeenCalledWith("du -sk -- '/cache/a'", { timeout: 120_000 });
      expect(() =>
        assertBuildStorage(parseBuildStorage("104857600 52428800\n200000 100000\n")),
      ).not.toThrow();
    },
  );

  it("still refuses exhausted storage after a cache accounting timeout", async () => {
    const h = fixture();
    const storage = "104857600 0\n200000 0\n";
    h.exec.mockImplementation((command) =>
      command.startsWith("du ")
        ? Promise.reject(new DOMException("Cloud command timed out", "TimeoutError"))
        : Promise.resolve(command.includes("df -Pk") ? storage : ""),
    );
    await pruneManagedBuildCaches(h.docker as never, h.executor);
    expect(() => assertBuildStorage(parseBuildStorage(storage))).toThrow(
      expect.objectContaining({ code: "BUILD_STORAGE_LOW" }),
    );
    expect(h.removed).toEqual([]);
  });

  it.each([{ projectId: "a" }, { keepBytes: 0 }])(
    "does not report explicit cleanup complete after timeout: %j",
    async (options) => {
      const h = fixture([volume("a")]);
      const timeout = new DOMException("Cloud command timed out", "TimeoutError");
      const original = h.exec.getMockImplementation()!;
      h.exec.mockImplementation((command, options) =>
        command.startsWith("du ") ? Promise.reject(timeout) : original(command, options),
      );
      await expect(pruneManagedBuildCaches(h.docker as never, h.executor, options)).rejects.toBe(
        timeout,
      );
      expect(h.removed).toEqual([]);
      expect(h.exec).toHaveBeenCalledWith("du -sk -- '/cache/a'", { timeout: 120_000 });
    },
  );

  it.each([
    new Error("permission denied"),
    new Error("Command timed out after 15000ms: du -sk -- '/cache/a'"),
    Object.assign(new Error("Command exit unconfirmed"), {
      code: "CLOUD_COMMAND_EXIT_UNCONFIRMED",
    }),
    new DOMException("Cancelled by operator", "AbortError"),
    new DOMException("Command timed out after 15000ms: cancelled by operator", "AbortError"),
  ])("does not suppress unsafe or cancelled cache inspection: %s", async (error) => {
    const h = fixture();
    const original = h.exec.getMockImplementation()!;
    h.exec.mockImplementation((command, options) =>
      command.startsWith("du ") ? Promise.reject(error) : original(command, options),
    );
    await expect(pruneManagedBuildCaches(h.docker as never, h.executor)).rejects.toBe(error);
    expect(h.removed).toEqual([]);
  });

  it("stops deletion when ownership changes between discovery and remove", async () => {
    const h = fixture();
    h.docker.getVolume.mockImplementation(() => ({
      inspect: vi.fn(async () => volume("foreign")),
      remove: vi.fn(async () => {}),
    }));
    await expect(
      pruneManagedBuildCaches(h.docker as never, h.executor, { keepBytes: 0 }),
    ).rejects.toMatchObject({ code: "BUILD_CACHE_OWNER_MISMATCH" });
    expect(h.removed).toEqual([]);
  });

  it("does not force-remove a cache attached after inventory", async () => {
    const h = fixture([volume("a")]);
    const remove = vi.fn(async () => {
      throw { statusCode: 409 };
    });
    h.docker.getVolume.mockImplementation(() => ({
      inspect: vi.fn(async () => volume("a")),
      remove,
    }));
    expect(await pruneManagedBuildCaches(h.docker as never, h.executor, { keepBytes: 0 })).toEqual({
      cachesDeleted: [],
      spaceReclaimed: 0,
    });
    expect(remove).toHaveBeenCalledWith();
    await expect(
      pruneManagedBuildCaches(h.docker as never, h.executor, { projectId: "a" }),
    ).rejects.toMatchObject({ code: "BUILD_CACHE_IN_USE" });
  });

  it("creates an owned cache and checks the actual winner of a concurrent create", async () => {
    const h = fixture([volume("a")]);
    const inspect = vi
      .fn()
      .mockRejectedValueOnce({ statusCode: 404 })
      .mockResolvedValueOnce(volume("a"));
    h.docker.getVolume.mockImplementation(() => ({ inspect, remove: vi.fn(async () => {}) }));
    expect(await ensureProjectBuildCache(h.docker as never, "a")).toBe(false);
    expect(h.docker.createVolume).toHaveBeenCalledWith({
      Name: projectBuildCacheVolume("a"),
      Labels: volume("a").Labels,
    });
    inspect.mockRejectedValueOnce({ statusCode: 404 }).mockResolvedValueOnce(volume("foreign"));
    await expect(ensureProjectBuildCache(h.docker as never, "a")).rejects.toMatchObject({
      code: "BUILD_CACHE_OWNER_MISMATCH",
    });
  });

  it("fails closed on permission failures instead of claiming a cache", async () => {
    const h = fixture();
    h.docker.getVolume.mockImplementation(() => ({
      inspect: vi.fn(async () => {
        throw { statusCode: 403 };
      }),
      remove: vi.fn(async () => {}),
    }));
    await expect(ensureProjectBuildCache(h.docker as never, "a")).rejects.toMatchObject({
      statusCode: 403,
    });
    expect(h.docker.createVolume).not.toHaveBeenCalled();
  });
});
