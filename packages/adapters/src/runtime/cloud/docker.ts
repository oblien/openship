import { createHash } from "node:crypto";
import { posix } from "node:path";
import type { Oblien, Runtime, RoutesInput } from "oblien";
import { SYSTEM } from "@repo/core";
import { DockerRuntime } from "../docker";
import { CloudRuntime, type CloudAdminProxy } from "../cloud";
import { BuildLogger, sq } from "../build-pipeline";
import type { BuildConfig, ContainerInfo, LogCallback, ProvisionLock } from "../../types";
import type { DockerRegistryAuth } from "../docker-auth";
import type { MultiServiceDeployConfig, MultiServiceDeployResult, MultiServiceGroupHandle } from "../types";
import { CloudWorkspaceExecutor } from "./workspace-executor";
import { cloudPageHostnames } from "./page-hostnames";
import { dockerWebSocketStream } from "./docker-transport";
import { CLOUD_DOCKER_BRIDGE_PORT, CLOUD_DOCKER_BRIDGE_SOURCE, CLOUD_DOCKER_BRIDGE_VERSION } from "./docker-bridge-source";
import { assertDockerWorkspaceOwner, cloudWorkspaceStatus, isDockerWorkspaceRunning, waitForCloudDockerWorkspace } from "./workspace-ready";
import { resolveEnvironment } from "../../system/environment";
import { envOps, opScript } from "../../system/environment-ops";

export const CLOUD_DOCKER_IMAGE = "oblien/docker:29";
export const CLOUD_DOCKER_ROUTE_ROOT = "/opt/openship/cloud-docker/routes";
// Keep these installation identities stable when the bridge version changes,
// so an upgrade replaces its process instead of creating a second port owner.
const BRIDGE_SCRIPT = "/opt/openship/cloud-docker/bridge-v1.py";
const BRIDGE_WORKLOAD = "openship-docker-api-v1";

export interface CloudDockerOptions {
  workspaceId: string;
  projectId: string;
  namespace: string;
  /** Provider-authorized domain; production uses Openship's configured domain. */
  publicDomain?: string;
  adminProxy?: CloudAdminProxy;
  beforeProvision?: () => Promise<void>;
  /** Explicit opt-in for a desktop/self-hosted source transfer; SaaS denies it. */
  allowHostSource?: boolean;
  provisionLock: ProvisionLock;
  bridgeLock?: ProvisionLock;
  resolveRegistryAuth: (ref: string) => Promise<DockerRegistryAuth | undefined>;
}

function notFound(error: unknown): boolean {
  const e = error as { status?: number; statusCode?: number };
  return e?.status === 404 || e?.statusCode === 404;
}

/** Docker semantics on a single permanent Oblien workspace. Resource identity
 * stays explicit: container IDs identify containers; workspaceId identifies the
 * shared host. Inherited retention/rollback never stop or delete that host. */
export class CloudDockerRuntime extends DockerRuntime {
  override readonly name = "cloud";
  readonly workspaceId: string;
  readonly projectId: string;
  readonly executor: CloudWorkspaceExecutor;
  private readonly cloud: CloudRuntime;
  private bridgePromise?: Promise<void>;
  private sourcePath?: string;
  private sourceBase?: string;
  private sourcePromise?: Promise<void>;

  private constructor(private readonly client: Oblien, private readonly options: CloudDockerOptions) {
    let getRuntime!: () => Promise<Runtime>;
    let connect!: () => ReturnType<typeof dockerWebSocketStream>;
    const executor = new CloudWorkspaceExecutor(() => getRuntime());
    super({ transport: "cloud", executor, cloudConnection: () => connect(), resolveRegistryAuth: options.resolveRegistryAuth }, null, options.provisionLock);
    this.workspaceId = options.workspaceId;
    this.projectId = options.projectId;
    this.executor = executor;
    this.cloud = new CloudRuntime(client, { namespace: options.namespace, adminProxy: options.adminProxy, beforeProvision: options.beforeProvision });
    getRuntime = () => this.workspaceRuntime();
    connect = async () => {
      await this.ensureBridge();
      try { return await dockerWebSocketStream((await this.workspaceRuntime()).proxy(CLOUD_DOCKER_BRIDGE_PORT).ws("/docker")); }
      catch (error) { this.bridgePromise = undefined; throw error; }
    };
  }

  static async forWorkspace(client: Oblien, options: CloudDockerOptions): Promise<CloudDockerRuntime> {
    if (!options.namespace || !options.workspaceId || !options.projectId) throw new Error("Cloud Docker requires a project-owned workspace");
    const runtime = new CloudDockerRuntime(client, options);
    try { await runtime.initializeDocker(); return runtime; }
    catch (error) { await runtime.dispose(); throw error; }
  }

  private workspaceRuntime(): Promise<Runtime> {
    // The SDK refreshes its cached runtime token; don't cache it forever here.
    return this.client.workspace(this.workspaceId).runtime();
  }

  private ensureBridge(): Promise<void> {
    const initialize = async () => {
      const info = await this.client.workspaces.get(this.workspaceId);
      assertDockerWorkspaceOwner(info, this.options.namespace);
      if (!isDockerWorkspaceRunning(info)) throw new Error("The project's Docker workspace is stopped. Start a service or deploy to resume it.");
      const runtime = await this.workspaceRuntime();
      const ready = async () => {
        try {
          const response = await runtime.proxy(CLOUD_DOCKER_BRIDGE_PORT).fetch("/health", { signal: AbortSignal.timeout(5000), redirect: "error" });
          return response.ok && await response.text() === CLOUD_DOCKER_BRIDGE_VERSION;
        } catch { return false; }
      };
      if (await ready()) return;
      await this.executor.exec("docker info --format '{{.ServerVersion}}'", { timeout: 60_000 });
      const hasPython = await this.executor.exec("command -v python3").then(() => true, () => false);
      if (!hasPython) {
        const install = envOps(await resolveEnvironment(this.executor)).pkgInstall(["python3"], { installRecommends: false });
        if (!install.supported) throw new Error(install.reason);
        await this.executor.exec(opScript(install.value), { timeout: 300_000 });
      }
      await this.executor.writeFile(BRIDGE_SCRIPT, CLOUD_DOCKER_BRIDGE_SOURCE, { mode: 0o700 });
      const workspace = this.client.workspace(this.workspaceId);
      const workload = (await workspace.workloads.list({ name: BRIDGE_WORKLOAD }))
        .find(item => item.name === BRIDGE_WORKLOAD);
      if (workload) {
        const state = String(workload.state ?? workload.status ?? "");
        if (["stopped", "failed", "exited"].includes(state)) {
          await workspace.workloads.start(workload.id);
        } else if (!(await ready())) {
          // Replacing the script does not update an already-running Python
          // process. Restart only the bridge, keeping Docker services running.
          await workspace.workloads.stop(workload.id);
          await workspace.workloads.start(workload.id);
        }
      } else {
          await workspace.workloads.create({ name: BRIDGE_WORKLOAD,
            cmd: ["python3", BRIDGE_SCRIPT], restart_policy: "always", max_restarts: 0,
            labels: { "openship.project": this.projectId, "openship.role": "docker-api" } });
      }
      const deadline = Date.now() + 60_000;
      while (Date.now() < deadline) {
        if (await ready()) return;
        await new Promise(resolve => setTimeout(resolve, 500));
      }
      const failed = (await workspace.workloads.list({ name: BRIDGE_WORKLOAD })).find(item => item.name === BRIDGE_WORKLOAD);
      const diagnosis = failed ? await workspace.workloads.logs(failed.id).catch(() => null) : null;
      throw new Error(`The workspace Docker connection did not become ready${diagnosis ? `: ${JSON.stringify(diagnosis).slice(-1500)}` : ""}`);
    };
    return this.bridgePromise ??= (this.options.bridgeLock ? this.options.bridgeLock.run(initialize) : initialize())
      .catch(error => { this.bridgePromise = undefined; throw error; });
  }

  private assertProject(projectId: string): void {
    if (projectId !== this.projectId) throw new Error("Docker workspace belongs to a different project");
  }

  private async canSpend(): Promise<void> { await this.options.beforeProvision?.(); }
  private get publicDomain(): string { return this.options.publicDomain ?? SYSTEM.DOMAINS.CLOUD_DOMAIN; }

  /** Acquire source once, on the workspace. Also serves image-only Compose
   * stacks whose relative bind mounts need repository files. */
  async prepareComposeSource(config: BuildConfig, logger = new BuildLogger()): Promise<void> {
    this.assertProject(config.projectId);
    if (config.localPath && !this.options.allowHostSource) throw new Error("Cloud builds cannot read source paths on the control-plane host");
    return this.sourcePromise ??= (async () => {
      await this.canSpend();
      const source = `/tmp/openship-cloud-source-${createHash("sha256").update(config.sessionId).digest("hex").slice(0, 24)}`;
      await this.executor.mkdir(source);
      try {
        if (config.sourceStaged && config.cloudWorkspaceId) {
          const upload = await this.client.workspaces.get(config.cloudWorkspaceId);
          assertDockerWorkspaceOwner(upload, this.options.namespace);
          const from = await this.client.workspace(upload.id).runtime();
          const archive = await from.transfer.download({ paths: ["/app/."] });
          if (!archive.ok || !archive.body) throw new Error("Uploaded project source is unavailable");
          const transferred = await (await this.workspaceRuntime()).transfer.upload({ dest: source, body: archive.body });
          if (!transferred.success) throw new Error("Could not transfer uploaded source to the Docker workspace");
        } else if (config.localPath) {
          await this.executor.transferIn(config.localPath, source, logger.callback);
        } else if (config.repoUrl) {
          await super.cloneSourceOnRemote(config, source, logger);
        }
        const base = posix.resolve(source, config.rootDirectory || ".");
        if (base !== source && !base.startsWith(`${source}/`)) throw new Error("Compose source directory escapes the repository");
        this.sourcePath = source;
        this.sourceBase = base;
      } catch (error) {
        await this.executor.rm(source).catch(() => {});
        throw error;
      }
    })();
  }

  protected override async cloneSourceOnRemote(config: BuildConfig, directory: string, logger: BuildLogger): Promise<void> {
    await this.prepareComposeSource(config, logger);
    await this.executor.exec(`mkdir -p ${sq(directory)} && cp -a ${sq(this.sourcePath!)}/. ${sq(directory)}/`);
  }

  override async build(config: BuildConfig, logger?: BuildLogger) {
    this.assertProject(config.projectId);
    await this.canSpend();
    await this.prepareComposeSource(config, logger);
    return super.build(this.remoteBuild(config), logger);
  }
  override async buildImages(specs: Parameters<DockerRuntime["buildImages"]>[0], logger: BuildLogger) {
    for (const spec of specs) this.assertProject(spec.config.projectId);
    await this.canSpend();
    if (specs.length) await this.prepareComposeSource(specs[0]!.config, logger);
    return super.buildImages(specs.map(spec => ({ ...spec, config: this.remoteBuild(spec.config) })), logger);
  }
  private remoteBuild(config: BuildConfig): BuildConfig {
    // Repository commands must not run on the SaaS control plane. Inline/folder
    // sources are transferred; Git sources clone directly inside the workspace.
    return { ...config, cloneOnServer: true, localPath: undefined, staticExtractOnly: false };
  }

  override async ensureServiceGroup(config: Parameters<DockerRuntime["ensureServiceGroup"]>[0]) {
    this.assertProject(config.projectId);
    await this.canSpend();
    await this.ensureBridge();
    return super.ensureServiceGroup(config);
  }

  override async deployServiceWorkload(group: MultiServiceGroupHandle, config: MultiServiceDeployConfig, onLog?: LogCallback): Promise<MultiServiceDeployResult> {
    this.assertProject(config.projectId);
    await this.canSpend();
    await this.ensureBridge();
    const endpoints = config.cloudEndpoints ?? (config.expose && config.publicPort
      ? [{ hostname: config.customDomain ?? `${config.publicSlug}.${this.publicDomain}`, port: config.publicPort, custom: Boolean(config.customDomain) }]
      : []);
    // Port allocation and replacement share a workspace lock. This is separate
    // from bridge initialization, which must complete before entering the lock.
    return this.options.provisionLock.run(async () => {
      const ports = [...new Set([...endpoints.map(endpoint => endpoint.port), ...(config.cloudProxyPorts ?? [])])];
      if (ports.some(port => !Number.isInteger(port) || port < 1 || port > 65535)) throw new Error("Invalid cloud service port");
      const running = await this.docker.listContainers({ all: true });
      const used = new Set(running.flatMap(container => container.Ports.map(port => port.PublicPort).filter((port): port is number => Boolean(port))));
      const listeners = await this.executor.exec("ss -H -lnt");
      for (const line of listeners.split("\n")) {
        const port = Number(line.trim().split(/\s+/)[3]?.split(":").pop());
        if (port) used.add(port);
      }
      const previous = running.find(container => container.Labels["openship.project"] === this.projectId && container.Labels["openship.service"] === config.serviceName);
      const published = new Map<number, number>();
      for (const port of ports) {
        const prior = previous?.Ports.find(binding => binding.PrivatePort === port && binding.Type === "tcp")?.PublicPort;
        let hostPort = prior ?? 30000 + createHash("sha256").update(`${this.projectId}:${config.serviceName}:${port}`).digest().readUInt32BE(0) % 30000;
        if (!prior) {
          const start = hostPort;
          while (used.has(hostPort) || hostPort === CLOUD_DOCKER_BRIDGE_PORT) {
            hostPort = hostPort === 59999 ? 30000 : hostPort + 1;
            if (hostPort === start) throw new Error("No published ports available in this Docker workspace");
          }
        }
        used.add(hostPort);
        published.set(port, hostPort);
      }
      // Internal database/worker ports remain on the project network. Only
      // approved public endpoints are published, with distinct workspace ports.
      if (!config.imageAlreadyPrepared) await this.pullImage(config.image, { force: config.forcePull });
      const image = await this.docker.getImage(config.image).inspect();
      const volumes = await this.persistentMounts(config, Object.keys(image.Config?.Volumes ?? {}));
      const result = await super.deployServiceWorkload(group, { ...config, volumes, imageAlreadyPrepared: true,
        ports: [...published].map(([port, hostPort]) => `0.0.0.0:${hostPort}:${port}`),
      }, onLog);
      if (ports.length) {
        try {
          const workspace = this.client.workspace(this.workspaceId);
          const current = await workspace.network.get();
          const ingress = Array.isArray(current.ingress_ports) ? current.ingress_ports as number[] : [];
          await workspace.network.update({ ingress_ports: [...new Set([...ingress, ...published.values()])] });
          for (const endpoint of endpoints) {
            try { await this.publishRoute(endpoint.hostname, published.get(endpoint.port)!, endpoint.custom); }
            catch { (result.routeWarnings ??= []).push(`${endpoint.hostname}: cloud routing failed; retry from Domains`); }
          }
        } catch {
          (result.routeWarnings ??= []).push(`Service ${config.serviceName}: cloud ingress could not be applied; retry routing`);
        }
      }
      return result;
    });
  }

  private async persistentMounts(config: MultiServiceDeployConfig, imageVolumes: string[]): Promise<string[]> {
    const targets = new Set<string>();
    const volumes: string[] = [];
    for (const spec of config.volumes) {
      const parts = spec.split(":");
      if (parts.length === 1) {
        imageVolumes.push(parts[0]!);
        continue;
      }
      const [source, target] = parts as [string, string];
      targets.add(target);
      if (source.startsWith(".") || source.startsWith("~")) {
        if (!this.sourcePath || !this.sourceBase || source.startsWith("~")) throw new Error("A relative Compose mount needs repository or uploaded source");
        const from = posix.resolve(this.sourceBase, source);
        if (from !== this.sourcePath && !from.startsWith(`${this.sourcePath}/`)) throw new Error("Compose mount escapes its source repository");
        const readOnly = parts.slice(2).some(mode => mode.split(",").includes("ro"));
        const key = createHash("sha256").update(posix.relative(this.sourcePath, from)).digest("hex").slice(0, 24);
        const release = createHash("sha256").update(config.deploymentId).digest("hex").slice(0, 24);
        const dest = `/opt/openship/cloud-docker/mounts/${readOnly ? `releases/${release}` : "data"}/${key}`;
        await this.executor.mkdir(posix.dirname(dest));
        // Writable relative mounts are initialized once, then retain application
        // data. Read-only configuration gets a release-specific copy.
        if (!await this.executor.exists(dest)) {
          if (await this.executor.exists(from)) await this.executor.exec(`cp -a ${sq(from)} ${sq(dest)}`);
          else if (!readOnly) await this.executor.mkdir(dest);
          else throw new Error(`Compose mount source is missing: ${source}`);
        }
        parts[0] = dest;
      }
      volumes.push(parts.join(":"));
    }
    for (const target of new Set(imageVolumes)) {
      if (!target.startsWith("/")) throw new Error("Invalid anonymous volume destination");
      if (targets.has(target)) continue;
      const key = createHash("sha256").update(`${config.serviceName}:${target}`).digest("hex").slice(0, 24);
      volumes.push(`openship-${config.slug}-data-${key}:${target}`);
    }
    return volumes;
  }

  private get pages() { return this.options.adminProxy?.pages ?? this.client.pages; }

  /** Read provider ownership without opening Docker or resuming a stopped VM.
   * Includes route anchors from a deployment that failed before its DB write. */
  async listProjectRouteHostnames(): Promise<string[]> {
    const hostnames: string[] = [];
    for (const summary of (await this.pages.list()).pages) {
      if (summary.namespace !== this.options.namespace) continue;
      let page;
      try { page = (await this.pages.get(summary.slug)).page; }
      catch (error) { if (notFound(error)) continue; throw error; }
      if (page.namespace === this.options.namespace && page.source_workspace_id === this.workspaceId &&
          page.exported_path === `${CLOUD_DOCKER_ROUTE_ROOT}/${page.slug}`) hostnames.push(...cloudPageHostnames(page));
    }
    return [...new Set(hostnames)];
  }

  /** A stable Page owns each public hostname; its edge rule proxies to the
   * shared workspace. This supports several custom domains without repeatedly
   * overwriting the workspace API's single custom-domain binding. */
  async publishRoute(hostname: string, hostPort: number, custom: boolean, input?: RoutesInput): Promise<void> {
    hostname = hostname.trim().toLowerCase();
    if (!Number.isInteger(hostPort) || hostPort < 1 || hostPort > 65535 || hostPort === CLOUD_DOCKER_BRIDGE_PORT) throw new Error("Invalid cloud routing port");
    const suffix = `.${this.publicDomain}`;
    const slug = custom ? `route-${createHash("sha256").update(`${this.projectId}:${hostname}`).digest("hex").slice(0, 32)}`
      : hostname.endsWith(suffix) ? hostname.slice(0, -suffix.length) : "";
    if (!slug || !/^[a-z0-9-]+$/.test(slug)) throw new Error("Invalid cloud route hostname");
    const workspace = this.client.workspace(this.workspaceId);
    const network = await workspace.network.get();
    const ingress = Array.isArray(network.ingress_ports) ? network.ingress_ports as number[] : [];
    await workspace.network.update({ ingress_ports: [...new Set([...ingress, hostPort])] });
    const path = `${CLOUD_DOCKER_ROUTE_ROOT}/${slug}`;
    let page;
    try { page = (await this.pages.get(slug)).page; }
    catch (error) { if (!notFound(error)) throw error; }
    if (!page) {
      await this.executor.writeFile(`${path}/index.html`, "<!doctype html><title>Application starting</title>");
      try { await this.pages.create({ workspace_id: this.workspaceId, path, name: `Route ${hostname}`, slug, domain: this.publicDomain }); }
      catch (error) { if ((error as { status?: number }).status !== 409) throw error; }
      // Creation returns a summary on current Oblien releases. Ownership comes
      // from the full resource read, including namespace and export path.
      page = (await this.pages.get(slug)).page;
    }
    if (page.source_workspace_id !== this.workspaceId || page.namespace !== this.options.namespace || page.exported_path !== path) {
      throw new Error("Cloud hostname is not owned by this project's route");
    }
    if (custom) {
      if (page.custom_domain && page.custom_domain !== hostname) throw new Error("Cloud route is already bound to a different hostname");
      if (page.custom_domain !== hostname) await this.pages.connectDomain(slug, { domain: hostname });
    }
    await this.pages.enable(slug);
    await this.cloud.setDomainRoutes(hostname, input ?? { routes: [{ match: { path: "/", type: "prefix" },
      action: { kind: "proxy", workspace: this.workspaceId, port: hostPort } }] });
  }

  async resolveRoutingTarget(containerId: string, port: number): Promise<{ workspace: string; port: number }> {
    const info = await this.getContainerInfo(containerId);
    const published = info.hostPortByContainerPort?.[port];
    if (!published) throw new Error(`Service port ${port} is not published in its workspace`);
    return { workspace: this.workspaceId, port: published };
  }
  async setDomainRoutes(hostname: string, input: RoutesInput) { return this.cloud.setDomainRoutes(hostname, input); }
  async checkSlug(...args: Parameters<CloudRuntime["checkSlug"]>) { return this.cloud.checkSlug(...args); }
  async verifyDomain(...args: Parameters<CloudRuntime["verifyDomain"]>) { return this.cloud.verifyDomain(...args); }
  async getQuota() { return this.cloud.getQuota(); }

  override async getContainerInfo(containerId: string): Promise<ContainerInfo> {
    if (containerId === this.workspaceId) throw new Error("A Docker workspace is not a service container");
    let workspace;
    try { workspace = await this.client.workspaces.get(this.workspaceId); }
    catch (error) { if (notFound(error)) return { containerId, status: "missing" }; throw error; }
    assertDockerWorkspaceOwner(workspace, this.options.namespace);
    if (!isDockerWorkspaceRunning(workspace)) {
      const status = cloudWorkspaceStatus(workspace);
      return { containerId, status: ["failed", "error"].includes(status) ? "failed"
        : ["starting", "creating", "provisioning", "resuming"].includes(status) ? "deploying" : "stopped" };
    }
    return super.getContainerInfo(containerId);
  }
  private async resumeWorkspace(): Promise<void> {
    await this.canSpend();
    const ws = this.client.workspace(this.workspaceId);
    const data = await ws.get();
    assertDockerWorkspaceOwner(data, this.options.namespace);
    if (isDockerWorkspaceRunning(data)) return;
    const status = cloudWorkspaceStatus(data);
    if (status === "stopped") await ws.start();
    else if (status === "paused" || status === "suspended") await ws.resume();
    await waitForCloudDockerWorkspace(this.client, this.workspaceId, this.options.namespace);
    ws.invalidateRuntime();
    this.bridgePromise = undefined;
  }
  override async start(containerId: string) {
    if (containerId === this.workspaceId) throw new Error("A Docker workspace is not a service container");
    await this.resumeWorkspace();
    try { return await super.start(containerId); }
    catch (error) { if ((error as { statusCode?: number }).statusCode !== 304) throw error; }
  }
  override async stop(containerId: string) {
    if (containerId === this.workspaceId) throw new Error("A Docker workspace is not a service container");
    const workspace = await this.client.workspaces.get(this.workspaceId);
    assertDockerWorkspaceOwner(workspace, this.options.namespace);
    if (!isDockerWorkspaceRunning(workspace)) return;
    return super.stop(containerId);
  }
  override async restart(containerId: string) {
    if (containerId === this.workspaceId) throw new Error("A Docker workspace is not a service container");
    await this.resumeWorkspace();
    return super.restart(containerId);
  }
  override async applyEnvironment(...args: Parameters<DockerRuntime["applyEnvironment"]>) {
    this.assertProject(args[2].projectId);
    if (args[0] === this.workspaceId) throw new Error("A Docker workspace is not a service container");
    await this.resumeWorkspace();
    await this.ensureBridge();
    return super.applyEnvironment(...args);
  }
  override async pullImage(...args: Parameters<DockerRuntime["pullImage"]>) { await this.canSpend(); return super.pullImage(...args); }
  override async destroy(containerId: string) {
    if (containerId === this.workspaceId) throw new Error("Use project teardown to delete a shared Docker workspace");
    return super.destroy(containerId);
  }
  override async dispose() {
    await super.dispose();
    if (this.sourcePath) await this.executor.rm(this.sourcePath).catch(() => {});
    await this.executor.dispose();
  }
}
