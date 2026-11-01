import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RedisEndpoint } from "./types";
import type { TaskArchiveStore } from "./files";

const h = vi.hoisted(() => ({
  call: vi.fn(),
  command: vi.fn(),
  clients: [] as { host: string; port: number; disconnect: ReturnType<typeof vi.fn> }[],
}));
vi.mock("ioredis", () => ({
  default: class {
    disconnect = vi.fn();
    constructor(
      readonly port: number,
      readonly host: string,
    ) {
      h.clients.push(this);
    }
    on() {
      return this;
    }
    call(...args: string[]) {
      return h.call(this.host, this.port, ...args);
    }
  },
  Cluster: class {},
}));
vi.mock("./command", () => ({ databaseCommand: h.command }));

import { captureRedis } from "./redis";

const endpoint: RedisEndpoint = {
  host: "database-master.example.svc.cluster.local",
  port: 6379,
  mode: "replication",
  replicas: 3,
  sentinel: {
    host: "database-sentinel.example.svc.cluster.local",
    port: 26379,
    masterName: "mymaster",
  },
};
const healthy = (id = "a".repeat(40)) =>
  [
    "role:master",
    "connected_slaves:3",
    `master_replid:${id}`,
    ...[0, 1, 2].map((i) => `slave${i}:ip=10.0.0.${i + 3},port=6379,state=online,offset=10,lag=0`),
  ].join("\r\n");
const primary = (host = "10.0.0.2", flags = "master") => [
  "name",
  "mymaster",
  "ip",
  host,
  "port",
  "6379",
  "flags",
  flags,
];
let directory: string;
let cancel: AbortController;
let store: TaskArchiveStore;
const log = vi.fn();

beforeEach(async () => {
  vi.resetAllMocks();
  h.clients.length = 0;
  directory = await mkdtemp(join(tmpdir(), "openship-redis-capture-"));
  cancel = new AbortController();
  store = {
    signal: cancel.signal,
    upload: vi.fn(async (key: string) => ({ key, sizeBytes: 10, sha256: "b".repeat(64) })),
  } as unknown as TaskArchiveStore;
  h.call.mockImplementation(
    async (_host: string, port: number, command: string, operation: string) => {
      if (port === 26379 && command === "SENTINEL")
        return operation === "CKQUORUM" ? "OK 3 usable Sentinels" : primary();
      if (command === "INFO") return healthy();
      throw new Error("Unexpected Redis command");
    },
  );
  h.command.mockImplementation(async (_command: string, args: string[]) => {
    await writeFile(args.at(-1)!, "REDISsnapshot");
  });
});
afterEach(async () => {
  cancel.abort();
  vi.useRealTimers();
  vi.restoreAllMocks();
  await rm(directory, { recursive: true, force: true });
});
const capture = () =>
  captureRedis(
    endpoint,
    store,
    directory,
    "archives/attempt",
    { databaseId: "database", runtimeId: "runtime" },
    log,
  );

describe("Redis replication snapshot source", () => {
  it("pins the Sentinel-elected primary for both INFO and native RDB transfer", async () => {
    expect(await capture()).toMatchObject({
      mode: "standalone",
      files: [{ primaryId: "standalone" }],
    });
    expect(h.command).toHaveBeenCalledWith(
      "redis-cli",
      expect.arrayContaining(["-h", "10.0.0.2", "--rdb"]),
      cancel.signal,
    );
    expect(h.clients.some((client) => client.host === endpoint.host)).toBe(false);
    expect(h.clients.every((client) => client.disconnect.mock.calls.length)).toBe(true);
  });

  it("rediscovers the primary while a resumed former primary is being demoted", async () => {
    vi.useFakeTimers();
    let discoveries = 0;
    h.call.mockImplementation(
      async (host: string, port: number, command: string, operation: string) => {
        if (port === 26379)
          return operation === "CKQUORUM"
            ? "OK 3 usable Sentinels"
            : primary(++discoveries === 1 ? "10.0.0.1" : "10.0.0.2");
        return host === "10.0.0.1" ? healthy().replace("role:master", "role:slave") : healthy();
      },
    );
    const work = capture();
    await vi.advanceTimersByTimeAsync(1_999);
    expect(h.command).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await expect(work).resolves.toMatchObject({ mode: "standalone" });
    expect(h.command.mock.calls[0][1]).toEqual(expect.arrayContaining(["-h", "10.0.0.2"]));
    expect(log).toHaveBeenCalledWith(expect.stringContaining("Waiting for Redis Sentinel"));
  });

  it.each(["missing quorum", "disconnected primary", "replicas recovering"])(
    "does not capture %s and cancels its read-only convergence wait",
    async (condition) => {
      vi.useFakeTimers();
      h.call.mockImplementation(
        async (_host: string, port: number, command: string, operation: string) => {
          if (port === 26379) {
            if (operation === "CKQUORUM") {
              if (condition === "missing quorum") throw new Error("NOQUORUM");
              return "OK 3 usable Sentinels";
            }
            return primary(
              "10.0.0.2",
              condition === "disconnected primary" ? "master,disconnected" : "master",
            );
          }
          return healthy().replace("state=online", "state=wait_bgsave");
        },
      );
      const work = capture();
      const rejected = expect(work).rejects.toThrow("Cancelled by owner");
      await vi.advanceTimersByTimeAsync(0);
      expect(h.command).not.toHaveBeenCalled();
      cancel.abort(new Error("Cancelled by owner"));
      await rejected;
      expect(store.upload).not.toHaveBeenCalled();
      expect(h.clients.every((client) => client.disconnect.mock.calls.length)).toBe(true);
    },
  );

  it("ends unhealthy convergence at the saved three-minute backup deadline", async () => {
    vi.useFakeTimers();
    const budget = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(budget.signal);
    h.call.mockRejectedValue(new Error("NOQUORUM"));
    const work = capture();
    const rejected = expect(work).rejects.toThrow(/did not recover before the backup deadline/);
    await vi.advanceTimersByTimeAsync(0);
    expect(timeout).toHaveBeenCalledWith(180_000);
    budget.abort(new DOMException("Deadline expired", "TimeoutError"));
    await rejected;
    expect(h.command).not.toHaveBeenCalled();
    expect(store.upload).not.toHaveBeenCalled();
  });

  it.each(["primary address", "replication identity"])(
    "refuses to commit a snapshot if its %s changes during transfer",
    async (changed) => {
      let discoveries = 0;
      let reads = 0;
      h.call.mockImplementation(
        async (_host: string, port: number, command: string, operation: string) => {
          if (port === 26379)
            return operation === "CKQUORUM"
              ? "OK 3 usable Sentinels"
              : primary(
                  changed === "primary address" && ++discoveries > 1 ? "10.0.0.3" : "10.0.0.2",
                );
          return healthy(
            changed === "replication identity" && ++reads > 1 ? "c".repeat(40) : "a".repeat(40),
          );
        },
      );
      await expect(capture()).rejects.toThrow(/changed primary during backup/);
      expect(h.command).toHaveBeenCalledOnce();
      expect(h.clients.every((client) => client.disconnect.mock.calls.length)).toBe(true);
    },
  );

  it("waits for a recovering Sentinel voter after RDB transfer before committing", async () => {
    vi.useFakeTimers();
    let quorumChecks = 0;
    h.call.mockImplementation(
      async (_host: string, port: number, command: string, operation: string) => {
        if (port === 26379) {
          if (operation === "CKQUORUM") {
            if (++quorumChecks === 2) throw new Error("NOQUORUM 1 usable Sentinels");
            return "OK 3 usable Sentinels";
          }
          return primary();
        }
        return healthy();
      },
    );
    const work = capture();
    await vi.advanceTimersByTimeAsync(0);
    await vi.waitFor(() => expect(quorumChecks).toBe(2));
    expect(h.command).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(work).resolves.toMatchObject({ mode: "standalone" });
    expect(quorumChecks).toBe(3);
    expect(h.clients.every((client) => client.disconnect.mock.calls.length)).toBe(true);
  });

  it("cancels a post-transfer quorum wait without committing a recovery point", async () => {
    vi.useFakeTimers();
    let transferred = false;
    h.command.mockImplementation(async (_command: string, args: string[]) => {
      await writeFile(args.at(-1)!, "REDISsnapshot");
      transferred = true;
    });
    h.call.mockImplementation(
      async (_host: string, port: number, command: string, operation: string) => {
        if (port === 26379) {
          if (operation === "CKQUORUM") {
            if (transferred) throw new Error("NOQUORUM");
            return "OK 3 usable Sentinels";
          }
          return primary();
        }
        return healthy();
      },
    );
    const work = capture();
    const rejected = expect(work).rejects.toThrow("Cancelled by owner");
    await vi.waitFor(() => expect(log).toHaveBeenCalledWith(expect.stringContaining("Waiting for Redis Sentinel")));
    cancel.abort(new Error("Cancelled by owner"));
    await rejected;
    expect(h.command).toHaveBeenCalledOnce();
    expect(h.clients.every((client) => client.disconnect.mock.calls.length)).toBe(true);
  });
});
