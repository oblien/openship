import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { createConnection } from "node:net";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import {
  CommandSourceBackupExecutor,
  DockerRuntime,
  resolveExecutor,
  scopedVolumeName,
  type CommandExecutor,
  type ServiceHandle,
} from "@repo/adapters";
import { shellQuote } from "@repo/core";
import { resolveCloudProjectVolumeName } from "../../../../packages/adapters/src/runtime/cloud/docker-volume";
import type { PlannedImportService } from "@repo/platform/engine/modules/migration/platform-import-plan";
import { describeDockerE2E, requireDocker, dockerSocketPath } from "../helpers/docker-e2e";

// Only provider control and the app database are substituted. Application
// processes, stopped source volumes, archive streams, destination volume
// ownership, startup and restart persistence use a real Docker daemon.
const h = vi.hoisted(() => ({
  project: {} as any,
  source: undefined as unknown,
  runtime: undefined as unknown,
  workspaceId: undefined as string | undefined,
  exportOnly: vi.fn(),
}));
vi.mock("@repo/db", () => ({
  repos: {
    project: { findById: async () => h.project },
    service: { listByProject: async () => [] },
  },
}));
vi.mock("@repo/platform/engine/modules/migration/migration-access", () => ({
  requireMigrationServer: async () => ({ id: "server", workspaceId: h.workspaceId }),
}));
vi.mock("@repo/platform/engine/modules/migration/providers/railway-data", () => ({
  openRailwayDataSource: async () => h.source,
}));
vi.mock("@repo/platform/engine/modules/migration/providers/railway-project-transfer", () => ({
  assertRailwayExportOnly: h.exportOnly,
}));
vi.mock("@repo/platform/engine/modules/migration/migration-runtime", () => ({
  createMigrationDockerRuntime: () => (h.runtime as () => Promise<unknown>)(),
}));
vi.mock("@repo/platform/engine/lib/cloud-workspace-lock", () => ({
  withCloudWorkspaceActivity: async (_id: string, work: () => Promise<unknown>) => work(),
}));
vi.mock("@repo/platform/engine/lib/project-runtime-lock", () => ({
  withProjectRuntimeLock: async (_id: string, work: () => Promise<unknown>) => work(),
}));
import { copyPlatformData } from "@repo/platform/engine/modules/migration/platform-import-data";

type Fixture = {
  name: string;
  image: string;
  mount: string;
  env?: string[];
  command?: string[];
  ready: string[];
  seed: string[];
  read: string[];
};
const fixtures: Fixture[] = [
  {
    name: "postgres",
    image: "postgres:17-alpine",
    mount: "/var/lib/postgresql/data",
    env: ["POSTGRES_PASSWORD=test-only", "POSTGRES_DB=app"],
    ready: ["pg_isready", "-h", "127.0.0.1", "-U", "postgres"],
    seed: [
      "psql",
      "-U",
      "postgres",
      "-d",
      "app",
      "-v",
      "ON_ERROR_STOP=1",
      "-c",
      "CREATE TABLE records(id integer primary key, value text); INSERT INTO records SELECT n, repeat('مرحبا ✓ ',10) FROM generate_series(1,1000) n; CREATE ROLE preserved_role NOLOGIN;",
    ],
    read: [
      "psql",
      "-U",
      "postgres",
      "-d",
      "app",
      "-Atc",
      "SELECT count(*),md5(string_agg(value,'|' order by id)) FROM records; SELECT rolname FROM pg_roles WHERE rolname='preserved_role'",
    ],
  },
  {
    name: "redis-aof",
    image: "redis:7-alpine",
    mount: "/data",
    command: ["redis-server", "--appendonly", "yes"],
    ready: ["redis-cli", "PING"],
    seed: [
      "sh",
      "-ec",
      "dd if=/dev/zero bs=1048576 count=20 2>/dev/null | redis-cli -x SET large; redis-cli HSET record alpha beta; redis-cli SET expiry alive EX 36000",
    ],
    read: [
      "sh",
      "-ec",
      "redis-cli --raw GET large | sha256sum; redis-cli HGET record alpha; redis-cli EXISTS expiry; redis-cli CONFIG GET appendonly",
    ],
  },
  {
    name: "mysql",
    image: "mysql:8.4",
    mount: "/var/lib/mysql",
    env: ["MYSQL_ROOT_PASSWORD=test-only"],
    ready: [
      "mysql",
      "--protocol=tcp",
      "-h",
      "127.0.0.1",
      "-uroot",
      "-ptest-only",
      "-e",
      "SELECT 1",
    ],
    seed: [
      "mysql",
      "-uroot",
      "-ptest-only",
      "-e",
      "CREATE DATABASE app; CREATE TABLE app.records(id int primary key, value text); INSERT INTO app.records VALUES(1,'migration ✓'); CREATE VIEW app.saved AS SELECT * FROM app.records; CREATE USER 'reader'@'%' IDENTIFIED BY 'test-only'; GRANT SELECT ON app.* TO 'reader'@'%';",
    ],
    read: [
      "mysql",
      "-uroot",
      "-ptest-only",
      "--batch",
      "--skip-column-names",
      "-e",
      "SELECT * FROM app.saved; SELECT user,host FROM mysql.user WHERE user='reader';",
    ],
  },
  {
    name: "mongodb",
    image: "mongo:8",
    mount: "/data/db",
    env: ["MONGO_INITDB_ROOT_USERNAME=root", "MONGO_INITDB_ROOT_PASSWORD=test-only"],
    ready: [
      "mongosh",
      "-u",
      "root",
      "-p",
      "test-only",
      "--authenticationDatabase",
      "admin",
      "--quiet",
      "--eval",
      "if(db.adminCommand({getCmdLineOpts:1}).parsed.security?.authorization!=='enabled')quit(1);db.adminCommand({ping:1})",
    ],
    seed: [
      "mongosh",
      "-u",
      "root",
      "-p",
      "test-only",
      "--authenticationDatabase",
      "admin",
      "--quiet",
      "--eval",
      "const a=db.getSiblingDB('app');a.records.insertOne({_id:1,value:'migration ✓'});a.records.createIndex({value:1},{unique:true});a.createUser({user:'reader',pwd:'test-only',roles:[{role:'read',db:'app'}]})",
    ],
    read: [
      "mongosh",
      "-u",
      "root",
      "-p",
      "test-only",
      "--authenticationDatabase",
      "admin",
      "--quiet",
      "--eval",
      "const a=db.getSiblingDB('app');print(JSON.stringify({rows:a.records.find().toArray(),indexes:a.records.getIndexes().map(i=>i.name),users:a.getUsers().users.map(u=>u.user)}))",
    ],
  },
  {
    name: "unknown-sqlite-app",
    image: "python:3.12-alpine",
    mount: "/data",
    command: ["sleep", "infinity"],
    ready: ["python", "-c", "import sqlite3"],
    seed: [
      "python",
      "-c",
      "import sqlite3;c=sqlite3.connect('/data/app.sqlite');c.execute('create table records(id integer primary key,value text)');c.executemany('insert into records values(?,?)',[(i,'مرحبا ✓') for i in range(1000)]);c.commit()",
    ],
    read: [
      "python",
      "-c",
      "import sqlite3,json,hashlib;r=sqlite3.connect('/data/app.sqlite').execute('select * from records order by id').fetchall();print(len(r),hashlib.sha256(json.dumps(r).encode()).hexdigest())",
    ],
  },
];

describeDockerE2E("generic stopped-volume provider import", () => {
  const tag = `opsh-cold-import-${randomUUID().slice(0, 8)}`;
  const containers: string[] = [],
    volumes: string[] = [];
  let runtime: DockerRuntime;
  const handle = (id: string): ServiceHandle => ({
    id,
    name: id,
    projectId: tag,
    projectSlug: tag,
    image: null,
    env: {},
    volumes: [],
    containerId: id,
    namespaceVolumes: false,
  });
  const exec = async (id: string, command: string[]) => {
    const r = await resolveExecutor("docker", runtime).execStream(handle(id), command);
    const chunks: Buffer[] = [];
    for await (const chunk of r.stdout) chunks.push(Buffer.from(chunk));
    const exit = await r.awaitExit;
    if (exit.code !== 0) throw new Error(`Fixture command failed: ${exit.stderr.slice(-500)}`);
    return Buffer.concat(chunks).toString().trim();
  };
  const ready = async (id: string, command: string[]) => {
    for (let n = 0; n < 120; n++) {
      try {
        await exec(id, command);
        return;
      } catch {
        await delay(500);
      }
    }
    throw new Error("Fixture did not become ready");
  };
  beforeAll(async () => {
    await requireDocker();
    runtime = await DockerRuntime.create({ transport: "socket" });
    await runtime.pullImage("alpine:3");
  });
  afterAll(async () => {
    if (!runtime) return;
    for (const id of containers)
      await runtime.docker.getContainer(id).remove({ force: true, v: true });
    const owned = await runtime.docker.listVolumes({
      filters: { label: [`openship.migration=${tag}`] },
    });
    for (const name of new Set([...volumes, ...(owned.Volumes ?? []).map((v) => v.Name)])) {
      try {
        await runtime.docker.getVolume(name).remove();
      } catch (error) {
        if ((error as { statusCode?: number }).statusCode !== 404) throw error;
      }
    }
    await runtime.dispose();
  });
  it.each(
    fixtures.flatMap((fixture) =>
      ["socket", "cloud"].map((transport) => ({ ...fixture, transport })),
    ),
  )(
    "moves $name to $transport without native database tools, preserving data after restart",
    async (fixture) => {
      h.workspaceId = fixture.transport === "cloud" ? "test-workspace" : undefined;
      h.runtime = () =>
        fixture.transport === "cloud"
          ? DockerRuntime.create({
              transport: "cloud",
              // Exercise the production Cloud Docker transport against a real
              // daemon. Only the provider WebSocket tunnel is substituted.
              cloudConnection: async () => {
                const socket = createConnection(dockerSocketPath);
                await once(socket, "connect");
                return socket;
              },
              executor: {
                exec: async () => {
                  throw new Error("Import attempted to run on the API host");
                },
                dispose: async () => {},
              } as unknown as CommandExecutor,
            })
          : DockerRuntime.create({ transport: "socket" });
      await runtime.pullImage(fixture.image);
      const projectId = `${tag}-${fixture.name}-${fixture.transport}`,
        sourceVolume = `${projectId}-source`,
        targetVolume =
          fixture.transport === "cloud"
            ? await resolveCloudProjectVolumeName(runtime.docker, projectId, projectId, "data-0")
            : scopedVolumeName(projectId, "data-0");
      await runtime.docker.createVolume({ Name: sourceVolume, Labels: { "openship.test": tag } });
      volumes.push(sourceVolume, targetVolume);
      const start = async (volume: string, image = fixture.image, command = fixture.command) => {
        const c = await runtime.docker.createContainer({
          Image: image,
          Cmd: command,
          Env: fixture.env,
          Labels: { "openship.test": tag },
          HostConfig: { Binds: [`${volume}:${fixture.mount}`] },
        });
        containers.push(c.id);
        await c.start();
        return c;
      };
      const source = await start(sourceVolume);
      await ready(source.id, fixture.ready);
      await exec(source.id, fixture.seed);
      const expected = await exec(source.id, fixture.read);
      const path = shellQuote(`${fixture.mount}/migration-files`);
      await exec(source.id, [
        "sh",
        "-ec",
        `mkdir -p ${path}; printf 'arbitrary volume contents' > ${path}/record; chmod 640 ${path}/record; chown 123:456 ${path}/record; ln -s record ${path}/link`,
      ]);
      await source.stop({ t: 30 });
      const exporter = await start(sourceVolume, "alpine:3", ["sleep", "infinity"]);
      const channel = {
        rawExec: async (command: string) => {
          const child = spawn("docker", ["exec", exporter.id, "sh", "-c", command], {
            stdio: ["ignore", "pipe", "pipe"],
          });
          return {
            stdout: child.stdout,
            stderr: child.stderr,
            kill: () => {
              child.kill("SIGKILL");
            },
            onClose: new Promise<number>((resolve, reject) => {
              child.once("error", reject);
              child.once("close", (code) => resolve(code ?? 1));
            }),
          };
        },
      } as CommandExecutor;
      h.source = {
        executor: new CommandSourceBackupExecutor(channel, [fixture.mount]),
        dispose: async () => {},
      };
      h.project = {
        id: projectId,
        slug: projectId,
        organizationId: "test-org",
        serverId: "test-server",
        activeDeploymentId: null,
      };
      h.exportOnly.mockImplementation(async () => {
        expect((await source.inspect()).State.Running).toBe(false);
      });
      const service = {
        source: {
          id: fixture.name,
          name: fixture.name,
          kind: "app",
          image: fixture.image,
          env: {},
          instanceId: exporter.id,
          volumes: [{ id: "data", mountPath: fixture.mount }],
        },
        data: "copy",
        transfer: "cold-volume",
        create: { name: fixture.name, volumes: [`data-0:${fixture.mount}`] },
        environment: {},
        bindings: [],
      } as PlannedImportService;
      const args = {
        runId: tag,
        service,
        projectId,
        signal: new AbortController().signal,
        log: () => {},
        progress: vi.fn(),
      };
      await copyPlatformData(args);
      expect(args.progress).toHaveBeenCalled();
      await expect(copyPlatformData(args)).rejects.toMatchObject({
        code: "IMPORT_VOLUME_NOT_EMPTY",
      });
      const inspectTarget = await start(targetVolume, "alpine:3", ["sleep", "infinity"]);
      expect(
        await exec(inspectTarget.id, [
          "sh",
          "-ec",
          `cat ${path}/record; stat -c '%u:%g:%a' ${path}/record; readlink ${path}/link`,
        ]),
      ).toBe("arbitrary volume contents123:456:640\nrecord");
      await inspectTarget.stop({ t: 1 });
      const target = await start(targetVolume);
      await ready(target.id, fixture.ready);
      expect(await exec(target.id, fixture.read)).toBe(expected);
      await target.restart({ t: 30 });
      await ready(target.id, fixture.ready);
      expect(await exec(target.id, fixture.read)).toBe(expected);
      await target.stop({ t: 30 });
      await exporter.stop({ t: 1 });
    },
  );
});
