import { reportCaughtError as observeCaughtError } from "@repo/core/diagnostics";
import { spawn } from "node:child_process";
import { mkdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { isIP } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import Redis, { Cluster, type RedisOptions } from "ioredis";
import type { RedisEndpoint, RedisArchiveManifest } from "./types";
import type { TaskArchiveStore } from "./files";
import { databaseCommand as command } from "./command";

export interface RedisPrimary {
  id: string;
  host: string;
  port: number;
  slots: string[];
}
/** Refuse capturing a moving or degraded slot map. Redis performs membership and
 * resharding; a backup only reads and verifies its stable topology. */
export function redisPrimaries(nodes: string): RedisPrimary[] {
  const rows = nodes
    .trim()
    .split(/\r?\n/)
    .map((line) => line.split(/\s+/));
  const primaries: RedisPrimary[] = [];
  const occupied = new Set<number>();
  for (const row of rows) {
    if (
      row.length < 8 ||
      row[7] !== "connected" ||
      row[2].split(",").some((flag) => ["fail", "fail?", "handshake", "noaddr"].includes(flag)) ||
      row.slice(8).some((slot) => slot.includes("["))
    )
      throw new Error(
        "Redis is moving data or a member is unavailable. Retry the backup after cluster health recovers.",
      );
    if (!row[2].split(",").includes("master")) continue;
    const address = row[1].split("@")[0].split(",")[0];
    const separator = address.lastIndexOf(":");
    const host = address.slice(0, separator).replace(/^\[|\]$/g, "");
    const port = Number(address.slice(separator + 1));
    if (
      !host ||
      !Number.isInteger(port) ||
      port < 1 ||
      port > 65535 ||
      !/^[a-f0-9]{40}$/.test(row[0])
    )
      throw new Error("Redis returned an invalid member address.");
    const slots = row.slice(8).sort((a, b) => parseInt(a) - parseInt(b));
    if (!slots.length) throw new Error("Redis is still assigning its data partitions.");
    for (const slot of slots) {
      if (!/^\d+(?:-\d+)?$/.test(slot)) throw new Error("Redis has an unfinished data transfer.");
      const [start, end = start] = slot.split("-").map(Number);
      if (start < 0 || end > 16383 || end < start)
        throw new Error("Redis returned an invalid slot range.");
      for (let id = start; id <= end; id++) {
        if (occupied.has(id)) throw new Error("Redis slot ranges overlap.");
        occupied.add(id);
      }
    }
    if (!rows.some((replica) => replica[3] === row[0] && replica[2].split(",").includes("slave")))
      throw new Error("A Redis data partition has no healthy replica.");
    primaries.push({ id: row[0], host, port, slots });
  }
  if (occupied.size !== 16384 || primaries.length < 3 || primaries.length > 9)
    throw new Error(
      "Redis has not assigned all of its data slots across the supported partitions.",
    );
  return primaries.sort((a, b) => a.id.localeCompare(b.id));
}
const options = (password?: string): RedisOptions => ({
  password,
  connectTimeout: 10_000,
  commandTimeout: 20_000,
  retryStrategy: () => null,
  maxRetriesPerRequest: 1,
  enableReadyCheck: true,
});
export function redisConnection(endpoint: RedisEndpoint, password = process.env.REDISCLI_AUTH) {
  const client = new Redis(endpoint.port, endpoint.host, options(password));
  client.on("error", (eventDiagnosticError) => {
    observeCaughtError(eventDiagnosticError, "adapters/cluster/tasks/redis");
  });
  return client;
}
export function validateRedisManifest(
  value: RedisArchiveManifest,
  source: { databaseId: string; runtimeId: string },
  prefix: string,
) {
  if (
    value?.format !== "openship-redis-rdb-v1" ||
    value.databaseId !== source.databaseId ||
    value.runtimeId !== source.runtimeId ||
    !["standalone", "cluster"].includes(value.mode) ||
    !Array.isArray(value.files) ||
    !value.files.length ||
    value.files.length > 9 ||
    (value.mode === "standalone" ? value.files.length !== 1 : value.files.length < 3) ||
    new Set(value.files.map((file) => file.key)).size !== value.files.length ||
    new Set(value.files.map((file) => file.primaryId)).size !== value.files.length ||
    value.files.some(
      (file) =>
        !file.key.startsWith(prefix + "/") ||
        file.key.split("/").some((part) => !part || part === "." || part === "..") ||
        !/^(?:[a-f0-9]{40}|standalone)$/.test(file.primaryId) ||
        !/^[a-f0-9]{64}$/.test(file.sha256) ||
        !Number.isSafeInteger(file.sizeBytes) ||
        file.sizeBytes < 1,
    )
  )
    throw new Error("The Redis archive does not match this recovery request.");
}
/** A non-sharded backup must come from the elected primary, not a lagging
 * replica or a connection that changed roles during snapshot transfer. */
export function redisReplicationIdentity(info: string, expectedReplicas = 1): string {
  const values = Object.fromEntries(
    info
      .split(/\r?\n/)
      .filter((line) => line.includes(":"))
      .map((line) => {
        const at = line.indexOf(":");
        return [line.slice(0, at), line.slice(at + 1)];
      }),
  );
  const connectedReplicas = Number(values.connected_slaves);
  const onlineReplicas = Object.entries(values).filter(
    ([key, value]) => /^slave\d+$/.test(key) && /(?:^|,)state=online(?:,|$)/.test(value),
  ).length;
  if (
    values.role !== "master" ||
    !/^[a-f0-9]{40}$/.test(values.master_replid ?? "") ||
    !Number.isSafeInteger(connectedReplicas) ||
    !Number.isInteger(expectedReplicas) ||
    expectedReplicas < 1 ||
    connectedReplicas < expectedReplicas ||
    onlineReplicas < expectedReplicas
  )
    throw new Error(
      "Redis replication has no verified primary with a connected replica. Retry after its health recovers.",
    );
  return values.master_replid;
}

async function sentinelPrimary(endpoint: RedisEndpoint, signal: AbortSignal) {
  const config = endpoint.sentinel;
  if (!config || !/^[a-zA-Z0-9_-]{1,128}$/.test(config.masterName))
    throw new Error("The Redis backup has no saved Sentinel discovery configuration.");
  signal.throwIfAborted();
  const sentinel = redisConnection({ ...endpoint, host: config.host, port: config.port });
  const cancel = () => sentinel.disconnect();
  signal.addEventListener("abort", cancel, { once: true });
  try {
    const quorum = String(await sentinel.call("SENTINEL", "CKQUORUM", config.masterName));
    if (!quorum.startsWith("OK ")) throw new Error("Redis Sentinel has no verified quorum.");
    const reply = await sentinel.call("SENTINEL", "MASTER", config.masterName);
    if (!Array.isArray(reply) || reply.length % 2)
      throw new Error("Redis Sentinel returned an invalid primary.");
    const fields = Object.fromEntries(
      Array.from({ length: reply.length / 2 }, (_, index) => [
        String(reply[index * 2]),
        String(reply[index * 2 + 1]),
      ]),
    );
    const port = Number(fields.port);
    if (
      fields.name !== config.masterName ||
      fields.flags !== "master" ||
      !isIP(fields.ip ?? "") ||
      port !== endpoint.port
    )
      throw new Error("Redis Sentinel is still recovering its elected primary.");
    signal.throwIfAborted();
    return { host: fields.ip, port };
  } finally {
    signal.removeEventListener("abort", cancel);
    sentinel.disconnect();
  }
}

/** Pod readiness and Service selectors may settle before Redis finishes
 * failover. Discover and pin the elected data member before touching its RDB. */
async function replicationSource(
  endpoint: RedisEndpoint,
  signal: AbortSignal,
  log: (message: string) => void,
) {
  if (
    !endpoint.sentinel ||
    !Number.isInteger(endpoint.replicas) ||
    endpoint.replicas! < 2 ||
    endpoint.replicas! > 8
  )
    throw new Error("The Redis backup has no valid saved replication topology.");
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(180_000)]);
  let waiting = false;
  while (true) {
    deadline.throwIfAborted();
    let source: Redis | undefined;
    let cancel: (() => void) | undefined;
    try {
      const primary = await sentinelPrimary(endpoint, deadline);
      source = redisConnection({ ...endpoint, ...primary });
      cancel = () => source!.disconnect();
      deadline.addEventListener("abort", cancel, { once: true });
      const identity = redisReplicationIdentity(
        String(await source.call("INFO", "replication")),
        endpoint.replicas,
      );
      deadline.throwIfAborted();
      deadline.removeEventListener("abort", cancel);
      return { source, primary, identity };
    } catch (error) {
      source?.disconnect();
      if (cancel) deadline.removeEventListener("abort", cancel);
      signal.throwIfAborted();
      if (deadline.aborted)
        throw new Error(
          "Redis Sentinel and its primary did not recover before the backup deadline.",
          { cause: error },
        );
      if (!waiting) {
        log(
          "Waiting for Redis Sentinel and the elected primary's replicas to recover before taking a snapshot.",
        );
        waiting = true;
      }
      try {
        await delay(2_000, undefined, { signal: deadline });
      } catch (waitError) {
        signal.throwIfAborted();
        throw new Error(
          "Redis Sentinel and its primary did not recover before the backup deadline.",
          {
            cause: waitError,
          },
        );
      }
    }
  }
}

export async function captureRedis(
  endpoint: RedisEndpoint,
  store: TaskArchiveStore,
  directory: string,
  prefix: string,
  identity: { databaseId: string; runtimeId: string },
  log: (message: string) => void,
): Promise<RedisArchiveManifest> {
  const replicated =
    endpoint.mode === "replication" ? await replicationSource(endpoint, store.signal, log) : null;
  const source = replicated?.source ?? redisConnection(endpoint);
  try {
    const primaries =
      endpoint.mode === "cluster"
        ? redisPrimaries(String(await source.call("CLUSTER", "NODES")))
        : [
            {
              id: "standalone",
              ...(replicated?.primary ?? { host: endpoint.host, port: endpoint.port }),
              slots: [],
            },
          ];
    const manifest: RedisArchiveManifest = {
      format: "openship-redis-rdb-v1",
      ...identity,
      // Replication uses the existing one-RDB format; topology is not part of the archive payload.
      mode: endpoint.mode === "cluster" ? "cluster" : "standalone",
      createdAt: new Date().toISOString(),
      files: [],
    };
    for (const [index, primary] of primaries.entries()) {
      store.signal.throwIfAborted();
      const path = join(directory, `${primary.id}.rdb`);
      log(`Saving data partition ${index + 1} of ${primaries.length}.`);
      await command(
        "redis-cli",
        ["--no-auth-warning", "-h", primary.host, "-p", String(primary.port), "--rdb", path],
        store.signal,
      );
      const handle = await import("node:fs/promises").then((fs) => fs.open(path, "r"));
      try {
        const header = Buffer.alloc(5);
        await handle.read(header, 0, 5, 0);
        if (header.toString() !== "REDIS")
          throw new Error("Redis did not produce a complete native snapshot.");
      } finally {
        await handle.close();
      }
      manifest.files.push({
        ...(await store.upload(`${prefix}/${primary.id}.rdb`, path)),
        primaryId: primary.id,
      });
      await rm(path);
    }
    if (
      endpoint.mode === "cluster" &&
      JSON.stringify(redisPrimaries(String(await source.call("CLUSTER", "NODES")))) !==
        JSON.stringify(primaries)
    )
      throw new Error(
        "Redis changed its data partitions during backup. No recovery point was committed; retry after it settles.",
      );
    if (replicated) {
      // Sentinel Service connections can reach different voters while a resumed
      // node catches up. Use the same bounded convergence check after transfer;
      // a transient NOQUORUM must not discard an otherwise consistent RDB.
      // Recovery still has to confirm the exact primary and replication history
      // captured above, and the original connection must still be a primary.
      const verified = await replicationSource(endpoint, store.signal, log);
      try {
        if (
          verified.identity !== replicated.identity ||
          JSON.stringify(verified.primary) !== JSON.stringify(replicated.primary) ||
          redisReplicationIdentity(
            String(await source.call("INFO", "replication")),
            endpoint.replicas,
          ) !== replicated.identity
        )
          throw new Error(
            "Redis changed primary during backup. No recovery point was committed; retry after it settles.",
          );
      } finally {
        verified.source.disconnect();
      }
    }
    return manifest;
  } finally {
    source.disconnect();
  }
}

/** Read only the immutable RDB in an isolated temporary Redis. Never SCAN a live
 * source or replace RDB/AOF files under a running target database. */
export async function restoreRedis(
  endpoint: RedisEndpoint,
  manifest: RedisArchiveManifest,
  store: TaskArchiveStore,
  directory: string,
  log: (message: string) => void,
  preparedFile?: string,
) {
  const target: Redis | Cluster =
    endpoint.mode === "cluster"
      ? new Cluster([{ host: endpoint.host, port: endpoint.port }], {
          redisOptions: options(process.env.REDISCLI_AUTH),
          clusterRetryStrategy: () => null,
          maxRedirections: 16,
        })
      : redisConnection(endpoint);
  target.on("error", (eventDiagnosticError) => {
    observeCaughtError(eventDiagnosticError, "adapters/cluster/tasks/redis");
  });
  try {
    for (const [index, file] of manifest.files.entries()) {
      const folder = join(directory, `restore-${index}`);
      await mkdir(folder, { mode: 0o700 });
      if (preparedFile && index === 0) await rename(preparedFile, join(folder, "dump.rdb"));
      else await store.download(file, join(folder, "dump.rdb"));
      log(`Recovering data partition ${index + 1} of ${manifest.files.length}.`);
      const socket = join(folder, "reader.sock");
      const process = spawn(
        "redis-server",
        [
          "--port",
          "0",
          "--unixsocket",
          socket,
          "--unixsocketperm",
          "700",
          "--protected-mode",
          "yes",
          "--dir",
          folder,
          "--dbfilename",
          "dump.rdb",
          "--appendonly",
          "no",
          "--save",
          "",
          "--databases",
          "1024",
        ],
        { signal: store.signal, stdio: ["ignore", "ignore", "pipe"] },
      );
      let error = "";
      let closed = false;
      const stopped = new Promise<void>((resolve) =>
        process.once("close", () => {
          closed = true;
          resolve();
        }),
      );
      process.stderr.on("data", (data) => {
        error = (error + data).slice(-2000);
      });
      let failure: Error | undefined;
      process.on("error", (reason) => {
        observeCaughtError(reason, "adapters/cluster/tasks/redis");
        failure = reason;
      });
      process.once("exit", (code) => {
        if (code) failure = new Error(`The saved Redis data could not be loaded: ${error}`);
      });
      const temporary = new Redis({
        ...options(),
        path: socket,
        retryStrategy: (attempts) => (attempts < 60 ? 1000 : null),
        maxRetriesPerRequest: null,
        enableOfflineQueue: true,
      });
      temporary.on("error", (eventDiagnosticError) => {
        observeCaughtError(eventDiagnosticError, "adapters/cluster/tasks/redis");
      });
      try {
        await Promise.race([
          temporary.ping(),
          new Promise<never>((_, reject) => {
            const timer = setTimeout(
              () => reject(failure ?? new Error("The Redis snapshot did not finish loading.")),
              65_000,
            );
            timer.unref();
            temporary.once("ready", () => clearTimeout(timer));
          }),
        ]);
        if (failure) throw failure;
        const dbs = [...(await temporary.info("keyspace")).matchAll(/^db(\d+):keys=(\d+)/gm)]
          .filter((match) => Number(match[2]) > 0)
          .map((match) => Number(match[1]));
        if (endpoint.mode === "cluster" && dbs.some((db) => db !== 0))
          throw new Error(
            "This backup uses numbered Redis databases. Restore it as standalone; Redis Cluster supports database 0 only.",
          );
        let restored = 0;
        for (const db of dbs) {
          await temporary.select(db);
          if (endpoint.mode !== "cluster") await (target as Redis).select(db);
          let cursor = "0";
          do {
            store.signal.throwIfAborted();
            const result = (await temporary.callBuffer("SCAN", cursor, "COUNT", "256")) as [
              Buffer,
              Buffer[],
            ];
            cursor = result[0].toString();
            for (const key of result[1]) {
              const [dump, expires] = (await temporary.callBuffer(
                "EVAL",
                "return {redis.call('DUMP',KEYS[1]),redis.call('PEXPIRETIME',KEYS[1])}",
                "1",
                key,
              )) as [Buffer | null, number];
              if (!dump || expires === -2 || (expires > 0 && expires <= Date.now())) continue;
              await target.call(
                "RESTORE",
                key,
                expires < 0 ? 0 : expires,
                dump,
                ...(expires > 0 ? ["ABSTTL"] : []),
                "REPLACE",
              );
              restored++;
            }
          } while (cursor !== "0");
        }
        log(`Recovered ${restored} live keys from this partition, preserving expiration times.`);
      } finally {
        temporary.disconnect();
        if (!closed) {
          process.kill("SIGTERM");
          const timer = setTimeout(() => {
            process.kill("SIGKILL");
          }, 5000);
          timer.unref();
          await stopped;
          clearTimeout(timer);
        }
        await rm(folder, { recursive: true, force: true });
      }
    }
    if (endpoint.mode === "replication") {
      if (!Number.isInteger(endpoint.replicas) || endpoint.replicas! < 2 || endpoint.replicas! > 8)
        throw new Error("The Redis replication recovery request has an invalid replica count.");
      redisReplicationIdentity(String(await target.call("INFO", "replication")));
      if (Number(await target.call("WAIT", endpoint.replicas!, 10000)) < endpoint.replicas!)
        throw new Error(
          "Restored Redis data has not reached every replica. Retry after replication is healthy.",
        );
    }
    if (target instanceof Cluster)
      for (const primary of target.nodes("master")) {
        if (Number(await primary.call("WAIT", 1, 10000)) < 1)
          throw new Error(
            "A restored Redis partition has not reached its replica. Retry after the replica is healthy.",
          );
      }
  } finally {
    target.disconnect();
  }
}
