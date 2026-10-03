import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPlatform, type Platform } from "../platform";
import { BareRuntime } from "./bare";
import { DockerRuntime } from "./docker";
import { CloudDockerRuntime } from "./cloud/docker";
import { CloudWorkspaceExecutor } from "./cloud/workspace-executor";
import { CloudServerConnection } from "./cloud/server-connection";
import { managedProjectRoutingScope } from "./cloud/routing-scope";

const fixture = vi.hoisted(() => ({ client: {} as any }));
vi.mock("../oblien", () => ({ Oblien: vi.fn(function () { return fixture.client; }) }));
const platforms: Platform[] = [];
const lock = { run: <T>(fn: () => Promise<T>) => fn() };
const server = { workspaceId: "vm-a", ownerWorkspaceId: "subscription-a", projectId: "project-a", provisionLock: lock, resolveRegistryAuth: async () => undefined };
const config = { target: "cloud" as const, cloudToken: "namespace-token", cloudNamespace: "namespace-a", cloudServer: server };

beforeEach(() => {
  const row = { id: "vm-a", namespace: "namespace-a", status: "running" };
  fixture.client = { workspace: vi.fn(() => ({ get: vi.fn(async () => row), workloads: { list: vi.fn(async () => []) } })), workspaces: { get: vi.fn(async () => row), create: vi.fn(), delete: vi.fn() } };
});
afterEach(async () => {
  for (const platform of platforms.splice(0)) await platform.runtime.dispose?.();
  vi.restoreAllMocks();
});
async function make(overrides: Partial<Parameters<typeof createPlatform>[0]> = {}) {
  const platform = await createPlatform({ ...config, ...overrides });
  platforms.push(platform);
  return platform;
}

describe("Cloud changes the execution destination, not the deployment runtime", () => {
  it.each(["docker", "bare"] as const)("uses the shared %s runtime and a managed executor", async mode => {
    const platform = await make({ runtime: mode });
    expect(platform.runtime).toBeInstanceOf(mode === "docker" ? DockerRuntime : BareRuntime);
    expect(platform.executor).toBeInstanceOf(CloudWorkspaceExecutor);
    expect(platform.localHost).toBe(false);
    expect(platform.system).toBeNull();
    expect(fixture.client.workspaces.create).not.toHaveBeenCalled();
  });
  it("has no implicit host when a Cloud destination is absent", async () => {
    const platform = await make({ cloudServer: undefined });
    await expect(platform.runtime.build({ projectId: "project-a", buildStrategy: "local" } as never)).rejects.toMatchObject({ code: "DEPLOYMENT_SERVER_REQUIRED" });
    expect(platform.executor).toBeNull();
    expect(fixture.client.workspace).not.toHaveBeenCalled();
  });
  it.each(["docker", "bare"] as const)("requires namespace-scoped credentials for %s", async runtime => {
    await expect(make({ runtime, cloudToken: undefined })).rejects.toThrow("organization-scoped credentials");
    await expect(make({ runtime, cloudNamespace: undefined })).rejects.toThrow("organization-scoped credentials");
  });
  it.each(["docker", "bare"] as const)("refuses API-host source paths before %s executes them", async runtime => {
    const platform = await make({ runtime });
    const transfer = vi.spyOn(platform.executor!, "transferIn");
    await expect(platform.runtime.build({ projectId: "project-a", localPath: "/etc", buildStrategy: "local" } as never)).rejects.toThrow(/control-plane|host/i);
    expect(transfer).not.toHaveBeenCalled();
    expect(fixture.client.workspaces.create).not.toHaveBeenCalled();
  });
  it("resolves bare process ports without opening Docker and rejects sibling ports", async () => {
    const workloads = [
      { id: "openship-release-a", labels: { "openship.project": "project-a", "openship.deployment": "release-a", "openship.ports": "[3000]" } },
      { id: "openship-release-b", labels: { "openship.project": "project-b", "openship.deployment": "release-b", "openship.ports": "[4000]" } },
    ];
    fixture.client.workspace.mockReturnValue({ workloads: { list: async () => workloads } });
    const connection = new CloudServerConnection(fixture.client, { workspaceId: server.workspaceId, namespace: config.cloudNamespace });
    const containers = vi.fn(async () => ({ resolveUrl: async () => { throw new Error("unowned port"); }, resolveTarget: vi.fn() }));
    const scope = managedProjectRoutingScope(connection, server, containers);
    expect(await scope.resolveUrl("http://127.0.0.1:3000")).toBe(3000);
    expect(containers).not.toHaveBeenCalled();
    await expect(scope.resolveUrl("http://127.0.0.1:4000")).rejects.toThrow("unowned port");
    await expect(scope.resolveUrl("http://user:secret@127.0.0.1:3000")).rejects.toThrow("Invalid");
    await connection.dispose();
  });
  it("keeps managed container builds on the shared Docker builder", async () => {
    const platform = await make({ runtime: "docker" });
    const runtime = platform.runtime as CloudDockerRuntime;
    vi.spyOn(runtime, "prepareComposeSource").mockResolvedValue();
    const build = vi.spyOn(DockerRuntime.prototype, "build").mockResolvedValue({ status: "deploying", imageRef: "built" } as never);
    const input = { projectId: "project-a", cloneOnServer: false } as never;
    await runtime.build(input);
    expect(build).toHaveBeenCalledWith(expect.objectContaining({ cloneOnServer: true, localPath: undefined }), undefined);
    expect(runtime.connectionOptions?.executor).toBe(platform.executor);
  });
});
