/** Completed image -> activation failure -> public retry -> normal pipeline.
 * Only runtime location is replaced; Docker, database, receipt, lifecycle,
 * admission, artifact reuse and container activation are real. */
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DockerRuntime, NoopInfraProvider, createHostExecutor } from "@repo/adapters";
import { repos, type Deployment, type Project } from "@repo/db";
import { describeDockerE2E, requireDocker } from "../helpers/docker-e2e";
import { seedDeployment, seedOrg, seedProject } from "../helpers/seed";

describeDockerE2E("retry completed Docker artifacts without rebuilding", () => {
  let runtime: DockerRuntime;
  let project: Project;
  let failed: Deployment;
  let directory: string;
  let image: string;

  beforeAll(async () => {
    await requireDocker();
    runtime = await DockerRuntime.create({ transport: "socket" });
    await runtime.pullImage("busybox:latest");
    directory = await mkdtemp(join(tmpdir(), "openship-artifact-retry-"));
    await writeFile(join(directory, "Dockerfile"), 'FROM busybox:latest\nCMD ["sleep", "3600"]\n');
    const org = await seedOrg();
    project = await seedProject(org.organizationId, {
      framework: "docker",
      localPath: directory,
      hasBuild: false,
      hasServer: false,
      workloadType: "worker",
      startCommand: "sleep 3600",
      runtimeMode: "docker",
      rollbackWindow: 1,
    });
    image = `openship/${project.slug}:bld_saved`;
    const stream = await runtime.docker.buildImage(
      { context: directory, src: ["Dockerfile"] },
      {
        t: image,
        labels: { "openship.project": project.id },
      },
    );
    await new Promise<void>((resolve, reject) =>
      runtime.docker.modem.followProgress(stream, (error: Error | null) =>
        error ? reject(error) : resolve(),
      ),
    );

    const located = {
      platform: {
        target: "selfhosted",
        runtime,
        routing: new NoopInfraProvider(),
        ssl: new NoopInfraProvider(),
        system: null,
        executor: createHostExecutor(),
      },
      effectiveTarget: "local",
      runtimeMode: "docker",
      usesManagedRouting: false,
      serverId: null,
      hostPortTarget: null,
    };
    vi.doMock("@repo/platform/engine/lib/deployment-runtime", async (original) => ({
      ...(await original<typeof import("@repo/platform/engine/lib/deployment-runtime")>()),
      resolveDeploymentPlatform: async () => located,
      resolveDeploymentRuntime: async () => ({ runtime, serverId: null }),
      withDeploymentRuntime: async (_dep: unknown, work: (runtime: DockerRuntime) => unknown) =>
        work(runtime),
    }));
    vi.doMock("@repo/platform/engine/lib/platform-config", async (original) => ({
      ...(await original<typeof import("@repo/platform/engine/lib/platform-config")>()),
      platform: () => located.platform,
    }));

    failed = await seedDeployment(project, {
      status: "deploying",
      imageRef: image,
      meta: {
        repoUrl: "",
        branch: "main",
        framework: "docker",
        buildImage: "",
        runtimeImage: "",
        packageManager: "",
        installCommand: "",
        buildCommand: "",
        outputDirectory: "",
        productionPaths: [],
        volumes: [],
        rootDirectory: "",
        port: 3000,
        startCommand: "sleep 3600",
        hasServer: false,
        hasBuild: false,
        workload: "worker",
        localPath: directory,
        deployTarget: "local",
        runtimeMode: "docker",
        buildStrategy: "server",
        serviceDeploymentMode: "single",
        configurationSecretsPreserved: true,
      },
    });
    const { recordDeploymentArtifacts } =
      await import("@repo/platform/engine/modules/deployments/deployment-artifacts");
    expect(await recordDeploymentArtifacts(failed, runtime, [{ imageRef: image }])).toBeDefined();
    const { onFailure } =
      await import("@repo/platform/engine/modules/deployments/deployment-lifecycle");
    await onFailure(
      {
        runtime,
        project,
        dep: failed,
        buildSessionId: "failed-fixture",
        persistLogs: () => [],
        provisioned: { imageRef: image },
      },
      "Fixture activation failure",
      123,
    );
    expect(await runtime.imageExistsLocally(image)).toBe(true);
    // No checkout remains. A fallback to source cannot accidentally pass.
    await rm(directory, { recursive: true, force: true });
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    if (runtime && project)
      for (const container of await runtime.listProjectContainerIds(project.id))
        await runtime.destroy(container).catch(() => {});
    if (runtime && image) await runtime.removeImage(image).catch(() => {});
    await runtime?.dispose();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it("runs the recorded image through the real redeploy entry point with no clone, build or pull", async () => {
    const build = vi.spyOn(runtime, "build").mockRejectedValue(new Error("Retry must not build"));
    const pull = vi.spyOn(runtime, "pullImage").mockRejectedValue(new Error("Retry must not pull"));
    const { redeployBuildSession } =
      await import("@repo/platform/engine/modules/deployments/build.service");
    const result = await redeployBuildSession(
      { userId: "", organizationId: project.organizationId } as never,
      failed.id,
      { reuseBuild: true },
    );
    let latest: Deployment | undefined;
    for (let i = 0; i < 180; i += 1) {
      latest = await repos.deployment.findById(result.deployment_id);
      if (
        latest &&
        ["ready", "failed", "cancelled"].includes(latest.status) &&
        !(await repos.deployment.listInFlightByProject(project.id)).some(
          (dep) => dep.id === latest!.id,
        )
      )
        break;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    expect(latest?.status, latest?.errorMessage ?? "Retry did not settle").toBe("ready");
    expect(result.deployment_id).not.toBe(failed.id);
    expect(latest?.buildDurationMs).toBe(0);
    expect((await repos.deployment.findBuildSessionByDeploymentId(result.deployment_id))?.durationMs).toBe(0);
    expect((await repos.deployment.findById(failed.id))?.buildDurationMs).toBe(123);
    const container = await runtime.docker.getContainer(latest!.containerId!).inspect();
    expect(container.State.Running).toBe(true);
    expect(container.Image).toBe(
      (failed.meta as { completedBuildArtifacts: { images: Array<{ imageId: string }> } })
        .completedBuildArtifacts.images[0]!.imageId,
    );
    expect(build).not.toHaveBeenCalled();
    expect(pull).not.toHaveBeenCalled();
  });
});
