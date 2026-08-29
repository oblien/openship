/**
 * The image→database table both the producers and the policy dialog read.
 *
 * It exists as one table because two copies drifted, and the drift is what made the
 * dashboard promise `pg_dump` on a service the server then volume-snapshotted
 * (#611). These cases are the boundaries that made the two copies disagree.
 */

import { describe, expect, it } from "vitest";
import { detectDbImage, isDbImage, normalizeImageRef } from "../src/backup-image-detect";

describe("which database an image is", () => {
  it("matches a tagged image and a bare repository name alike", () => {
    // Bare names matter: `image: postgres` (implicit :latest) is valid compose, and
    // a matcher anchored on `:` alone would miss it.
    for (const img of ["postgres", "postgres:16", "postgres:16-alpine", "POSTGRES:16"]) {
      expect(detectDbImage(img)?.payloadKind, img).toBe("pg_dump");
    }
    expect(detectDbImage("mariadb:11")?.payloadKind).toBe("mysql_dump");
    expect(detectDbImage("mysql")?.payloadKind).toBe("mysql_dump");
    expect(detectDbImage("redis:7-alpine")?.payloadKind).toBe("redis_rdb");
    expect(detectDbImage("mongo:7")?.payloadKind).toBe("mongo_dump");
    expect(detectDbImage("postgis/postgis:16-3.4")?.payloadKind).toBe("pg_dump");
  });

  it("does not match an image that merely starts with the same word", () => {
    // `postgres-exporter` is a metrics scraper; pointing pg_dump at it, or letting
    // the dialog claim it is a database, would both be wrong.
    for (const img of [
      "postgres-exporter:1",
      "mysqld-exporter:0.15",
      "redisinsight:2",
      "mongo-express:1",
      "acme/postgres:16",
      "someorg/redis:7",
    ]) {
      expect(detectDbImage(img), img).toBeNull();
    }
  });

  it("matches the redis/ organisation, not just the bare repo", () => {
    // Regression guard. The regex this table replaced in redis.ts was
    // `/^redis(\/|:)/i`, so an exact-repo-only matcher silently dropped Redis Inc's
    // own images — and a Redis Stack service with a live policy would have quietly
    // fallen back to a crash-consistent volume snapshot instead of a BGSAVE'd RDB.
    // That is the #611 silent-downgrade shape, reintroduced by the fix for it.
    expect(detectDbImage("redis/redis-stack:latest")?.payloadKind).toBe("redis_rdb");
    expect(detectDbImage("redis/redis-stack-server:7.2.0-v11")?.payloadKind).toBe("redis_rdb");
  });

  it("does not treat a foreign org's redis image as the redis org", () => {
    // `redis/` is Redis Inc's namespace; `someorg/redis` is somebody else's image.
    expect(detectDbImage("someorg/redis:7")).toBeNull();
    expect(detectDbImage("redisfake/redis-stack:1")).toBeNull();
  });

  it("keeps percona's MySQL and MongoDB images apart", () => {
    // These share a prefix: `percona/percona-server` vs
    // `percona/percona-server-mongodb`. A prefix match would send mongodump's
    // service to mysqldump.
    expect(detectDbImage("percona/percona-server:8")?.payloadKind).toBe("mysql_dump");
    expect(detectDbImage("percona/percona-server-mongodb:7")?.payloadKind).toBe("mongo_dump");
  });

  it("answers null for nothing, blank, and unknown images", () => {
    expect(detectDbImage(null)).toBeNull();
    expect(detectDbImage(undefined)).toBeNull();
    expect(detectDbImage("   ")).toBeNull();
    expect(detectDbImage("nginx:1.27")).toBeNull();
  });

  it("matches a registry-qualified reference", () => {
    // These are what containerd, nerdctl and k8s report, and what an operator gets
    // from a mirrored pull — so treating them as "not a database" silently downgraded
    // a real postgres to a crash-consistent volume snapshot.
    expect(detectDbImage("docker.io/library/postgres:16")?.payloadKind).toBe("pg_dump");
    expect(detectDbImage("index.docker.io/library/mysql:8")?.payloadKind).toBe("mysql_dump");
    expect(detectDbImage("public.ecr.aws/docker/library/postgres:16")?.payloadKind).toBe("pg_dump");
    expect(detectDbImage("registry.local:5000/redis/redis-stack:7")?.payloadKind).toBe("redis_rdb");
    expect(detectDbImage("localhost/mongo:7")?.payloadKind).toBe("mongo_dump");
    expect(detectDbImage("localhost:5000/postgres")?.payloadKind).toBe("pg_dump");
  });

  it("matches a digest-pinned reference", () => {
    // A compose file may pin by digest. The `@sha256:` suffix defeated the `(?::|$)`
    // anchor, so a pinned postgres read as "not a database" — the silent-downgrade
    // shape again, on a config that is a best practice.
    expect(detectDbImage("postgres@sha256:" + "a".repeat(64))?.payloadKind).toBe("pg_dump");
    expect(detectDbImage("postgres:16@sha256:" + "b".repeat(64))?.payloadKind).toBe("pg_dump");
    expect(
      detectDbImage("docker.io/library/mariadb:11@sha256:" + "c".repeat(64))?.payloadKind,
    ).toBe("mysql_dump");
  });

  it("strips only the registry, never a namespace that merely looks like one", () => {
    // The whole reason the boundary existed. Normalization follows Docker's rule —
    // the first component is a registry only if it has a `.` or `:` or is
    // `localhost` — so a Hub namespace survives and these stay unmatched. Getting
    // this wrong is how mysqldump ends up pointed at somebody's mysql-proxy.
    for (const img of [
      "acme/mysql-proxy:1",
      "ghcr.io/someorg/postgres:16",
      "quay.io/acme/redis:7",
      "docker.io/someorg/mongo:7",
      "mysqlproxy/mysql-router:8",
    ]) {
      expect(detectDbImage(img), img).toBeNull();
    }
  });

  it("normalizeImageRef is the reference reduction on its own", () => {
    expect(normalizeImageRef("postgres:16")).toBe("postgres:16");
    expect(normalizeImageRef("docker.io/library/postgres:16")).toBe("postgres:16");
    expect(normalizeImageRef("public.ecr.aws/docker/library/postgres:16")).toBe("postgres:16");
    expect(normalizeImageRef("ghcr.io/someorg/postgres:16")).toBe("someorg/postgres:16");
    expect(normalizeImageRef("acme/mysql-proxy")).toBe("acme/mysql-proxy");
    expect(normalizeImageRef("postgres@sha256:" + "a".repeat(64))).toBe("postgres");
    // A lone `library` is a repository name, not a namespace to strip.
    expect(normalizeImageRef("library")).toBe("library");
  });

  it("isDbImage is the same decision, narrowed to one kind", () => {
    expect(isDbImage("postgres:16", "pg_dump")).toBe(true);
    expect(isDbImage("postgres:16", "mysql_dump")).toBe(false);
    expect(isDbImage(null, "pg_dump")).toBe(false);
  });
});
