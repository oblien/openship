import { afterAll, beforeAll, expect, it } from "vitest";
import { DockerRuntime } from "@repo/adapters";
import { repos, type Project } from "@repo/db";
import { resolveInheritedResources } from "@repo/platform/engine/lib/resources";
import { resolveFromReader } from "@repo/platform/engine/modules/deployments/prepare.service";
import { describeDockerE2E, requireDocker } from "../helpers/docker-e2e";
import { seedOrg, seedProject } from "../helpers/seed";

const IMAGE = "alpine:3.21";

describeDockerE2E("service swap limits survive source sync and real container recreation", () => {
  let runtime: DockerRuntime;
  let project: Project;
  beforeAll(async () => {
    await requireDocker();
    runtime = await DockerRuntime.create({ transport: "socket" });
    await runtime.pullImage(IMAGE);
    const { organizationId } = await seedOrg();
    project = await seedProject(organizationId, {
      slug: `swap-${crypto.randomUUID().slice(0, 8)}`,
      resources: { memoryMb: 128 },
    });
  }, 120_000);
  afterAll(async () => {
    if (runtime && project) {
      for (const id of await runtime.listProjectContainerIds(project.id)) await runtime.destroy(id);
      await runtime.removeNetwork(project.slug);
      await runtime.removeVolume(`openship-${project.slug}-state`);
    }
    await runtime?.dispose();
  });

  async function source(swapDisabled: boolean) {
    const content = JSON.stringify({
      resources: { memoryMb: 128 },
      services: [
        {
          name: "vault",
          image: IMAGE,
          resources: { swapDisabled },
          env: { TEST_VALUE: "preserved" },
          volumes: ["state:/data"],
          command: "sleep 3600",
        },
      ],
    });
    const scan = await resolveFromReader(
      {
        listDirectory: async () => [{ name: "openship.json", type: "file" }],
        readText: async (path) => (path === "openship.json" ? content : undefined),
        readJson: async (path) => (path === "openship.json" ? JSON.parse(content) : undefined),
        listTree: async () => [],
      },
      {
        name: "swap",
        full_name: "example/swap",
        owner: "example",
        private: false,
        default_branch: "main",
      },
      "main",
    );
    const [service] = await repos.service.syncFromCompose(project.id, scan.services!, {
      composeAuthoritative: true,
    });
    return service!;
  }

  async function deploy(swapDisabled: boolean, attempt: number) {
    const service = await source(swapDisabled);
    const group = await runtime.ensureServiceGroup({
      projectId: project.id,
      slug: project.slug,
      deploymentId: `swap-${attempt}`,
    });
    const result = await runtime.deployServiceWorkload(group, {
      deploymentId: `swap-${attempt}`,
      projectId: project.id,
      slug: project.slug,
      serviceName: service.name,
      image: IMAGE,
      imageAlreadyPrepared: true,
      ports: [],
      environment: service.environment ?? {},
      volumes: service.volumes ?? [],
      namespaceVolumes: true,
      command: service.command,
      resources: resolveInheritedResources(
        service.advanced?.resources,
        project.resources as Record<string, unknown>,
      ),
    });
    return { id: result.containerId, exec: await runtime.inContainerExecutor(result.containerId) };
  }

  it("enforces memory.swap.max=0 after recreation and honors a repository opt-out without losing data", async () => {
    expect((await runtime.info()).SwapLimit).toBe(true);
    const initial = await deploy(true, 1);
    // Read the kernel cgroup, not free(1), which reports host swap in containers.
    expect((await initial.exec.exec("cat /sys/fs/cgroup/memory.swap.max")).trim()).toBe("0");
    await initial.exec.exec("printf kept > /data/marker");
    expect((await runtime.getContainerInfo(initial.id)).resources?.swapDisabled).toBe(true);
    await expect(repos.project.update(project.id, { resources: null })).rejects.toMatchObject({
      code: "SWAP_DISABLED_REQUIRES_MEMORY_LIMIT",
    });
    expect((await initial.exec.exec("cat /data/marker")).trim()).toBe("kept");

    const recreated = await deploy(true, 2);
    expect(recreated.id).not.toBe(initial.id);
    expect((await recreated.exec.exec("cat /sys/fs/cgroup/memory.swap.max")).trim()).toBe("0");
    expect((await recreated.exec.exec("cat /data/marker; printenv TEST_VALUE")).trim()).toBe(
      "keptpreserved",
    );

    const allowed = await deploy(false, 3);
    expect((await allowed.exec.exec("cat /sys/fs/cgroup/memory.swap.max")).trim()).not.toBe("0");
    expect((await runtime.getContainerInfo(allowed.id)).resources?.swapDisabled).not.toBe(true);
    expect((await allowed.exec.exec("cat /data/marker; printenv TEST_VALUE")).trim()).toBe(
      "keptpreserved",
    );
  }, 120_000);
});
