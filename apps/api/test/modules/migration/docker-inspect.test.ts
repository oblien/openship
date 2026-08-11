import { describe, expect, it } from "vitest";

import type { DockerContainerDetail, DockerNetworkInfo, DockerVolumeInfo } from "@repo/adapters";
import { reconcileStack } from "../../../src/modules/migration/docker-reconcile";
import { parseComposeFile, type ComposeService } from "../../../src/lib/compose-parser";

function declaredMap(compose: string): Map<string, ComposeService> {
  const map = new Map<string, ComposeService>();
  for (const svc of parseComposeFile(compose).services) map.set(svc.name, svc);
  return map;
}

const COMPOSE = `
services:
  web:
    image: myapp-web:latest
    depends_on: [db]
    ports: ["8080:3000"]
  db:
    image: postgres:16
    volumes:
      - myapp_pgdata:/var/lib/postgresql/data
`;

const WEB: DockerContainerDetail = {
  id: "c1",
  name: "myapp-web-1",
  image: "myapp-web:latest",
  imageId: "sha256:web",
  state: "running",
  env: ["PATH=/usr/bin", "NODE_ENV=production", "API_URL=http://db:5432"],
  labels: { "com.docker.compose.project": "myapp", "com.docker.compose.service": "web" },
  networks: ["myapp_default", "myapp_backend"],
  mounts: [],
  ports: [{ privatePort: 3000, publicPort: 8080, type: "tcp" }],
  restart: { name: "unless-stopped" },
  composeProject: "myapp",
  composeService: "web",
};

const DB: DockerContainerDetail = {
  id: "c2",
  name: "myapp-db-1",
  image: "postgres:16",
  imageId: "sha256:db",
  state: "running",
  env: ["PATH=/usr/bin", "POSTGRES_PASSWORD=secret", "LANG=C.UTF-8"],
  labels: { "com.docker.compose.project": "myapp", "com.docker.compose.service": "db" },
  networks: ["myapp_default", "myapp_backend"],
  mounts: [
    { type: "volume", name: "myapp_pgdata", destination: "/var/lib/postgresql/data", rw: true },
    { type: "bind", source: "/etc/myapp/pg.conf", destination: "/etc/postgresql/postgresql.conf", rw: false },
  ],
  ports: [{ privatePort: 5432, type: "tcp" }],
  restart: { name: "always" },
  composeProject: "myapp",
  composeService: "db",
};

const REDIS: DockerContainerDetail = {
  id: "c3",
  name: "cache",
  image: "redis:7",
  imageId: "sha256:redis",
  state: "running",
  env: ["PATH=/usr/bin"],
  labels: {},
  networks: ["bridge"],
  mounts: [],
  ports: [{ privatePort: 6379, publicPort: 6379, type: "tcp" }],
  composeProject: undefined,
  composeService: undefined,
};

/** A Coolify-managed app. Coolify injects EVERY variable explicitly at run time
 *  and its Nixpacks builds bake the same values into the image, so the runtime
 *  env and the image defaults overlap almost completely (#394). */
const COOLIFY_APP: DockerContainerDetail = {
  id: "c4",
  name: "app-kso4gc8",
  image: "app-kso4gc8:latest",
  imageId: "sha256:coolify",
  state: "running",
  env: ["PATH=/usr/bin", "NODE_ENV=production", "DATABASE_URL=postgres://db:5432/app"],
  labels: {
    "coolify.managed": "true",
    "coolify.type": "application",
    "coolify.applicationId": "7",
  },
  networks: ["coolify"],
  mounts: [],
  ports: [{ privatePort: 3000, publicPort: 8081, type: "tcp" }],
  composeProject: undefined,
  composeService: undefined,
};

const VOLUMES: DockerVolumeInfo[] = [
  { name: "myapp_pgdata", driver: "local", labels: {} },
  { name: "unused_vol", driver: "local", labels: {} },
];

const NETWORKS: DockerNetworkInfo[] = [
  { id: "n1", name: "myapp_default", driver: "bridge", labels: {} },
  { id: "n2", name: "myapp_backend", driver: "bridge", labels: {} },
  { id: "n3", name: "bridge", driver: "bridge", labels: {} },
];

describe("reconcileStack", () => {
  const stack = reconcileStack({
    serverId: "srv-1",
    details: [WEB, DB, REDIS],
    volumes: VOLUMES,
    networks: NETWORKS,
    declared: declaredMap(COMPOSE),
    alreadyManaged: 2,
  });

  it("reconstructs every candidate service", () => {
    expect(stack.services.map((s) => s.name).sort()).toEqual(["cache", "db", "web"]);
    expect(stack.adoptable).toBe(true);
    expect(stack.alreadyManaged).toBe(2);
    expect(stack.composeProjects).toEqual(["myapp"]);
  });

  it("groups services under their compose project, standalone last", () => {
    expect(stack.groups).toHaveLength(2);
    // Compose stack first.
    expect(stack.groups[0].project).toBe("myapp");
    expect(stack.groups[0].services.map((s) => s.name)).toEqual(["web", "db"]);
    // Standalone (null) last.
    expect(stack.groups[1].project).toBeNull();
    expect(stack.groups[1].services.map((s) => s.name)).toEqual(["cache"]);
  });

  it("merges compose declaration with inspect truth for compose services", () => {
    const web = stack.services.find((s) => s.name === "web")!;
    expect(web.source).toBe("compose");
    expect(web.dependsOn).toEqual(["db"]);
    expect(web.ports).toEqual(["8080:3000"]);
    // PATH is filtered as docker-injected noise; app env survives.
    expect(web.env).toEqual({ NODE_ENV: "production", API_URL: "http://db:5432" });
  });

  it("treats a compose-less container as a standalone service", () => {
    const redis = stack.services.find((s) => s.name === "cache")!;
    expect(redis.source).toBe("container");
    expect(redis.running).toBe(true);
    expect(redis.ports).toEqual(["6379:6379"]);
  });

  it("reads resolved named volumes from inspect and flags bind mounts", () => {
    const db = stack.services.find((s) => s.name === "db")!;
    const named = db.volumes.find((v) => v.type === "volume");
    expect(named?.source).toBe("myapp_pgdata");
    expect(db.volumes.some((v) => v.type === "bind")).toBe(true);
    expect(db.warnings.some((w) => w.toLowerCase().includes("bind mount"))).toBe(true);
    expect(db.restart).toBe("always");
  });

  it("reports only in-use named volumes, with their consumers", () => {
    expect(stack.volumes).toEqual([
      { name: "myapp_pgdata", driver: "local", inUseBy: ["db"] },
    ]);
  });

  it("warns about custom networks it will flatten", () => {
    const netWarning = stack.warnings.find((w) => w.includes("custom networks"));
    expect(netWarning).toContain("myapp_backend");
    expect(netWarning).not.toContain("myapp_default");
  });

  const withDefaults = reconcileStack({
    serverId: "srv-1",
    details: [DB],
    volumes: VOLUMES,
    networks: NETWORKS,
    declared: declaredMap(COMPOSE),
    alreadyManaged: 0,
    // Keyed by image ID, not tag — a moved tag must not lend its defaults.
    imageEnv: new Map([["sha256:db", ["PATH=/usr/bin", "LANG=C.UTF-8"]]]),
  });

  it("imports the operator's env and leaves the image's out", () => {
    const db = withDefaults.services.find((s) => s.name === "db")!;
    // LANG is image-supplied, PATH is denylisted, POSTGRES_PASSWORD survives.
    expect(db.env).toEqual({ POSTGRES_PASSWORD: "secret" });
  });

  it("reports what the image supplies, with values, instead of omitting it silently", () => {
    const db = withDefaults.services.find((s) => s.name === "db")!;
    // LANG is what the image supplies; PATH is denylisted noise and was never config.
    expect(db.envImageDefaults).toEqual({ LANG: "C.UTF-8" });
  });

  it("ignores image env fetched under a stale tag key", () => {
    // Same defaults keyed by TAG: the container's imageId no longer matches, so
    // nothing is attributed to the image and every var is imported as config.
    const stale = reconcileStack({
      serverId: "srv-1",
      details: [DB],
      volumes: VOLUMES,
      networks: NETWORKS,
      declared: declaredMap(COMPOSE),
      alreadyManaged: 0,
      imageEnv: new Map([["postgres:16", ["PATH=/usr/bin", "LANG=C.UTF-8"]]]),
    });
    const db = stale.services.find((s) => s.name === "db")!;
    expect(db.env).toEqual({ POSTGRES_PASSWORD: "secret", LANG: "C.UTF-8" });
    expect(db.envImageDefaults).toBeUndefined();
  });

  const coolify = reconcileStack({
    serverId: "srv-1",
    details: [COOLIFY_APP],
    volumes: VOLUMES,
    networks: NETWORKS,
    declared: new Map(),
    alreadyManaged: 0,
    imageEnv: new Map([["sha256:coolify", [...COOLIFY_APP.env]]]),
  });

  it("keeps a Coolify container's env even when it matches the image default", () => {
    const app = coolify.services.find((s) => s.name === "app-kso4gc8")!;
    // NODE_ENV and DATABASE_URL match the image default but are real config; PATH is denylisted.
    expect(app.env).toEqual({
      NODE_ENV: "production",
      DATABASE_URL: "postgres://db:5432/app",
    });
  });

  it("has nothing to report as image-supplied on a Coolify container", () => {
    // The two halves of the #394 fix meet here: Coolify re-sends the image's env
    // verbatim (the one shape provenance can't resolve), so the label short-circuits
    // the split rather than attributing every Nixpacks-baked variable to the image.
    const app = coolify.services.find((s) => s.name === "app-kso4gc8")!;
    expect(app.envImageDefaults).toBeUndefined();
  });

  it("reports the Coolify variables Docker cannot expose", () => {
    const app = coolify.services.find((s) => s.name === "app-kso4gc8")!;
    expect(app.warnings.some((w) => w.includes("build-time"))).toBe(true);
  });
});
