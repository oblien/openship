/**
 * Which producer a service resolves to — the decision that made #611 a silent
 * zero-byte "success".
 *
 * Root cause 3 of that issue lived entirely in `PgDumpProducer.detects()`: it required
 * `POSTGRES_DB` in the service env, the control plane's own service rows are built from
 * running containers and carry no env at all, so its postgres resolved to the VOLUME
 * producer, which then found no recorded volumes and captured nothing. Nothing asserted
 * that decision in either direction, so this file does.
 *
 * `resolveProducerForService` is exercised rather than `detects()` alone, because
 * registration ORDER is half the mechanism: the volume producer is the fallback, and a
 * DB producer that registers after it would never be consulted.
 */

import { describe, expect, it } from "vitest";
import "../src/backup"; // side-effect: registers every producer in the right order
import { resolveProducerForService } from "../src/backup/registry";
import type { ServiceHandle } from "../src/backup/types";

function service(over: Partial<ServiceHandle> = {}): ServiceHandle {
  return {
    id: "svc_1",
    projectId: "prj_1",
    name: "db",
    image: null,
    env: {},
    volumes: [],
    containerId: "c_live",
    projectSlug: "shop",
    namespaceVolumes: false,
    ...over,
  };
}

const kindFor = (over: Partial<ServiceHandle>) => resolveProducerForService(service(over)).kind;

describe("a postgres container is dumped, with or without env", () => {
  it("resolves pg_dump with NO env at all — the #611 case", () => {
    // The control plane's own rows: image from the running container, `environment`
    // null. Before the fix this fell through to `volume`, found nothing, and the run
    // reported success having captured zero bytes.
    expect(kindFor({ image: "postgres:16-alpine", env: {} })).toBe("pg_dump");
  });

  it("still resolves pg_dump when the env IS present", () => {
    expect(
      kindFor({ image: "postgres:16", env: { POSTGRES_DB: "shop", POSTGRES_USER: "shop" } }),
    ).toBe("pg_dump");
  });

  it("falls back to volume when there is no container to dump inside", () => {
    // A logical dump has to exec somewhere. With no container the volume producer is
    // the honest answer — and for a STOPPED database a cold tar is the better backup
    // anyway, since nothing is writing to it.
    expect(kindFor({ image: "postgres:16", containerId: null })).toBe("volume");
  });

  it("does not claim a postgres-adjacent image", () => {
    expect(kindFor({ image: "postgres-exporter:0.15" })).toBe("volume");
    expect(kindFor({ image: "acme/postgres:16" })).toBe("volume");
  });
});

describe("the other database producers keep their credential requirements", () => {
  it("resolves mysql_dump only with a discoverable password", () => {
    // Deliberately NOT relaxed the way postgres was: mysqldump has no credential-free
    // local path (postgres has the container's unix socket), so dropping the
    // requirement would turn a working volume snapshot into a failing dump.
    expect(kindFor({ image: "mariadb:11", env: {} })).toBe("volume");
    expect(kindFor({ image: "mariadb:11", env: { MYSQL_ROOT_PASSWORD: "s3cret" } })).toBe(
      "mysql_dump",
    );
  });

  it("resolves redis_rdb for the bare repo AND the redis/ org", () => {
    expect(kindFor({ image: "redis:7-alpine" })).toBe("redis_rdb");
    // Regression guard: consolidating the image table onto exact repos alone dropped
    // `redis/redis-stack`, silently downgrading it to a volume snapshot.
    expect(kindFor({ image: "redis/redis-stack:latest" })).toBe("redis_rdb");
  });

  it("resolves mongo_dump from the image alone", () => {
    expect(kindFor({ image: "mongo:7" })).toBe("mongo_dump");
  });

  it("falls back to volume for anything that is not a database", () => {
    expect(kindFor({ image: "nginx:1.27" })).toBe("volume");
    expect(kindFor({ image: null })).toBe("volume");
  });
});

describe("every dump producer needs a container it can actually exec in", () => {
  // The bug this pins: each producer checked a DIFFERENT subset of the same two
  // facts, so three of the four selected themselves with no container at all and
  // the run failed at the exec — instead of falling back to the volume snapshot,
  // which is a real backup. One predicate now (canExecInService), so a fifth
  // producer cannot invent a fifth subset.
  const NO_CONTAINER = { containerId: null } as const;

  it("falls back to volume with no container, for all four", () => {
    expect(kindFor({ image: "postgres:16", ...NO_CONTAINER })).toBe("volume");
    expect(
      kindFor({ image: "mariadb:11", env: { MYSQL_ROOT_PASSWORD: "s3cret" }, ...NO_CONTAINER }),
    ).toBe("volume");
    expect(kindFor({ image: "mongo:7", ...NO_CONTAINER })).toBe("volume");
    expect(kindFor({ image: "redis:7-alpine", ...NO_CONTAINER })).toBe("volume");
  });

  it("falls back to volume when the container is observed STOPPED", () => {
    // A stopped container still has an id, which is why the id alone was never the
    // test. And this is not a downgrade: a stopped database's volume is the COLD
    // copy, which is the better artifact — where the old behaviour was an exec
    // against a stopped container, i.e. no artifact at all.
    const stopped = { containerId: "c_dead", containerRunning: false } as const;
    expect(kindFor({ image: "postgres:16", ...stopped })).toBe("volume");
    expect(
      kindFor({ image: "mariadb:11", env: { MYSQL_ROOT_PASSWORD: "s3cret" }, ...stopped }),
    ).toBe("volume");
    expect(kindFor({ image: "mongo:7", ...stopped })).toBe("volume");
    expect(kindFor({ image: "redis:7-alpine", ...stopped })).toBe("volume");
  });

  it("treats UNKNOWN running state as usable — cloud and bare must keep their dumps", () => {
    // The dangerous half of this fix. A runtime that cannot enumerate containers
    // reports null, and reading null as "stopped" would silently downgrade every
    // cloud and bare database to a crash-consistent volume snapshot.
    for (const running of [null, undefined]) {
      expect(kindFor({ image: "postgres:16", containerRunning: running }), `${running}`).toBe(
        "pg_dump",
      );
      expect(kindFor({ image: "mongo:7", containerRunning: running }), `${running}`).toBe(
        "mongo_dump",
      );
    }
  });

  it("keeps dumping a container that is running but unhealthy", () => {
    // `liveContainerStatus` reports an unhealthy-but-running container as "failed",
    // and the resolver maps only "stopped" to running:false — because `docker exec`
    // works fine on an unhealthy container, and a dump from it is still a real dump.
    expect(kindFor({ image: "postgres:16", containerRunning: true })).toBe("pg_dump");
  });
});
