import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PassThrough } from "node:stream";
import type { Oblien } from "oblien";
import { CloudDockerRuntime } from "./docker";
import { DockerRuntime } from "../docker";
import { BuildLogger } from "../build-pipeline";
import type { MultiServiceDeployConfig, MultiServiceDeployResult } from "../types";
import { CLOUD_DOCKER_BRIDGE_VERSION } from "./docker-bridge-source";
import * as dockerTransport from "./docker-transport";
import { CloudInfraProvider } from "../../infra/cloud";
import { resolveExecutor } from "../../backup/registry";
import { DockerBackupExecutor } from "../../backup/executors/docker";

const config: MultiServiceDeployConfig = { projectId: "project-a", deploymentId: "d1", slug: "project-a", serviceName: "api",
  image: "test:1", imageAlreadyPrepared: true, volumes: ["data:/data"], ports: ["5432:5432"], namespaceVolumes: true,
  environment: { SECRET: "test" }, publicPort: 8080, cloudEndpoints: [{ hostname: "project-a.opsh.io", port: 8080, custom: false }] };
const group = { id: "network-project-a", kind: "docker-network" } as never;
let runtime: CloudDockerRuntime;
let infra: CloudInfraProvider;
let status: string;
let count: number;
let rows: Array<{ Id: string; State: string; Names?: string[]; Labels: Record<string, string>; Ports: Array<{ PrivatePort: number; PublicPort: number; Type: string }> }>;
let stoppedPorts: Map<string, Record<string, Array<{ HostIp: string; HostPort: string }>>>;
let captures: MultiServiceDeployConfig[];
let pageRows: Map<string, Record<string, unknown>>;
let spend: ReturnType<typeof vi.fn<() => Promise<void>>>;
let ws: Record<string, any>;
let pages: Record<string, any>;
let provider: Record<string, any>;
let routes: ReturnType<typeof vi.fn<Oblien["routes"]["set"]>>;
beforeEach(async () => {
  status = "running"; count = 0; rows = []; captures = []; pageRows = new Map(); stoppedPorts = new Map(); spend = vi.fn(); routes = vi.fn().mockResolvedValue({ success: true } as never);
  ws = {
    get: vi.fn(async () => ({ id: "workspace-a", namespace: "namespace-a", status: "active", info: { status } })),
    start: vi.fn(async () => { status = "running"; }), resume: vi.fn(async () => { status = "running"; }),
    stop: vi.fn(), delete: vi.fn(), restart: vi.fn(),
    invalidateRuntime: vi.fn(),
    network: { get: vi.fn(async () => ({ ingress_ports: [] })), update: vi.fn(async () => ({ success: true })) },
    workloads: { list: vi.fn(async () => []), get: vi.fn(async () => { throw Object.assign(new Error("missing"), { status: 404 }); }) },
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
    enable: vi.fn(async () => ({ success: true })), connectDomain: vi.fn(), delete: vi.fn(async () => ({ success: true })),
  };
  provider = { workspace: vi.fn(() => ws), workspaces: { get: ws.get, create: vi.fn(), delete: vi.fn() }, pages };
  runtime = await CloudDockerRuntime.forWorkspace(provider as unknown as Oblien, {
    projectId: "project-a", ownerWorkspaceId: "managed-a", workspaceId: "workspace-a", namespace: "namespace-a", beforeProvision: async () => { await spend(); },
    provisionLock: { run: fn => fn() }, resolveRegistryAuth: async () => undefined,

  });
  infra = new CloudInfraProvider(provider as unknown as Oblien, {
    namespace: "namespace-a", scope: runtime.routingScope(),
    adminProxy: { pages: pages as never, setRoutes: async (hostname, input) => routes(hostname, input) },
  });
  vi.spyOn(runtime.executor, "exec").mockImplementation(async command => command.startsWith("docker ps -aq")
    ? rows.map(row => JSON.stringify(stoppedPorts.get(row.Id) ?? Object.fromEntries(row.Ports.map(port => [`${port.PrivatePort}/tcp`, [{ HostIp: "0.0.0.0", HostPort: String(port.PublicPort) }]])))).join("\n")
    : command.startsWith("ss -tulnp") ? 'Netid State Recv-Q Send-Q Local Address:Port Peer Address:Port Process\ntcp LISTEN 0 128 127.0.0.1:9990 0.0.0.0:* users:(("bridge",pid=10,fd=3))\n' : "");
  vi.spyOn(runtime.executor, "writeFile").mockResolvedValue();
  vi.spyOn(runtime, "docker", "get").mockReturnValue({
    listContainers: async () => rows,
    getNetwork: () => ({ inspect: async () => ({ Labels: { "openship.project": "project-a" } }) }),
    getContainer: (id: string) => ({ inspect: async () => ({
      Id: id, Config: { Labels: rows.find(row => row.Id === id)?.Labels ?? { "openship.project": "project-a" } },
      State: { Status: "exited", Running: false },
      HostConfig: { PortBindings: stoppedPorts.get(id) },
      NetworkSettings: { Ports: {} },
    }) }),
    getImage: () => ({ inspect: async () => ({ Config: { Volumes: { "/image-data": {} } } }) }),
    getVolume: () => ({ inspect: async () => ({ Labels: { "openship.project": "project-a" } }) }),
  } as never);
  vi.spyOn(DockerRuntime.prototype, "deployServiceWorkload").mockImplementation(async (_group, input) => {
    captures.push(input);
    const ports = input.ports.map(port => {
      const [, host, container] = port.split(":");
      return { PrivatePort: Number(container), PublicPort: Number(host), Type: "tcp" };
    });
    const id = `container-${++count}`;
    rows = rows.filter(row => row.Labels["openship.service"] !== input.serviceName);
    rows.push({ Id: id, Names: [`/openship-${input.slug}-${input.serviceName}`], State: "running", Ports: ports, Labels: { "openship.project": input.projectId, "openship.service": input.serviceName } });
    return { containerId: id, status: "running", hostPortByContainerPort: Object.fromEntries(ports.map(port => [port.PrivatePort, port.PublicPort])) } as MultiServiceDeployResult;
  });
});
afterEach(async () => { await runtime?.dispose(); vi.restoreAllMocks(); });
describe("containers on one Oblien Docker workspace", () => {
  it("reports a missing provider proxy immediately without reinstalling or restarting the bridge", async () => {
    ws.runtime.mockResolvedValue({ proxy: () => ({ fetch: async () => new Response("404 page not found", {
      status: 404, headers: { "x-request-id": "provider-request-404" },
    }) }) });
    ws.workloads = { list: vi.fn(), create: vi.fn(), stop: vi.fn(), start: vi.fn() };
    await expect(runtime.connection.ensureDocker()).rejects.toMatchObject({
      code: "CLOUD_RUNTIME_PROXY_UNAVAILABLE", statusCode: 502,
      message: expect.stringContaining("HTTP 404"),
    });
    expect(runtime.executor.writeFile).not.toHaveBeenCalled();
    expect(ws.workloads.list).not.toHaveBeenCalled();
    expect(ws.restart).not.toHaveBeenCalled();
    expect(ws.delete).not.toHaveBeenCalled();
    ws.runtime.mockResolvedValue({ proxy: () => ({ fetch: async () => new Response(CLOUD_DOCKER_BRIDGE_VERSION) }) });
    await expect(runtime.connection.ensureDocker()).resolves.toBeUndefined();
    expect(runtime.executor.writeFile).not.toHaveBeenCalled();
  });
  it("reports the failed health check instead of the provider's successful log-fetch envelope", async () => {
    vi.useFakeTimers();
    ws.runtime.mockResolvedValue({ proxy: () => ({ fetch: async () => new Response("bad gateway", { status: 502 }) }) });
    ws.workloads = {
      list: vi.fn(async () => [{ id: "bridge-a", name: "openship-docker-api-v1", state: "running" }]),
      stop: vi.fn(), start: vi.fn(),
      logs: vi.fn(async () => ({ logs: "", success: true, _serverId: "node2" })),
    };
    try {
      const result = runtime.connection.ensureDocker().catch(error => error as Error);
      await vi.advanceTimersByTimeAsync(61_000);
      const error = await result;
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain("HTTP 502");
      expect((error as Error).message).toContain("Bridge state: running");
      expect((error as Error).message).not.toContain('"success"');
      expect((error as Error).message).not.toContain("_serverId");
    } finally { vi.useRealTimers(); }
  });
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
      const outcome = runtime.connection.ensureDocker().then(() => "ready", error => error);
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
  it.each([401, 403, 405, 501])("reports proxy HTTP %s before changing the workspace", async status => {
    const fetch = vi.fn(async () => new Response("private-provider-response", {
      status, headers: { "x-request-id": "provider-request-123" },
    }));
    ws.runtime.mockResolvedValue({ proxy: () => ({ fetch }) });
    const error = await runtime.connection.ensureDocker().catch(error => error);
    expect(error).toMatchObject([401, 403].includes(status)
      ? { statusCode: 503, code: "CLOUD_DOCKER_PROXY_UNAVAILABLE" }
      : { statusCode: 502, code: "CLOUD_RUNTIME_PROXY_UNAVAILABLE" });
    expect(error.message).toContain(`HTTP ${status}`);
    expect(error.message).toContain("provider-request-123");
    expect(error.message).toContain("workspace-a");
    expect(error.message).not.toContain("private-provider-response");
    expect(fetch).toHaveBeenCalledTimes(status === 401 ? 2 : 1);
    if (status === 401) expect(ws.runtime).toHaveBeenCalledWith({ force: true });
    else expect(ws.runtime).not.toHaveBeenCalledWith({ force: true });
    expect(runtime.executor.exec).not.toHaveBeenCalled();
    expect(runtime.executor.writeFile).not.toHaveBeenCalled();
    expect(ws.restart).not.toHaveBeenCalled();
    expect(ws.delete).not.toHaveBeenCalled();
    // Failure is not cached; a provider repair allows the same VM to recover.
    ws.runtime.mockResolvedValue({ proxy: () => ({ fetch: async () => new Response(CLOUD_DOCKER_BRIDGE_VERSION) }) });
    await expect(runtime.connection.ensureDocker()).resolves.toBeUndefined();
  });
  it("refreshes a stale runtime credential once after a cold workspace restart", async () => {
    const stale = vi.fn(async () => new Response("unauthorized", { status: 401 }));
    const fresh = vi.fn(async () => new Response(CLOUD_DOCKER_BRIDGE_VERSION));
    ws.runtime.mockImplementation(async (options?: { force?: boolean }) => ({ proxy: () => ({ fetch: options?.force ? fresh : stale }) }));
    await expect(runtime.connection.ensureDocker()).resolves.toBeUndefined();
    expect(stale).toHaveBeenCalledOnce();
    expect(fresh).toHaveBeenCalledOnce();
    expect(ws.runtime).toHaveBeenCalledTimes(2);
    expect(ws.runtime).toHaveBeenLastCalledWith({ force: true });
    expect(runtime.executor.exec).not.toHaveBeenCalled();
    expect(ws.restart).not.toHaveBeenCalled();
    expect(ws.delete).not.toHaveBeenCalled();
  });
  it("keeps a namespace credential rejection closed during runtime refresh", async () => {
    const fetch = vi.fn(async () => new Response("unauthorized", { status: 401 }));
    ws.runtime.mockImplementation(async (options?: { force?: boolean }) => {
      if (options?.force) throw Object.assign(new Error("private credential rejected"), { status: 403 });
      return { proxy: () => ({ fetch }) };
    });
    const error = await runtime.connection.ensureDocker().catch(error => error);
    expect(error).toMatchObject({ statusCode: 503, code: "CLOUD_DOCKER_PROXY_UNAVAILABLE" });
    expect(error.message).toContain("Runtime credential refresh failed");
    expect(error.message).not.toContain("private credential");
    expect(fetch).toHaveBeenCalledOnce();
    expect(ws.runtime).toHaveBeenCalledTimes(2);
    expect(runtime.executor.exec).not.toHaveBeenCalled();
    expect(ws.restart).not.toHaveBeenCalled();
  });
  it("revalidates a cached bridge after a failed handshake without replaying a Docker request", async () => {
    await runtime.connection.ensureDocker();
    let refreshed = false;
    const socket = {} as WebSocket;
    ws.runtime.mockImplementation(async (options?: { force?: boolean }) => {
      if (options?.force) refreshed = true;
      return { proxy: () => ({
        ws: () => socket,
        fetch: async () => refreshed ? new Response(CLOUD_DOCKER_BRIDGE_VERSION) : new Response("unauthorized", { status: 401 }),
      }) };
    });
    const upstream = new PassThrough();
    const open = vi.spyOn(dockerTransport, "dockerWebSocketStream")
      .mockRejectedValueOnce(new Error("Cloud Docker connection failed"))
      .mockResolvedValueOnce(upstream);
    try {
      await expect(runtime.connection.connectDocker()).resolves.toBe(upstream);
      expect(open).toHaveBeenCalledTimes(2);
      expect(ws.runtime).toHaveBeenCalledWith({ force: true });
      expect(runtime.executor.exec).not.toHaveBeenCalled();
      expect(ws.restart).not.toHaveBeenCalled();
      expect(ws.delete).not.toHaveBeenCalled();
    } finally { upstream.destroy(); }
  });
  it("bounds failed WebSocket handshakes to two attempts", async () => {
    ws.runtime.mockResolvedValue({ proxy: () => ({
      fetch: async () => new Response(CLOUD_DOCKER_BRIDGE_VERSION), ws: () => ({} as WebSocket),
    }) });
    const open = vi.spyOn(dockerTransport, "dockerWebSocketStream").mockRejectedValue(new Error("Cloud Docker connection failed"));
    await expect(runtime.connection.connectDocker()).rejects.toThrow("Cloud Docker connection failed");
    expect(open).toHaveBeenCalledTimes(2);
    expect(runtime.executor.exec).not.toHaveBeenCalled();
    expect(ws.restart).not.toHaveBeenCalled();
  });
  it.each(["upstream", "network", "timeout"])("reports a %s failure without treating log retrieval as readiness", async failure => {
    vi.useFakeTimers();
    ws.runtime.mockResolvedValue({ proxy: () => ({ fetch: async () => {
      if (failure === "upstream") return new Response("private-provider-response", { status: 502 });
      throw Object.assign(new Error("https://workspace.example/?token=private-token"), {
        name: failure === "timeout" ? "TimeoutError" : "TypeError",
      });
    } }) });
    ws.workloads = {
      list: vi.fn(async () => [{ id: "bridge-a", name: "openship-docker-api-v1", state: "running" }]),
      stop: vi.fn(), start: vi.fn(), logs: vi.fn(async () => ({ logs: "", success: true, _serverId: "node2" })),
    };
    try {
      const outcome = runtime.connection.ensureDocker().catch(error => error);
      await vi.advanceTimersByTimeAsync(61_000);
      const error = await outcome;
      expect(error).toMatchObject({ statusCode: 503, code: "CLOUD_DOCKER_BRIDGE_NOT_READY" });
      expect(error.message).toContain(failure === "upstream" ? "HTTP 502" : failure === "timeout" ? "timed out" : "network request failed");
      expect(error.message).toContain("Bridge state: running; workspace workspace-a");
      expect(error.message).not.toMatch(/private-|success|_serverId/);
      expect(ws.workloads.logs).not.toHaveBeenCalled();
      expect(ws.restart).not.toHaveBeenCalled();
      expect(ws.delete).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });
  it("bounds an unexpected health body and waits for the managed bridge to start", async () => {
    const cancel = vi.fn();
    let running = false;
    ws.runtime.mockResolvedValue({ proxy: () => ({ fetch: async () => running
      ? new Response(CLOUD_DOCKER_BRIDGE_VERSION)
      : new Response(new ReadableStream({
        start(controller) { controller.enqueue(new Uint8Array(1024)); }, cancel,
      })),
    }) });
    ws.workloads = {
      list: vi.fn(async () => []),
      create: vi.fn(async () => { running = true; }),
    };
    await expect(runtime.connection.ensureDocker()).resolves.toBeUndefined();
    expect(cancel).toHaveBeenCalledOnce();
    expect(ws.workloads.create).toHaveBeenCalledOnce();
    expect(ws.restart).not.toHaveBeenCalled();
  });
  it("allocates distinct edge ports for services sharing a container port, and reuses them on redeploy", async () => {
    const first = await runtime.deployServiceWorkload(group, { ...config, cloudEndpoints: [...config.cloudEndpoints!, { hostname: "console.opsh.io", port: 9090, custom: false }] });
    const peer = await runtime.deployServiceWorkload(group, { ...config, serviceName: "peer", cloudEndpoints: [{ hostname: "peer.opsh.io", port: 8080, custom: false }] });
    const next = await runtime.deployServiceWorkload(group, { ...config, deploymentId: "d2" });
    expect(first.hostPortByContainerPort![8080]).not.toBe(peer.hostPortByContainerPort![8080]);
    expect(first.hostPortByContainerPort![8080]).not.toBe(first.hostPortByContainerPort![9090]);
    expect(next.hostPortByContainerPort![8080]).toBe(first.hostPortByContainerPort![8080]);
    await infra.publishRoute("project-a.opsh.io", next.hostPortByContainerPort![8080]!, false);
    expect(routes).toHaveBeenCalledWith("project-a.opsh.io", expect.objectContaining({ routes: [expect.objectContaining({ action: { kind: "proxy", workspace: "workspace-a", port: next.hostPortByContainerPort![8080] } })] }));
    expect(provider.workspaces.create).not.toHaveBeenCalled();
  });
  it("keeps named and image-declared volume identities across container replacements", async () => {
    await runtime.deployServiceWorkload(group, config);
    await runtime.deployServiceWorkload(group, { ...config, deploymentId: "d2", image: "test:2" });
    expect(captures[0]!.volumes).toContain("openship-project-a-data:/data");
    expect(captures[0]!.volumes.some(volume => volume.endsWith(":/image-data"))).toBe(true);
    expect(captures[1]!.volumes).toEqual(captures[0]!.volumes);
    expect(ws.delete).not.toHaveBeenCalled();
  });
  it("reserves a stopped sibling's ports and restores them when that service is redeployed", async () => {
    const first = await runtime.deployServiceWorkload(group, config);
    const reservedPort = first.hostPortByContainerPort![8080];
    const stopped = rows[0]!;
    stopped.Labels["openship.service"] = "reserved";
    stopped.Names = ["/openship-project-a-reserved"];
    stopped.State = "exited";
    stopped.Ports = [];
    stoppedPorts.set(stopped.Id, { "8080/tcp": [{ HostIp: "0.0.0.0", HostPort: String(reservedPort) }] });

    const added = await runtime.deployServiceWorkload(group, config);
    expect(added.hostPortByContainerPort![8080]).not.toBe(reservedPort);
    const restored = await runtime.deployServiceWorkload(group, { ...config, serviceName: "reserved" });
    expect(restored.hostPortByContainerPort![8080]).toBe(reservedPort);
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
    await expect(infra.publishRoute("project-a.opsh.io", result.hostPortByContainerPort![8080]!, false)).rejects.toThrow("edge unavailable");
    expect(ws.delete).not.toHaveBeenCalled();
  });
  it("does not take over another project's hostname in the same organization", async () => {
    pageRows.set("project-a", { namespace: "namespace-a", source_workspace_id: "workspace-other", exported_path: "/app" });
    const result = await runtime.deployServiceWorkload(group, config);
    await expect(infra.publishRoute("project-a.opsh.io", result.hostPortByContainerPort![8080]!, false)).rejects.toThrow(/owned|belong/);
    expect(pages.enable).not.toHaveBeenCalled();
    expect(routes).not.toHaveBeenCalled();
  });
  it("creates separate route owners for custom domains without rebinding the shared workspace", async () => {
    rows = [{ Id: "container-a", State: "running", Labels: { "openship.project": "project-a" },
      Ports: [30001, 30002].map(port => ({ PrivatePort: 8080, PublicPort: port, Type: "tcp" })) }];
    await infra.publishRoute("one.example.com", 30001, true);
    await infra.publishRoute("two.example.com", 30002, true);
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
  it("distinguishes a stopped workspace from an unavailable inventory without starting either", async () => {
    status = "stopped";
    await expect(runtime.listAllContainers()).rejects.toMatchObject({ code: "CLOUD_WORKSPACE_STOPPED" });
    expect(ws.start).not.toHaveBeenCalled();
    const failure = Object.assign(new Error("Provider unavailable"), { status: 503 });
    ws.get.mockRejectedValue(failure);
    await expect(runtime.listAllContainers()).rejects.toBe(failure);
    expect(provider.workspaces.create).not.toHaveBeenCalled();
  });
  it("refuses another namespace's container inventory", async () => {
    ws.get.mockResolvedValue({ namespace: "another-namespace", status: "running" });
    await expect(runtime.listAllContainers()).rejects.toThrow();
  });
  it("retention and deletion operate on containers, never on their shared VM", async () => {
    const stop = vi.spyOn(DockerRuntime.prototype, "stop").mockResolvedValue();
    const destroy = vi.spyOn(DockerRuntime.prototype, "destroy").mockResolvedValue();
    const image = vi.spyOn(DockerRuntime.prototype, "removeImage").mockResolvedValue();
    await runtime.archive({ containerId: "old-container", imageRef: "openship/project-a:bld_old" } as never);
    await runtime.purge({ containerId: "old-container", imageRef: "openship/project-a:bld_old" } as never);
    expect(stop).toHaveBeenCalledWith("old-container");
    expect(destroy).toHaveBeenCalledWith("old-container");
    expect(image).not.toHaveBeenCalled(); // Retention owns image GC separately from unit cleanup.
    await expect(runtime.destroy("workspace-a")).rejects.toThrow("cannot delete their Docker workspace");
    expect(ws.stop).not.toHaveBeenCalled();
    expect(ws.delete).not.toHaveBeenCalled();
    expect(runtime.supports("unitRestore")).toBe(false);
    expect(resolveExecutor(runtime.name, runtime)).toBeInstanceOf(DockerBackupExecutor);
  });
  it.each(["api-container", "a".repeat(12), "a".repeat(64)])("deletes only the owned container when referenced by %s", async (reference) => {
    runtime["options"].ownerWorkspaceId = "managed-a";
    const id = "a".repeat(64);
    const siblingId = "b".repeat(64);
    rows = [
      { Id: id, State: "running", Labels: { "openship.project": "project-a" }, Ports: [{ PrivatePort: 8080, PublicPort: 31001, Type: "tcp" }] },
      { Id: siblingId, State: "running", Labels: { "openship.project": "project-b" }, Ports: [{ PrivatePort: 8080, PublicPort: 31002, Type: "tcp" }] },
    ];
    vi.spyOn(runtime, "docker", "get").mockReturnValue({
      listContainers: async () => rows,
      getContainer: (input: string) => ({ inspect: async () => ({
        Id: input === siblingId ? siblingId : id,
        Config: { Labels: { "openship.project": input === siblingId ? "project-b" : "project-a" } },
      }) }),
    } as never);
    ws.network.get.mockResolvedValue({ ingress_ports: [31001, 31002, 443] });
    const destroy = vi.spyOn(DockerRuntime.prototype, "destroy").mockResolvedValue();
    await runtime.destroy(reference);
    expect(ws.network.update).not.toHaveBeenCalled(); // Ingress teardown belongs to the shared routing operation.
    expect(destroy).toHaveBeenCalledWith(id);
    expect(ws.delete).not.toHaveBeenCalled();
    await expect(runtime.destroy(siblingId)).rejects.toMatchObject({ code: "CONTAINER_NOT_FOUND" });
    expect(destroy).toHaveBeenCalledOnce();
    expect(ws.network.update).not.toHaveBeenCalled();
  });
  it("route teardown deletes only this workspace's routing anchor", async () => {
    rows = [{ Id: "container-a", State: "running", Labels: { "openship.project": "project-a" },
      Ports: [{ PrivatePort: 8080, PublicPort: 30001, Type: "tcp" }] }];
    await infra.publishRoute("project-a.opsh.io", 30001, false);
    const cleanup = new CloudInfraProvider(provider as unknown as Oblien, { namespace: "namespace-a", scope: runtime.routingScope(),
      adminProxy: { pages: pages as never, domainRoutes: async () => ({ data: [{ hostname: "project-a.opsh.io", namespace: "namespace-a", owner_type: "page", owner_id: "project-a" }] }) as never } });
    await cleanup.removeRoute("project-a.opsh.io");
    expect(pages.delete).toHaveBeenCalledWith("project-a");
    pageRows.get("project-a")!.source_workspace_id = "workspace-other";
    await expect(cleanup.removeRoute("project-a.opsh.io")).rejects.toThrow("not owned");
  });
  it("inventories disabled routing Pages without confusing their numeric IDs with slugs", async () => {
    rows = [{ Id: "container-a", State: "running", Labels: { "openship.project": "project-a" },
      Ports: [{ PrivatePort: 8080, PublicPort: 30001, Type: "tcp" }] }];
    await infra.publishRoute("project-a.opsh.io", 30001, false);
    pageRows.get("project-a")!.status = "disabled";
    pageRows.set("other", { slug: "other", domain: "opsh.io", namespace: "namespace-a", source_workspace_id: "workspace-other", exported_path: "/opt/openship/cloud-docker/routes/other" });
    expect(await infra.listProjectRouteHostnames()).toEqual(["project-a.opsh.io"]);
    const cleanup = new CloudInfraProvider(provider as unknown as Oblien, { namespace: "namespace-a", scope: runtime.routingScope() });
    await cleanup.removeRoute("project-a.opsh.io");
    expect(pages.delete).toHaveBeenCalledWith("project-a");
  });
  it("does not read a control-plane path supplied as cloud build source", async () => {
    await expect(runtime.prepareComposeSource({ projectId: "project-a", localPath: "/etc" } as never)).rejects.toThrow("control-plane");
    expect(runtime.executor.writeFile).not.toHaveBeenCalled();
  });
  it("stages inline source remotely and invokes the shared Docker builder with the cloud executor", async () => {
    const sharedBuild = vi.spyOn(DockerRuntime.prototype, "buildImages").mockResolvedValue([]);
    const transfer = vi.spyOn(runtime.executor, "transferIn").mockRejectedValue(new Error("must not read API-host files"));
    const logger = new BuildLogger();
    const source = { projectId: "project-a", sessionId: "build-a", repoUrl: "https://github.com/acme/private",
      rootDirectory: "", inlineSourceFiles: [
        { path: "web/Dockerfile", content: "FROM alpine\nCOPY web/config /config" },
        { path: "web/config", content: "configured" },
      ] } as never;
    await runtime.buildImages([{ serviceName: "web", config: source, logger }], logger);
    expect(runtime.executor.writeFile).toHaveBeenCalledWith(expect.stringMatching(/^\/tmp\/openship-cloud-source-[a-f0-9]+\/web\/config$/), "configured");
    expect(transfer).not.toHaveBeenCalled();
    expect(sharedBuild).toHaveBeenCalledExactlyOnceWith([
      expect.objectContaining({ serviceName: "web", config: expect.objectContaining({
        cloneOnServer: true, localPath: undefined, staticExtractOnly: false,
      }) }),
    ], logger);
    expect(runtime.connectionOptions?.executor).toBe(runtime.executor);
    expect(runtime.transport.kind).toBe("cloud");
  });
  it("does not let an empty image-only source mask a later inline build context", async () => {
    const source = { projectId: "project-a", sessionId: "build-a", repoUrl: "" };
    await runtime.prepareComposeSource(source as never);
    expect(runtime.executor.exec).not.toHaveBeenCalled();
    await runtime.prepareComposeSource({ ...source, inlineSourceFiles: [{ path: "web/Dockerfile", content: "FROM alpine" }] } as never);
    expect(runtime.executor.writeFile).toHaveBeenCalledWith(expect.stringMatching(/\/web\/Dockerfile$/), "FROM alpine");
  });
  it.each(["../escape", "/etc/passwd", "..\\escape"])("rejects inline path %s before writing any files", async path => {
    await expect(runtime.prepareComposeSource({ projectId: "project-a", sessionId: "build-a", inlineSourceFiles: [
      { path: "web/Dockerfile", content: "FROM alpine" }, { path, content: "invalid" },
    ] } as never)).rejects.toThrow("escapes");
    expect(runtime.executor.writeFile).not.toHaveBeenCalled();
    expect(runtime.executor.exec).toHaveBeenCalledTimes(2); // Allocate and remove only the isolated staging directory.
  });
});
