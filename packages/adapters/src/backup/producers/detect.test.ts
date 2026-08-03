import { describe, expect, it } from "vitest";
import "../index";
import { autoDetectProducer } from "./detect";
import type { PayloadKind, ServiceHandle } from "../types";

const POSTGRES_ENV = { POSTGRES_DB: "app", POSTGRES_USER: "app", POSTGRES_PASSWORD: "pw" };
const MYSQL_ENV = { MYSQL_ROOT_PASSWORD: "pw", MYSQL_DATABASE: "app" };
const MYSQL_ROUTER_ENV = {
  MYSQL_HOST: "db",
  MYSQL_PORT: "3306",
  MYSQL_USER: "app",
  MYSQL_PASSWORD: "pw",
};
const MONGO_ENV = { MONGO_INITDB_ROOT_USERNAME: "root", MONGO_INITDB_ROOT_PASSWORD: "pw" };
const REDIS_ENV = { REDIS_PASSWORD: "pw" };

function serviceWith(image: string, env: Record<string, string>): ServiceHandle {
  return {
    id: "svc-1",
    projectId: "proj-1",
    name: "db",
    image,
    env,
    volumes: [],
    containerId: "c1",
    projectSlug: "app",
    namespaceVolumes: true,
  };
}

function kindsFor(cases: Array<[string, Record<string, string>]>): Record<string, PayloadKind> {
  const out: Record<string, PayloadKind> = {};
  for (const [image, env] of cases) out[image] = autoDetectProducer(serviceWith(image, env)).kind;
  return out;
}

describe("autoDetectProducer", () => {
  it("routes an untagged database image to its dump producer", () => {
    expect(
      kindsFor([
        ["postgres", POSTGRES_ENV],
        ["postgis/postgis", POSTGRES_ENV],
        ["mysql", MYSQL_ENV],
        ["mariadb", MYSQL_ENV],
        ["percona/percona-server", MYSQL_ENV],
        ["mongo", MONGO_ENV],
        ["percona/percona-server-mongodb", MONGO_ENV],
        ["redis", REDIS_ENV],
      ]),
    ).toEqual({
      postgres: "pg_dump",
      "postgis/postgis": "pg_dump",
      mysql: "mysql_dump",
      mariadb: "mysql_dump",
      "percona/percona-server": "mysql_dump",
      mongo: "mongo_dump",
      "percona/percona-server-mongodb": "mongo_dump",
      redis: "redis_rdb",
    });
  });

  it("routes a tagged database image to its dump producer", () => {
    expect(
      kindsFor([
        ["postgres:16", POSTGRES_ENV],
        ["postgis/postgis:16-3.4", POSTGRES_ENV],
        ["mysql:8.0", MYSQL_ENV],
        ["mariadb:11", MYSQL_ENV],
        ["mongo:7", MONGO_ENV],
        ["redis:7", REDIS_ENV],
        ["redis/redis-stack:latest", REDIS_ENV],
      ]),
    ).toEqual({
      "postgres:16": "pg_dump",
      "postgis/postgis:16-3.4": "pg_dump",
      "mysql:8.0": "mysql_dump",
      "mariadb:11": "mysql_dump",
      "mongo:7": "mongo_dump",
      "redis:7": "redis_rdb",
      "redis/redis-stack:latest": "redis_rdb",
    });
  });

  it("leaves an image that merely starts with a database name on the volume fallback", () => {
    expect(
      kindsFor([
        ["postgrest/postgrest", POSTGRES_ENV],
        ["postgresql", POSTGRES_ENV],
        ["prometheuscommunity/postgres-exporter", POSTGRES_ENV],
        ["myapp/postgres", POSTGRES_ENV],
        ["mysqld-exporter", MYSQL_ENV],
        ["mongo-express", MONGO_ENV],
        ["redis-sentinel", REDIS_ENV],
        ["redisinsight", REDIS_ENV],
      ]),
    ).toEqual({
      "postgrest/postgrest": "volume",
      postgresql: "volume",
      "prometheuscommunity/postgres-exporter": "volume",
      "myapp/postgres": "volume",
      "mysqld-exporter": "volume",
      "mongo-express": "volume",
      "redis-sentinel": "volume",
      redisinsight: "volume",
    });
  });

  it("leaves a repository under a database namespace on the volume fallback", () => {
    expect(
      kindsFor([
        ["mysql/mysql-server:8.0", MYSQL_ENV],
        ["mysql/mysql-router:8.0", MYSQL_ROUTER_ENV],
        ["mariadb/maxscale:23.08", MYSQL_ROUTER_ENV],
        ["postgres/whatever", POSTGRES_ENV],
        ["mongo/anything", MONGO_ENV],
      ]),
    ).toEqual({
      "mysql/mysql-server:8.0": "volume",
      "mysql/mysql-router:8.0": "volume",
      "mariadb/maxscale:23.08": "volume",
      "postgres/whatever": "volume",
      "mongo/anything": "volume",
    });
  });

  it("keeps an untagged database image on the volume fallback when its credentials are missing", () => {
    expect(autoDetectProducer(serviceWith("postgres", {})).kind).toBe("volume");
    expect(autoDetectProducer(serviceWith("mysql", {})).kind).toBe("volume");
  });
});
