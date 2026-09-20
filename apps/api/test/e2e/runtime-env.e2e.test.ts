/** Real project store → deployment snapshot → source build → running container (#801). */
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DockerRuntime, NoopInfraProvider, createHostExecutor } from "@repo/adapters";
import { repos, type Project } from "@repo/db";
import { decrypt } from "@repo/platform/engine/lib/encryption";
import { LOCAL_HOST_PORT_TARGET } from "@repo/platform/engine/lib/host-port-target";
import { buildBackgroundContext } from "@repo/platform/engine/lib/background-context";
import { describeDockerE2E, requireDocker } from "../helpers/docker-e2e";
import { seedOrg, seedProject } from "../helpers/seed";

const ORIGINAL = {
  AUTH_SECRET: "dummy-auth-801",
  PG_PASSWORD: "dummy-pg-801",
  PUBLIC_VALUE: "public-801",
};
let runtime: DockerRuntime;
let project: Project;
let sourceDir = "";
let owner: Awaited<ReturnType<typeof seedOrg>>;
let builds: typeof import("@repo/platform/engine/modules/deployments/build.service");
let envService: typeof import("@repo/platform/engine/modules/projects/project-env.service");

async function settle(id: string) {
  await vi.waitFor(
    async () => {
      const row = await repos.deployment.findById(id);
      if (row?.status === "failed" || row?.status === "cancelled") {
        const session = await repos.deployment.findBuildSessionByDeploymentId(id);
        throw new Error(JSON.stringify({ error: row.errorMessage, logs: session?.logs }));
      }
      expect(row?.status).toBe("ready");
      expect(await repos.deployment.listInFlightByProject(project.id)).toEqual([]);
    },
    { timeout: 180_000, interval: 500 },
  );
  return (await repos.deployment.findById(id))!;
}

async function checkContainer(id: string, values: Record<string, string>) {
  const row = await settle(id);
  for (const [key, value] of Object.entries(values))
    expect(decrypt((row.envVars as Record<string, string>)[key]!)).toBe(value);
  const info = await runtime.docker.getContainer(row.containerId!).inspect();
  expect(info.State.Running).toBe(true);
  for (const [key, value] of Object.entries(values))
    expect(info.Config.Env).toContain(`${key}=${value}`);
  // The process must have survived its required-secret startup check. The build
  // marker proves the same dummy values also reached the preceding Docker build.
  const executor = await runtime.inContainerExecutor(row.containerId!);
  expect((await executor.exec("wget -qO- http://127.0.0.1:8080/build-ok")).trim()).toBe(
    "build-env-present",
  );
  expect(
    (await executor.exec("printenv AUTH_SECRET PG_PASSWORD PUBLIC_VALUE")).trim().split("\n"),
  ).toEqual(Object.values(values));
}

describeDockerE2E("secret environment through the real deployment pipeline (#801)", () => {
  beforeAll(async () => {
    await requireDocker();
    runtime = await DockerRuntime.create({ transport: "socket" });
    await runtime.pullImage("busybox:1.37.0");
    owner = await seedOrg();
    sourceDir = await mkdtemp(join(tmpdir(), "openship-env-801-"));
    await writeFile(
      join(sourceDir, "Dockerfile"),
      [
        "FROM busybox:1.37.0",
        "ARG AUTH_SECRET",
        "ARG PG_PASSWORD",
        "ARG PUBLIC_VALUE",
        'RUN test "$AUTH_SECRET" = "dummy-auth-801" && test "$PG_PASSWORD" = "dummy-pg-801" && test "$PUBLIC_VALUE" = "public-801" && mkdir -p /www && echo build-env-present > /www/build-ok',
        "EXPOSE 8080",
        `CMD ${JSON.stringify(["sh", "-c", 'test -n "$AUTH_SECRET" && test -n "$PG_PASSWORD" && exec httpd -f -p 8080 -h /www'])}`,
        "",
      ].join("\n"),
    );
    project = await seedProject(owner.organizationId, {
      gitProvider: "local",
      localPath: sourceDir,
      framework: "docker",
      packageManager: "npm",
      buildImage: "busybox:1.37.0",
      installCommand: "",
      buildCommand: "",
      startCommand: "",
      port: 8080,
      hasBuild: true,
      hasServer: true,
      runtimeMode: "docker",
      routeStrategy: "loopback-port",
    });
    const localPlatform = {
      platform: {
        target: "selfhosted" as const,
        runtime,
        routing: new NoopInfraProvider(),
        ssl: new NoopInfraProvider(),
        system: null,
        executor: createHostExecutor(),
      },
      effectiveTarget: "local" as const,
      runtimeMode: "docker" as const,
      usesManagedRouting: false,
      serverId: null,
      // Match the real local resolver: host-port allocation is serialized by
      // the physical bind namespace, not by a nullable server-row id.
      hostPortTarget: LOCAL_HOST_PORT_TARGET,
    };
    vi.doMock("@repo/platform/engine/lib/deployment-runtime", async (importOriginal) => {
      const actual = (await importOriginal()) as Record<string, unknown>;
      return {
        ...actual,
        resolveDeploymentRuntime: async () => ({ runtime, serverId: null }),
        resolveDeploymentPlatform: async () => localPlatform,
        resolveServerExecutor: async () => ({
          id: "local",
          executor: createHostExecutor(),
          conn: { host: "127.0.0.1", port: 22, user: "root" },
          isLocal: true,
          ssh: null,
        }),
      };
    });
    vi.doMock("../../src/lib/controller-helpers", async (importOriginal) => {
      const actual = (await importOriginal()) as Record<string, unknown>;
      return {
        ...actual,
        platform: () => localPlatform.platform,
      };
    });
    // 2. This fixture deliberately has no edge daemon. Preserve the production
    // strict-inventory contract, but provide its authoritative empty result so
    // the rollback test can exercise loopback allocation without provisioning
    // unrelated edge infrastructure.
    vi.doMock("@repo/adapters", async (importOriginal) => {
      const actual = (await importOriginal()) as Record<string, unknown>;
      return {
        ...actual,
        getPlatform: () => localPlatform.platform,
        edgeProxyFor: () => ({
          listLoopbackUpstreamPortsStrict: async () => new Set<number>(),
        }),
      };
    });
    // 3. GitHub check runs: there's no installation in a test org.
    // Keep everything real except the GitHub calls (no installation in a test org).
    vi.doMock(
      "@repo/platform/engine/modules/deployments/service-checks",
      async (importOriginal) => {
        const actual = (await importOriginal()) as Record<string, unknown>;
        return {
          ...actual,
          emitInitialServiceChecks: async () => {},
          emitServiceCheckResults: async () => {},
          emitDeploymentCheck: async () => {},
          completeDeploymentCheck: async () => {},
        };
      },
    );

    vi.doMock("@repo/platform/engine/lib/platform-config", async (importOriginal) => ({
      ...((await importOriginal()) as Record<string, unknown>),
      platform: () => localPlatform.platform,
    }));
    builds = await import("@repo/platform/engine/modules/deployments/build.service");
    envService = await import("@repo/platform/engine/modules/projects/project-env.service");
  }, 180_000);

  afterAll(async () => {
    const { drainDeploymentExecutions } =
      await import("@repo/platform/engine/modules/deployments/deployment-cancellation");
    await drainDeploymentExecutions();
    if (project && runtime) {
      for (const id of await runtime.listProjectContainerIds(project.id)) await runtime.destroy(id);
      for (const image of await runtime.listProjectImages(project.id)) {
        for (const tag of image.repoTags) await runtime.removeImage(tag);
      }
    }
    await runtime?.dispose();
    if (sourceDir) await rm(sourceDir, { recursive: true, force: true });
  }, 180_000);

  it("delivers encrypted secret and non-secret project values to build and runtime", async () => {
    await envService.mergeEnvVars(project.id, owner.organizationId, {
      environment: "production",
      deletes: [],
      upserts: Object.entries(ORIGINAL).map(([key, value]) => ({
        key,
        value,
        isSecret: key !== "PUBLIC_VALUE",
      })),
    });
    const stored = await repos.project.listEnvVars(project.id, "production", null);
    expect(stored.filter((row) => row.isSecret)).toHaveLength(2);
    expect(stored.every((row) => row.value !== ORIGINAL[row.key as keyof typeof ORIGINAL])).toBe(
      true,
    );
    const ctx = buildBackgroundContext({
      organizationId: owner.organizationId,
      userId: owner.userId,
    });
    const deployment = await builds.triggerDeployment(ctx, {
      projectId: project.id,
      trigger: "manual",
    });
    expect(deployment.deployment.id).toBeTruthy();
    await checkContainer(deployment.deployment.id, ORIGINAL);
  }, 240_000);
});
