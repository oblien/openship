import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Oblien } from "oblien";
import { CloudDockerRuntime } from "./docker";
import { DockerRuntime } from "../docker";
import type { MultiServiceDeployConfig, MultiServiceDeployResult } from "../types";
import { CLOUD_DOCKER_BRIDGE_VERSION } from "./docker-bridge-source";
import { CloudInfraProvider } from "../../infra/cloud";
import { resolveExecutor } from "../../backup/registry";
import { DockerBackupExecutor } from "../../backup/executors/docker";

const config: MultiServiceDeployConfig = { projectId: "project-a", deploymentId: "d1", slug: "project-a", serviceName: "api",
  image: "test:1", imageAlreadyPrepared: true, volumes: ["data:/data"], ports: ["5432:5432"], namespaceVolumes: true,
  environment: { SECRET: "test" }, publicPort: 8080, cloudEndpoints: [{ hostname: "project-a.opsh.io", port: 8080, custom: false }] };
const group = { id: "network-project-a", kind: "docker-network" } as never;
let runtime: CloudDockerRuntime;
let status: string;
let count: number;
let rows: Array<{ Id: string; Labels: Record<string, string>; Ports: Array<{ PrivatePort: number; PublicPort: number; Type: string }> }>;
let captures: MultiServiceDeployConfig[];
let pageRows: Map<string, Record<string, unknown>>;
let spend: ReturnType<typeof vi.fn<() => Promise<void>>>;
let ws: Record<string, any>;
let pages: Record<string, any>;
let provider: Record<string, any>;
let routes: ReturnType<typeof vi.fn<Oblien["routes"]["set"]>>;
beforeEach(async () => {
  status = "running"; count = 0; rows = []; captures = []; pageRows = new Map(); spend = vi.fn(); routes = vi.fn();
  ws = {
    get: vi.fn(async () => ({ id: "workspace-a", namespace: "namespace-a", status: "active", info: { status } })),
    start: vi.fn(async () => { status = "running"; }), resume: vi.fn(async () => { status = "running"; }),
    stop: vi.fn(), delete: vi.fn(), restart: vi.fn(),
    invalidateRuntime: vi.fn(),
    network: { get: vi.fn(async () => ({ ingress_ports: [] })), update: vi.fn() },
    runtime: vi.fn(async () => ({ proxy: () => ({ fetch: async () => new Response(CLOUD_DOCKER_BRIDGE_VERSION) }) })),
  };
  pages = {
    list: vi.fn(async () => ({ pages: [...pageRows.values()] })),
    get: vi.fn(async (slug: string) => {
      const page = pageRows.get(slug);
      if (!page) throw Object.assign(new Error("missing"), { status: 404 });
      return { page };
    }),
    create: vi.fn(async (input: { slug: string; workspace_id: string; path: string }) => {
      const page = { slug: input.slug, domain: "opsh.io", url: `https://${input.slug}.opsh.io`, namespace: "namespace-a", source_workspace_id: input.workspace_id, exported_path: input.path };
      pageRows.set(input.slug, page); return { page };
    }),
    enable: vi.fn(), connectDomain: vi.fn(), delete: vi.fn(),
  };
  provider = { workspace: vi.fn(() => ws), workspaces: { get: ws.get, create: vi.fn(), delete: vi.fn() }, pages };
  runtime = await CloudDockerRuntime.forWorkspace(provider as unknown as Oblien, {
    projectId: "project-a", workspaceId: "workspace-a", namespace: "namespace-a", beforeProvision: async () => { await spend(); },
    provisionLock: { run: fn => fn() }, resolveRegistryAuth: async () => undefined,
    adminProxy: { createPage: pages.create, pages: pages as never, setRoutes: async (hostname, input) => routes(hostname, input) },
  });
  vi.spyOn(runtime.executor, "exec").mockResolvedValue("");
  vi.spyOn(runtime.executor, "writeFile").mockResolvedValue();
  vi.spyOn(runtime, "docker", "get").mockReturnValue({
    listContainers: async () => rows,
    getImage: () => ({ inspect: async () => ({ Config: { Volumes: { "/image-data": {} } } }) }),
  } as never);
  vi.spyOn(DockerRuntime.prototype, "deployServiceWorkload").mockImplementation(async (_group, input) => {
    captures.push(input);
    const ports = input.ports.map(port => {
      const [, host, container] = port.split(":");
      return { PrivatePort: Number(container), PublicPort: Number(host), Type: "tcp" };
    });
    const id = `container-${++count}`;
    rows = rows.filter(row => row.Labels["openship.service"] !== input.serviceName);
    rows.push({ Id: id, Ports: ports, Labels: { "openship.project": input.projectId, "openship.service": input.serviceName } });
    return { containerId: id, status: "running", hostPortByContainerPort: Object.fromEntries(ports.map(port => [port.PrivatePort, port.PublicPort])) } as MultiServiceDeployResult;
  });
});
afterEach(async () => { await runtime?.dispose(); vi.restoreAllMocks(); });
describe("containers on one Oblien Docker workspace", () => {
  it("applies environment inside the existing workspace without replacing or restarting the VM", async () => {
    const apply = vi.spyOn(DockerRuntime.prototype, "applyEnvironment").mockResolvedValue({ containerId: "replacement-a" });
    const options = { projectId: "project-a", serviceName: "api", onReplaced: vi.fn() };
    await expect(runtime.applyEnvironment("container-a", { VALUE: "new" }, options)).resolves.toEqual({ containerId: "replacement-a" });
    expect(apply).toHaveBeenCalledExactlyOnceWith("container-a", { VALUE: "new" }, options);
    expect(provider.workspaces.create).not.toHaveBeenCalled();
    expect(ws.restart).not.toHaveBeenCalled();
    expect(ws.delete).not.toHaveBeenCalled();
    expect(spend).toHaveBeenCalled();
    apply.mockClear();
    await expect(runtime.applyEnvironment("container-a", {}, { ...options, projectId: "other-project" })).rejects.toThrow("different project");
    expect(apply).not.toHaveBeenCalled();
    spend.mockRejectedValue(new Error("out of credits"));
    await expect(runtime.applyEnvironment("container-a", {}, options)).rejects.toThrow("out of credits");
    expect(apply).not.toHaveBeenCalled();
  });
  it.each(["running", "stopped"])("updates a %s bridge before accepting Docker connections", async initialState => {
    vi.useFakeTimers();
    let bridgeState = initialState;
    let runningVersion = "openship-docker-bridge-v1";
    let installedVersion: string | undefined;
    vi.mocked(runtime.executor.writeFile).mockImplementation(async (_path, content) => {
      installedVersion = String(content).match(/^VERSION = "([^"]+)"/m)?.[1];
    });
    ws.runtime.mockResolvedValue({ proxy: () => ({
      fetch: async () => bridgeState === "running"
        ? new Response(runningVersion)
        : new Response("stopped", { status: 503 }),
    }) });
    ws.workloads = {
      list: vi.fn(async () => [{ id: "bridge-a", name: "openship-docker-api-v1", state: bridgeState }]),
      stop: vi.fn(async () => { bridgeState = "stopped"; }),
      start: vi.fn(async () => {
        if (bridgeState === "running") throw new Error("Bridge is already running");
        if (!installedVersion) throw new Error("Bridge script is missing");
        bridgeState = "running";
        runningVersion = installedVersion;
      }),
      logs: vi.fn(async () => ({})),
    };
    try {
      const outcome = runtime["ensureBridge"]().then(() => "ready", error => error);
      await vi.advanceTimersByTimeAsync(61_000);
      expect(await outcome).toBe("ready");
      expect(runningVersion).toBe(CLOUD_DOCKER_BRIDGE_VERSION);
      expect(ws.workloads.stop).toHaveBeenCalledTimes(initialState === "running" ? 1 : 0);
      expect(ws.workloads.start).toHaveBeenCalledWith("bridge-a");
      expect(ws.restart).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
  it("allocates distinct edge ports for services sharing a container port, and reuses them on redeploy", async () => {
    const first = await runtime.deployServiceWorkload(group, { ...config, cloudEndpoints: [...config.cloudEndpoints!, { hostname: "console.opsh.io", port: 9090, custom: false }] });
    const peer = await runtime.deployServiceWorkload(group, { ...config, serviceName: "peer", cloudEndpoints: [{ hostname: "peer.opsh.io", port: 8080, custom: false }] });
    const next = await runtime.deployServiceWorkload(group, { ...config, deploymentId: "d2" });
    expect(first.hostPortByContainerPort![8080]).not.toBe(peer.hostPortByContainerPort![8080]);
    expect(first.hostPortByContainerPort![8080]).not.toBe(first.hostPortByContainerPort![9090]);
    expect(next.hostPortByContainerPort![8080]).toBe(first.hostPortByContainerPort![8080]);
    expect(routes).toHaveBeenCalledWith("project-a.opsh.io", expect.objectContaining({ routes: [expect.objectContaining({ action: { kind: "proxy", workspace: "workspace-a", port: next.hostPortByContainerPort![8080] } })] }));
    expect(provider.workspaces.create).not.toHaveBeenCalled();
  });
  it("keeps named and image-declared volume identities across container replacements", async () => {
    await runtime.deployServiceWorkload(group, config);
    await runtime.deployServiceWorkload(group, { ...config, deploymentId: "d2", image: "test:2" });
    expect(captures[0]!.volumes).toContain("data:/data");
    expect(captures[0]!.volumes.some(volume => volume.endsWith(":/image-data"))).toBe(true);
    expect(captures[1]!.volumes).toEqual(captures[0]!.volumes);
    expect(ws.delete).not.toHaveBeenCalled();
  });
  it("keeps unexposed database ports internal and publishes explicit composite targets", async () => {
    await runtime.deployServiceWorkload(group, { ...config, cloudEndpoints: [] });
    expect(captures[0]!.ports).toEqual([]);
    expect(pages.create).not.toHaveBeenCalled();
    await runtime.deployServiceWorkload(group, { ...config, cloudEndpoints: [], cloudProxyPorts: [8080] });
    expect(captures[1]!.ports).toHaveLength(1);
    expect(captures[1]!.ports[0]).toMatch(/^0\.0\.0\.0:\d+:8080$/);
  });
  it("reports edge failures while returning the created container for recovery", async () => {
    routes.mockRejectedValue(new Error("edge unavailable"));
    const result = await runtime.deployServiceWorkload(group, config);
    expect(result.containerId).toBe("container-1");
    expect(result.status).toBe("running");
    expect(result.routeWarnings).toHaveLength(1);
    expect(ws.delete).not.toHaveBeenCalled();
  });
  it("does not take over another project's hostname in the same organization", async () => {
    pageRows.set("project-a", { namespace: "namespace-a", source_workspace_id: "workspace-other", exported_path: "/app" });
    const result = await runtime.deployServiceWorkload(group, config);
    expect(result.routeWarnings).toHaveLength(1);
    expect(pages.enable).not.toHaveBeenCalled();
    expect(routes).not.toHaveBeenCalled();
  });
  it("creates separate route owners for custom domains without rebinding the shared workspace", async () => {
    await runtime.publishRoute("one.example.com", 30001, true);
    await runtime.publishRoute("two.example.com", 30002, true);
    const calls = pages.connectDomain.mock.calls;
    expect(calls[0][0]).not.toBe(calls[1][0]);
    expect(calls[0][1]).toEqual({ domain: "one.example.com" });
    expect(calls[1][1]).toEqual({ domain: "two.example.com" });
  });
  it("blocks spending and cross-project deploys before Docker activation", async () => {
    await expect(runtime.deployServiceWorkload(group, { ...config, projectId: "project-other" })).rejects.toThrow("different project");
    spend.mockRejectedValue(new Error("out of credits"));
    await expect(runtime.deployServiceWorkload(group, config)).rejects.toThrow("out of credits");
    expect(captures).toEqual([]);
  });
  it("observes a stopped workspace without starting it; Start resumes explicitly", async () => {
    status = "stopped";
    expect(await runtime.getContainerInfo("container-a")).toEqual({ containerId: "container-a", status: "stopped" });
    expect(ws.start).not.toHaveBeenCalled();
    const start = vi.spyOn(DockerRuntime.prototype, "start").mockResolvedValue();
    await runtime.start("container-a");
    expect(ws.start).toHaveBeenCalledOnce();
    expect(start).toHaveBeenCalledWith("container-a");
  });
  it("retention and deletion operate on containers, never on their shared VM", async () => {
    const stop = vi.spyOn(DockerRuntime.prototype, "stop").mockResolvedValue();
    const destroy = vi.spyOn(DockerRuntime.prototype, "destroy").mockResolvedValue();
    const image = vi.spyOn(DockerRuntime.prototype, "removeImage").mockResolvedValue();
    await runtime.archive({ containerId: "old-container", imageRef: "openship/project-a:bld_old" } as never);
    await runtime.purge({ containerId: "old-container", imageRef: "openship/project-a:bld_old" } as never);
    expect(stop).toHaveBeenCalledWith("old-container");
    expect(destroy).toHaveBeenCalledWith("old-container");
    expect(image).toHaveBeenCalledWith("openship/project-a:bld_old");
    await expect(runtime.destroy("workspace-a")).rejects.toThrow("project teardown");
    expect(ws.stop).not.toHaveBeenCalled();
    expect(ws.delete).not.toHaveBeenCalled();
    expect(runtime.supports("unitRestore")).toBe(false);
    expect(resolveExecutor(runtime.name, runtime)).toBeInstanceOf(DockerBackupExecutor);
  });
  it("route teardown deletes only this workspace's routing anchor", async () => {
    await runtime.publishRoute("project-a.opsh.io", 30001, false);
    const infra = new CloudInfraProvider(provider as unknown as Oblien, { namespace: "namespace-a", dockerWorkspaceId: "workspace-a",
      adminProxy: { createPage: pages.create, pages: pages as never, domainRoutes: async () => ({ data: [{ hostname: "project-a.opsh.io", namespace: "namespace-a", owner_type: "page", owner_id: "project-a" }] }) as never } });
    await infra.removeRoute("project-a.opsh.io");
    expect(pages.delete).toHaveBeenCalledWith("project-a");
    pageRows.get("project-a")!.source_workspace_id = "workspace-other";
    await expect(infra.removeRoute("project-a.opsh.io")).rejects.toThrow("not owned");
  });
  it("inventories disabled routing Pages without confusing their numeric IDs with slugs", async () => {
    await runtime.publishRoute("project-a.opsh.io", 30001, false);
    pageRows.get("project-a")!.status = "disabled";
    pageRows.set("other", { slug: "other", domain: "opsh.io", namespace: "namespace-a", source_workspace_id: "workspace-other", exported_path: "/opt/openship/cloud-docker/routes/other" });
    expect(await runtime.listProjectRouteHostnames()).toEqual(["project-a.opsh.io"]);
    const infra = new CloudInfraProvider(provider as unknown as Oblien, { namespace: "namespace-a", dockerWorkspaceId: "workspace-a" });
    await infra.removeRoute("project-a.opsh.io");
    expect(pages.delete).toHaveBeenCalledWith("project-a");
  });
  it("does not read a control-plane path supplied as cloud build source", async () => {
    await expect(runtime.prepareComposeSource({ projectId: "project-a", localPath: "/etc" } as never)).rejects.toThrow("control-plane");
    expect(runtime.executor.writeFile).not.toHaveBeenCalled();
  });
});
