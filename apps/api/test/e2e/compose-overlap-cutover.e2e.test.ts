import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import { BuildLogger, DockerRuntime, createHostExecutor, runDeployPipeline } from "@repo/adapters";
import type { DeployConfig } from "@repo/adapters";
import { describeDockerE2E, requireDocker } from "../helpers/docker-e2e";

const id = randomUUID().slice(0, 8);
const slug = `cutover-${id}`;
const projectId = `project-${id}`;
const image = "busybox:latest";

describeDockerE2E("capacity-admitted Compose cutover", () => {
  let runtime: DockerRuntime;
  let group: { id: string };
  const containers = new Set<string>();
  const host = createHostExecutor();
  const configuration = (deploymentId: string, content: string, previousContainerId?: string) => ({
    deploymentId,
    projectId,
    slug,
    serviceName: "web",
    image,
    previousContainerId,
    imageAlreadyPrepared: true,
    ports: ["8080"],
    publicPort: 8080,
    namespaceVolumes: true,
    volumes: [],
    environment: {},
    restart: "no",
    resources: { cpuCores: 0.05, memoryMb: 32 },
    commandArgv: [
      "sh",
      "-c",
      `mkdir -p /www; echo '${content}' >/www/index.html; exec httpd -f -p 8080 -h /www`,
    ],
  });
  const read = async (ip: string) =>
    host.exec(`curl --fail --silent --max-time 2 http://${ip}:8080/`);
  const ready = async (containerId: string) => {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const ip = await runtime.getContainerIp(containerId);
      if (ip)
        try {
          await read(ip);
          return;
        } catch {
          /* retry a not-yet-listening candidate */
        }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error("Candidate did not become ready");
  };

  beforeAll(async () => {
    await requireDocker();
    runtime = await DockerRuntime.create({ transport: "socket" });
    await runtime.pullImage(image);
    group = await runtime.ensureServiceGroup({ deploymentId: `old-${id}`, projectId, slug });
  }, 120_000);
  afterAll(async () => {
    for (const containerId of containers)
      await runtime?.destroy(containerId).catch(() => undefined);
    await runtime?.removeNetwork(slug).catch(() => undefined);
    await runtime?.dispose();
  });

  it("keeps the original reachable until readiness and route replacement have finished", async () => {
    const original = await runtime.deployServiceWorkload(group, configuration(`old-${id}`, "old"));
    containers.add(original.containerId);
    await ready(original.containerId);
    const originalIp = (await runtime.getContainerIp(original.containerId))!;
    const plan = await runtime.prepareServiceCutover(
      group,
      configuration(`new-${id}`, "new", original.containerId),
      { executor: host },
    );
    expect(plan, "CI must exercise the overlap path, not silently fall back").not.toBeNull();
    let candidateId = "";
    const order: string[] = [];
    const result = await runDeployPipeline(
      {
        canOverlap: true,
        activate: async () => {
          const candidate = await runtime.deployServiceWorkload(group, plan!.config);
          candidateId = candidate.containerId;
          containers.add(candidateId);
          expect((await read(originalIp)).trim()).toBe("old");
          return candidate;
        },
        healthCheck: async (containerId) => {
          await ready(containerId);
          await plan!.publish(containerId);
          order.push("healthy");
        },
        resolveTargetUrl: async (containerId) =>
          `http://${await runtime.getContainerIp(containerId)}:8080`,
        deactivate: async () => {
          order.push("retired");
          await plan!.retire(candidateId);
        },
      },
      {
        config: { port: 8080 } as DeployConfig,
        previousContainerId: original.containerId,
        domains: [{ hostname: "cutover.invalid", tls: false, targetPort: 8080 }],
        routing: {
          registerRoute: async (route) => {
            order.push("routed");
            expect((await read(originalIp)).trim()).toBe("old");
            expect(
              (await host.exec(`curl --fail --silent --max-time 2 ${route.targetUrl}`)).trim(),
            ).toBe("new");
          },
        },
      },
      new BuildLogger(),
    );
    expect(result.status, result.error).toBe("ready");
    expect(result.routeWarnings ?? []).toEqual([]);
    expect(order).toEqual(["healthy", "routed", "retired"]);
    await expect(runtime.docker.getContainer(original.containerId).inspect()).rejects.toMatchObject(
      { statusCode: 404 },
    );
    expect((await read((await runtime.getContainerIp(candidateId))!)).trim()).toBe("new");
  }, 60_000);

  it("preserves the incumbent when a staged candidate fails readiness", async () => {
    const active = (await runtime.listProjectContainerIds(projectId))[0]!;
    const before = (await runtime.getContainerIp(active))!;
    const plan = await runtime.prepareServiceCutover(
      group,
      configuration(`bad-${id}`, "broken", active),
      { executor: host },
    );
    expect(plan).not.toBeNull();
    let candidateId = "";
    const result = await runDeployPipeline(
      {
        canOverlap: true,
        activate: async () => {
          const candidate = await runtime.deployServiceWorkload(group, plan!.config);
          candidateId = candidate.containerId;
          containers.add(candidateId);
          return candidate;
        },
        healthCheck: async () => {
          throw new Error("readiness rejected");
        },
        deactivate: async () => {
          throw new Error("must not retire the original");
        },
      },
      { config: { port: 8080 } as DeployConfig, previousContainerId: active, domains: [] },
      new BuildLogger(),
    );
    expect(result.status).toBe("failed");
    await runtime.destroy(candidateId);
    expect((await read(before)).trim()).toBe("new");
  });
});
