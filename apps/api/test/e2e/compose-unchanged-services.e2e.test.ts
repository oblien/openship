import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { BuildLogger, DockerRuntime, type ResourceConfig } from "@repo/adapters";
import { repos, type Project } from "@repo/db";
import { resolveRuntimeResources } from "@repo/platform/engine/lib/resources";
import { projectServicesToDeployableServices } from "@repo/platform/engine/modules/deployments/compose/project-services";
import { describeDockerE2E, requireDocker } from "../helpers/docker-e2e";
import { seedDeployment, seedOrg, seedProject, setActive } from "../helpers/seed";

const IMAGE = "postgres:16-alpine";
const DATABASE_COMMAND = "psql -h db -U app -d app -At -v ON_ERROR_STOP=1";

describeDockerE2E("unchanged Compose database deployments (#986)", () => {
  let runtime: DockerRuntime;
  const projects: Project[] = [];

  beforeAll(async () => {
    await requireDocker();
    runtime = await DockerRuntime.create({ transport: "socket" });
    await runtime.pullImage(IMAGE);
  }, 120_000);

  afterEach(async ({ task }) => {
    vi.restoreAllMocks();
    for (const project of projects.splice(0)) {
      for (const id of await runtime.listProjectContainerIds(project.id)) {
        if (task.result?.state === "fail") {
          console.error(
            `Container ${id}:\n${(await runtime.getRuntimeLogs(id, 60)).map((entry) => entry.message).join("\n")}`,
          );
        }
        await runtime.destroy(id);
      }
      await runtime.removeNetwork(project.slug);
      await runtime.removeVolume(`openship-${project.slug}-pgdata`);
      await runtime.removeVolume(`openship-${project.slug}-appdata`);
    }
  });

  afterAll(async () => {
    await runtime?.dispose();
  });

  async function stack() {
    const { organizationId } = await seedOrg();
    const project = await seedProject(organizationId, {
      slug: `compose-986-${crypto.randomUUID().slice(0, 8)}`,
      framework: "docker-compose",
      routeStrategy: "container-ip",
      runtimeMode: "docker",
    });
    projects.push(project);
    const parsed: Parameters<typeof repos.service.syncFromCompose>[1] = [
      {
        name: "db",
        image: IMAGE,
        environment: { POSTGRES_USER: "app", POSTGRES_DB: "app", POSTGRES_PASSWORD: "test-only" },
        volumes: ["pgdata:/var/lib/postgresql/data"],
        advanced: {
          healthcheck: { test: ["CMD", "pg_isready", "-U", "app"], interval: "1s", retries: 30 },
        },
        // Deliberately no stop_grace_period, matching the issue's PostgreSQL service.
      },
      {
        name: "app",
        image: IMAGE,
        build: ".",
        dependsOn: ["db"],
        environment: { PGPASSWORD: "test-only" },
        volumes: ["appdata:/var/lib/postgresql/data"],
        commandArgv: ["sh", "-c", "trap 'exit 0' TERM INT; while :; do sleep 1 & wait $!; done"],
      },
    ];

    async function deploy() {
      // Exercise the real shared writes used by ensure, requestBuildAccess,
      // and the worker's frozen snapshot, including the sync AFTER dep creation.
      await repos.service.syncFromCompose(project.id, parsed, { composeAuthoritative: true });
      const services = await repos.service.listByProject(project.id);
      const snapshot = projectServicesToDeployableServices(services);
      await repos.service.syncFromCompose(project.id, snapshot, { removeMissing: false });
      const current = (await repos.project.findById(project.id))!;
      const resources = current.resources as ResourceConfig | null;
      const deployment = await seedDeployment(project, {
        imageRef: "compose",
        containerId: "compose",
        meta: {
          runtimeMode: "docker",
          deployTarget: "local",
          composeServices: snapshot,
          resources,
        },
      });
      await repos.service.syncFromCompose(project.id, snapshot, { removeMissing: false });
      const { deployComposeServices } =
        await import("@repo/platform/engine/modules/deployments/compose/deploy.service");
      const result = await deployComposeServices(
        current,
        deployment,
        runtime,
        new BuildLogger(() => undefined),
        {
          executor: null,
          localHost: false,
          resources: resolveRuntimeResources(resources, { isCloud: false }),
          // The buildable app is rebuilt each time; use the prepared test image
          // so this regression exercises activation without unrelated build tools.
          builtImages: new Map(services.filter((s) => s.build).map((s) => [s.id, IMAGE])),
          preparedLocalImages: new Map(services.map((s) => [s.id, IMAGE])),
        },
      );
      expect(result.status, JSON.stringify(result)).toBe("ready");
      await setActive(project.id, deployment.id);
      const rows = await repos.service.listByDeployment(deployment.id);
      expect(rows).toHaveLength(2);
      const db = rows.find((row) => row.serviceName === "db")!;
      const app = rows.find((row) => row.serviceName === "app")!;
      expect(db.containerId).toBeTruthy();
      expect(app.containerId).toBeTruthy();
      const exec = await runtime.inContainerExecutor(app.containerId!);
      await expect
        .poll(
          async () => {
            try {
              return (await exec.exec(`${DATABASE_COMMAND} -c 'SELECT 1'`)).trim();
            } catch {
              return "not ready";
            }
          },
          { interval: 200, timeout: 30_000 },
        )
        .toBe("1");
      return { result, db, app, exec };
    }

    return { project, parsed, deploy };
  }

  it("keeps PostgreSQL running while repeatedly replacing only the buildable app", async () => {
    const fixture = await stack();
    const first = await fixture.deploy();
    await first.exec.exec(
      `${DATABASE_COMMAND} -c "CREATE TABLE marker (value text); INSERT INTO marker VALUES ('survives')"`,
    );
    const startedAt = (
      await first.exec.exec(`${DATABASE_COMMAND} -c 'SELECT pg_postmaster_start_time()'`)
    ).trim();
    const activate = vi.spyOn(runtime, "deployServiceWorkload");
    const destroy = vi.spyOn(runtime, "destroy");
    let previousAppId = first.app.containerId;

    for (let attempt = 0; attempt < 3; attempt++) {
      activate.mockClear();
      destroy.mockClear();
      const next = await fixture.deploy();
      expect(next.db.containerId).toBe(first.db.containerId);
      expect(next.app.containerId).not.toBe(previousAppId);
      expect(next.result.summary.deployed).toBe(1);
      expect(activate.mock.calls.map(([, config]) => config.serviceName)).toEqual(["app"]);
      expect(destroy).not.toHaveBeenCalledWith(first.db.containerId);
      expect(
        (await next.exec.exec(`${DATABASE_COMMAND} -c 'SELECT pg_postmaster_start_time()'`)).trim(),
      ).toBe(startedAt);
      expect(
        (await next.exec.exec(`${DATABASE_COMMAND} -c 'SELECT value FROM marker'`)).trim(),
      ).toBe("survives");
      expect(await runtime.listProjectContainerIds(fixture.project.id)).toHaveLength(2);
      expect(await repos.service.listByProject(fixture.project.id)).toHaveLength(2);
      previousAppId = next.app.containerId;
    }
  });

  it("applies a real database configuration change with a clean shutdown and retained data", async () => {
    const fixture = await stack();
    const first = await fixture.deploy();
    await first.exec.exec(
      `${DATABASE_COMMAND} -c "CREATE TABLE marker (value text); INSERT INTO marker VALUES ('survives')"`,
    );
    fixture.parsed[0]!.environment = { ...fixture.parsed[0]!.environment, PGAPPNAME: "updated" };
    const next = await fixture.deploy();

    expect(next.db.containerId).not.toBe(first.db.containerId);
    const dbExec = await runtime.inContainerExecutor(next.db.containerId!);
    for (let probe = 0; probe < 3; probe++) {
      // A terminated exec watchdog must be reaped by its wrapper, not adopted
      // by PostgreSQL as PID 1 and mistaken for a crashed database process.
      expect((await dbExec.exec("printenv PGAPPNAME")).trim()).toBe("updated");
      expect(
        (await next.exec.exec(`${DATABASE_COMMAND} -c 'SELECT value FROM marker'`)).trim(),
      ).toBe("survives");
    }
    // PostgreSQL records the previous stop in its control file, so this checks
    // the actual shutdown behavior rather than whether stop() was called.
    const logs = await runtime.getRuntimeLogs(next.db.containerId!, 100);
    expect(logs.map((entry) => entry.message).join("\n")).not.toMatch(
      /was not properly shut down|automatic recovery in progress|database system was interrupted/,
    );

    const repeated = await fixture.deploy();
    expect(repeated.db.containerId).toBe(next.db.containerId);
    expect(await runtime.listProjectContainerIds(fixture.project.id)).toHaveLength(2);
  });

  it.each([
    {
      behavior: "applies changed project resource limits to an otherwise unchanged database",
      own: undefined,
      recreate: true,
      expected: { cpuCores: 1, memoryMb: 256 },
    },
    {
      behavior: "keeps the database when service overrides leave its effective limits unchanged",
      own: { cpuCores: 2, memoryMb: 512 },
      recreate: false,
      expected: { cpuCores: 2, memoryMb: 512 },
    },
    {
      behavior: "applies an inherited CPU change while preserving the service's memory override",
      own: { memoryMb: 512 },
      recreate: true,
      expected: { cpuCores: 1, memoryMb: 512 },
    },
  ])("$behavior", async ({ own, recreate, expected }) => {
    const fixture = await stack();
    if (own) {
      fixture.parsed[0]!.advanced = { ...fixture.parsed[0]!.advanced, resources: own };
    }
    const first = await fixture.deploy();
    await repos.project.update(fixture.project.id, {
      resources: { cpuCores: 1, memoryMb: 256, diskMb: 0 },
    });
    const next = await fixture.deploy();
    expect(next.db.containerId === first.db.containerId).toBe(!recreate);
    expect(await runtime.getContainerInfo(next.db.containerId!)).toMatchObject({
      resources: expected,
    });

    const repeated = await fixture.deploy();
    expect(repeated.db.containerId).toBe(next.db.containerId);
    expect(await runtime.listProjectContainerIds(fixture.project.id)).toHaveLength(2);
  });

  it("recreates an unchanged database when its previous container is stopped", async () => {
    const fixture = await stack();
    const first = await fixture.deploy();
    await runtime.stop(first.db.containerId!);
    const next = await fixture.deploy();
    expect(next.db.containerId).not.toBe(first.db.containerId);
    expect(await runtime.getContainerInfo(next.db.containerId!)).toMatchObject({
      status: "running",
    });
    expect(next.result.summary.deployed).toBe(2);
    expect(await runtime.listProjectContainerIds(fixture.project.id)).toHaveLength(2);
  });
});
