import { afterEach, describe, expect, it, vi } from "vitest";
import { CloudDockerRuntime, DockerRuntime, type ContainerInfo } from "@repo/adapters";
import { AnalyticsProjectSchemas, DeploymentControlSchemas } from "@repo/contracts";
import { presentOperationOutput } from "../src/resource-operations";

const runtimes: DockerRuntime[] = [];
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.dispose()));
  vi.restoreAllMocks();
});

async function createRuntime(kind: "Docker" | "Cloud", workspaceStatus = "running") {
  const runtime =
    kind === "Docker"
      ? await DockerRuntime.create({ dockerSocketPath: "/tmp/openship-test-absent.sock" })
      : await CloudDockerRuntime.forWorkspace(
          {
            workspaces: {
              get: async () => ({
                id: "workspace-a",
                namespace: "namespace-a",
                status: "active",
                info: { status: workspaceStatus },
              }),
            },
          } as never,
          {
            projectId: "project-a",
            ownerWorkspaceId: "managed-a",
            workspaceId: "workspace-a",
            namespace: "namespace-a",
            provisionLock: { run: (fn) => fn() },
            resolveRegistryAuth: async () => undefined,
          },
        );
  runtimes.push(runtime);
  return runtime;
}

// These are the shared response boundaries used by HTTP, SDK, and MCP calls.
function present(info: ContainerInfo) {
  return [
    presentOperationOutput(
      DeploymentControlSchemas.containerInfo,
      info,
      "deployments.containerInfo",
    ),
    presentOperationOutput(AnalyticsProjectSchemas.containerInfo, info, "analytics.containerInfo"),
  ];
}

describe.each(["Docker", "Cloud"] as const)("%s container-info responses", (kind) => {
  it.each([
    {
      name: "explicit limits",
      hostConfig: { NanoCpus: 500_000_000, Memory: 512 * 1024 * 1024 },
      expected: { cpuCores: 0.5, memoryMb: 512 },
    },
    {
      name: "full server capacity",
      hostConfig: { NanoCpus: 0, Memory: 0 },
      expected: { cpuCores: 0, memoryMb: 0 },
    },
  ])("preserves $name through output validation", async ({ hostConfig, expected }) => {
    const runtime = await createRuntime(kind);
    // Mock only Docker I/O; ownership checks, limit decoding, and schemas are real.
    vi.spyOn(runtime, "docker", "get").mockReturnValue({
      getContainer: () => ({
        inspect: async () => ({
          Image: "sha256:image-a",
          Config: { Labels: { "openship.project": "project-a" } },
          HostConfig: hostConfig,
          State: { Status: "exited", Running: false },
          NetworkSettings: { Networks: {} },
        }),
      }),
    } as never);
    const info = await runtime.getContainerInfo("service-a");
    for (const result of present(info)) {
      expect(result).toEqual({
        containerId: "service-a",
        status: "stopped",
        imageId: "sha256:image-a",
        resources: expected,
      });
    }
  });

  it("accepts a missing container without resource information", async () => {
    const runtime = await createRuntime(kind);
    vi.spyOn(runtime, "docker", "get").mockReturnValue({
      getContainer: () => ({
        inspect: async () => {
          throw Object.assign(new Error("No such container"), { statusCode: 404 });
        },
      }),
    } as never);
    const info = await runtime.getContainerInfo("missing-container");
    for (const result of present(info)) {
      expect(result).toEqual({ containerId: "missing-container", status: "missing" });
    }
  });
});

it("accepts a stopped Cloud server without inspecting or inventing container limits", async () => {
  const runtime = await createRuntime("Cloud", "stopped");
  const getContainer = vi.fn();
  vi.spyOn(runtime, "docker", "get").mockReturnValue({ getContainer } as never);
  const info = await runtime.getContainerInfo("service-a");
  for (const result of present(info)) {
    expect(result).toEqual({ containerId: "service-a", status: "stopped" });
  }
  expect(getContainer).not.toHaveBeenCalled();
});

// Guards the recurring class: ContainerInfo grew a field the closed schema lacked.
it("accepts every optional ContainerInfo field", () => {
  const full = {
    containerId: "service-a",
    status: "running",
    imageId: "sha256:image-a",
    ip: "172.18.0.2",
    hostPort: 3000,
    hostPortByContainerPort: { "3000": 3000 },
    uptimeSeconds: 10,
    usage: { cpuPercent: 1, memoryMb: 2, diskMb: 3, networkRxBytes: 4, networkTxBytes: 5 },
    resources: { cpuCores: 1, memoryMb: 512 },
  } satisfies Required<ContainerInfo>;
  for (const result of present(full)) expect(result).toEqual(full);
});
