/**
 * Disposable, Docker-only infrastructure for the scaling acceptance suite.
 * No kubeconfig, Docker context, registered server or host firewall is changed.
 * The nodes run real K3s/containerd, including Flannel, CoreDNS and network policy.
 */
import { randomUUID } from "node:crypto";
import { request } from "node:http";
import { connect } from "node:net";
import { join } from "node:path";
import { statfs } from "node:fs/promises";
import { tmpdir } from "node:os";
import { PassThrough } from "node:stream";
import { parse, stringify } from "yaml";
import type Dockerode from "dockerode";
import {
  DockerRuntime,
  NginxProvider,
  OPENRESTY_DEFAULT_PATHS,
  createKubernetesApi,
  rootChecked,
  type CommandExecutor,
  type KubernetesApi,
  type KubernetesObject,
} from "@repo/adapters";
import { allocateClusterRuntimeRanges } from "@repo/core";
import { freePort } from "./free-port";
export { freePort } from "./free-port";

const REPO = join(import.meta.dirname, "../../../..");
export const SCALING_K3S_IMAGE = "rancher/k3s:v1.36.4-k3s1";
export const SCALING_APP_IMAGE = "node:22-alpine";
export const REGISTRY_USER = "openship-e2e";
export const REGISTRY_PASSWORD = "scaling-registry-test-password";
// Public fixture credential. bcrypt is required by the distribution registry.
const HTPASSWD = "openship-e2e:$2y$05$mzY7ng06oTJrMnt171U4Z.WDLE4qtkUSSP8WyNPTHeCS/SK079p.y\n";
const REGISTRY_IMAGE = "registry:2.8.3";
const sq = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
export async function eventually<T>(
  description: string,
  read: () => Promise<T>,
  accepts: (value: T) => boolean,
  timeoutMs = 120_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const value = await read();
      lastError = undefined;
      if (accepts(value)) return value;
    } catch (error) {
      lastError = error;
    }
    await sleep(500);
  }
  throw new Error(
    `Timed out waiting for ${description}${lastError ? `: ${String(lastError)}` : ""}`,
  );
}

/** Docker exec is the lab's transport, in place of SSH to an external server. */
export async function exec(
  docker: Dockerode,
  container: Dockerode.Container,
  command: string[],
  timeoutSeconds = 45,
): Promise<string> {
  const operation = await container.exec({
    Cmd: ["timeout", String(timeoutSeconds), ...command],
    AttachStdout: true,
    AttachStderr: true,
    User: "0",
  });
  const stream = await operation.start({ hijack: true, stdin: false });
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let output = "";
  let errors = "";
  stdout.on("data", (chunk) => {
    output = (output + chunk).slice(-2_000_000);
  });
  stderr.on("data", (chunk) => {
    errors = (errors + chunk).slice(-32_000);
  });
  docker.modem.demuxStream(stream, stdout, stderr);
  const timer = setTimeout(
    () => stream.destroy(new Error("Docker exec timed out")),
    (timeoutSeconds + 5) * 1000,
  );
  try {
    await new Promise<void>((resolve, reject) => {
      stream.once("end", resolve);
      stream.once("error", reject);
    });
    const result = await operation.inspect();
    if (result.ExitCode !== 0)
      throw new Error(`Container command exited ${result.ExitCode}: ${errors || output}`);
    return output;
  } finally {
    clearTimeout(timer);
    stream.destroy();
    stdout.destroy();
    stderr.destroy();
  }
}

function containerExecutor(docker: Dockerode, container: Dockerode.Container): CommandExecutor {
  const run = (command: string) => exec(docker, container, ["sh", "-ec", command]);
  return {
    exec: run,
    async streamExec(command, onLog) {
      const output = await run(command);
      onLog({ message: output, level: "info", timestamp: new Date().toISOString() });
      return { code: 0, output };
    },
    async writeFile(path, content, options) {
      // The content is base64 and paths are quoted; none is interpolated as shell code.
      const mode = options?.mode?.toString(8) ?? "600";
      await run(
        `mkdir -p ${sq(join(path, ".."))}; umask 077; printf %s ${sq(Buffer.from(content).toString("base64"))} | base64 -d > ${sq(path)}; chmod ${mode} ${sq(path)}`,
      );
    },
    readFile: (path) => run(`cat ${sq(path)}`),
    exists: async (path) => (await run(`if test -e ${sq(path)}; then printf yes; fi`)) === "yes",
    mkdir: async (path) => {
      await run(`mkdir -p ${sq(path)}`);
    },
    rm: async (path) => {
      await run(`rm -rf ${sq(path)}`);
    },
    rename: async (from, to) => {
      await run(`mv ${sq(from)} ${sq(to)}`);
    },
    async transferIn() {
      throw new Error(
        "The scaling lab does not transfer host directories through the Edge executor.",
      );
    },
    async dispose() {},
  };
}

export interface ScalingReply {
  version: string;
  instance: string;
  setting: string;
}

export class ScalingLab {
  readonly id = `scaling-${randomUUID().slice(0, 8)}`;
  readonly runtimeId = randomUUID();
  readonly containers: Dockerode.Container[] = [];
  readonly nodes: Array<{ container: Dockerode.Container; name: string; privateIp: string }> = [];
  private readonly clients = new Set<KubernetesApi>();
  private network?: Dockerode.Network;
  private credentials?: { ca: string; cert: string; key: string };
  private apiPort = 0;
  private edgePort = 0;
  private edgeImage = "";
  private registryPort = 0;
  private dockerRuntime?: DockerRuntime;
  podCidr = "";
  serviceCidr = "";
  networkCidrs: string[] = [];
  executor!: CommandExecutor;
  routing!: NginxProvider;
  api!: KubernetesApi;

  get docker() {
    return this.dockerRuntime!.docker;
  }
  get repository() {
    return `127.0.0.1:${this.registryPort}/openship/scaling-app`;
  }
  get registry() {
    return `127.0.0.1:${this.registryPort}`;
  }

  async container(options: Dockerode.ContainerCreateOptions) {
    if (options.Image) {
      try {
        await this.docker.getImage(options.Image).inspect();
      } catch (error) {
        if ((error as { statusCode?: number }).statusCode !== 404) throw error;
        await this.dockerRuntime!.pullImage(options.Image);
      }
    }
    const container = await this.docker.createContainer({
      ...options,
      Labels: { ...options.Labels, "openship.e2e": this.id },
      HostConfig: { NetworkMode: this.id, ...options.HostConfig },
    });
    this.containers.push(container);
    await container.start();
    return container;
  }

  async start(count = 3, options: { edge?: boolean } = {}) {
    try {
      await this.startNodes(count, options);
    } catch (error) {
      // beforeAll failures do not reach afterEach diagnostics. Keep the real
      // node/service errors when a cluster cannot bootstrap or a pull fails.
      console.error(await this.diagnostics());
      throw error;
    }
  }

  private async startNodes(count: number, options: { edge?: boolean }) {
    if (count > 3) {
      const disk = await statfs(tmpdir());
      if (disk.bavail * disk.bsize < 25 * 1024 ** 3)
        throw new Error(
          "The database scaling journey needs at least 25 GiB of free disk space for its disposable nodes and recovery images.",
        );
    }
    this.dockerRuntime = await DockerRuntime.create({ transport: "socket" });
    await this.dockerRuntime.assertReachable();
    const info = await this.docker.info();
    if (info.MemTotal < (count > 3 ? 6 : 4) * 1024 ** 3 - 256 * 1024 ** 2)
      throw new Error(
        `Scaling E2E needs a Linux Docker daemon with at least ${count > 3 ? 6 : 4} GiB RAM.`,
      );
    console.info("[scaling-e2e] Preparing K3s, registry and application images.");
    for (const image of [
      SCALING_K3S_IMAGE,
      REGISTRY_IMAGE,
      ...(options.edge === false ? [] : [SCALING_APP_IMAGE]),
    ]) {
      try {
        await this.docker.getImage(image).inspect();
      } catch (error) {
        if ((error as { statusCode?: number }).statusCode !== 404) throw error;
        await this.dockerRuntime.pullImage(image);
      }
    }
    this.network = await this.docker.createNetwork({
      Name: this.id,
      Labels: { "openship.e2e": this.id },
    });
    const network = await this.network.inspect();
    this.networkCidrs = (network.IPAM?.Config ?? [])
      .map((entry) => entry.Subnet)
      .filter((subnet): subnet is string => !!subnet);
    const ranges = allocateClusterRuntimeRanges(this.networkCidrs);
    this.podCidr = ranges.podCidr;
    this.serviceCidr = ranges.serviceCidr;

    const registry = await this.container({
      name: `${this.id}-registry`,
      Image: REGISTRY_IMAGE,
      Entrypoint: ["/bin/sh", "-ec"],
      Cmd: [
        `mkdir -p /auth; printf %s ${sq(Buffer.from(HTPASSWD).toString("base64"))} | base64 -d > /auth/htpasswd; exec /entrypoint.sh /etc/docker/registry/config.yml`,
      ],
      Env: [
        "REGISTRY_AUTH=htpasswd",
        "REGISTRY_AUTH_HTPASSWD_REALM=scaling-e2e",
        "REGISTRY_AUTH_HTPASSWD_PATH=/auth/htpasswd",
      ],
      ExposedPorts: { "5000/tcp": {} },
      HostConfig: {
        NetworkMode: this.id,
        PortBindings: { "5000/tcp": [{ HostIp: "127.0.0.1", HostPort: await freePort() }] },
      },
    });
    this.registryPort = Number(
      (await registry.inspect()).NetworkSettings.Ports["5000/tcp"]![0].HostPort,
    );
    await eventually(
      "the private fixture registry",
      async () => {
        const response = await fetch(`http://${this.registry}/v2/`, {
          headers: {
            Authorization: `Basic ${Buffer.from(`${REGISTRY_USER}:${REGISTRY_PASSWORD}`).toString("base64")}`,
          },
          signal: AbortSignal.timeout(3000),
        });
        return response.status;
      },
      (status) => status === 200,
    );
    const anonymous = await fetch(`http://${this.registry}/v2/`, {
      signal: AbortSignal.timeout(3000),
    });
    await anonymous.body?.cancel();
    if (anonymous.status !== 401)
      throw new Error("The scaling fixture registry must reject unauthenticated requests.");
    // Nodes reach the same registry via Docker DNS. Authentication still comes
    // from the production imagePullSecret, not from node-wide registry credentials.
    const registries = stringify({
      mirrors: { [this.registry]: { endpoint: [`http://${this.id}-registry:5000`] } },
    });
    const token = randomUUID();
    console.info(`[scaling-e2e] Starting one control node and ${count - 1} workers.`);
    for (let index = 0; index < count; index++) {
      const name = `${this.id}-${index === 0 ? "control" : `worker-${index}`}`;
      const args =
        index === 0
          ? [
              "server",
              "--cluster-init",
              "--disable=traefik,servicelb,local-storage,metrics-server",
              `--cluster-cidr=${this.podCidr}`,
              `--service-cidr=${this.serviceCidr}`,
            ]
          : ["agent", `--server=https://${this.nodes[0].name}:6443`];
      args.push(
        `--node-name=${name}`,
        `--node-label=openship.io/runtime=${this.runtimeId}`,
        "--flannel-iface=eth0",
      );
      const node = await this.container({
        name,
        Hostname: name,
        Image: SCALING_K3S_IMAGE,
        Entrypoint: ["/bin/sh", "-ec"],
        Cmd: [
          `mkdir -p /etc/rancher/k3s; printf %s ${sq(Buffer.from(registries).toString("base64"))} | base64 -d > /etc/rancher/k3s/registries.yaml; exec /bin/k3s ${args.map(sq).join(" ")}`,
        ],
        Env: [`K3S_TOKEN=${token}`, "K3S_KUBECONFIG_MODE=600", "K3S_WITH_NODE_ID=false"],
        ExposedPorts: index === 0 ? { "6443/tcp": {}, "80/tcp": {} } : {},
        HostConfig: {
          Privileged: true,
          // Docker's API supports this field; @types/dockerode still omits it.
          // Each nested kubelet must see only its own cgroups. Sharing the
          // daemon's hierarchy makes nodes inspect one another's pod cgroups.
          ...{ CgroupnsMode: "private" },
          NetworkMode: this.id,
          Tmpfs: { "/run": "", "/var/run": "" },
          ...(index === 0
            ? {
                PortBindings: {
                  "6443/tcp": [{ HostIp: "127.0.0.1", HostPort: await freePort() }],
                  "80/tcp": [{ HostIp: "127.0.0.1", HostPort: await freePort() }],
                },
              }
            : {}),
        },
      });
      const nodeInfo = await node.inspect();
      this.nodes.push({
        container: node,
        name,
        privateIp: nodeInfo.NetworkSettings.Networks[this.id].IPAddress,
      });
      if (index === 0) {
        this.apiPort = Number(nodeInfo.NetworkSettings.Ports["6443/tcp"]![0].HostPort);
        this.edgePort = Number(nodeInfo.NetworkSettings.Ports["80/tcp"]![0].HostPort);
        const kubeconfig = await eventually(
          "K3s API credentials",
          () => this.nodeExec(0, ["cat", "/etc/rancher/k3s/k3s.yaml"]),
          Boolean,
          180_000,
        );
        const config = parse(kubeconfig);
        const decode = (value: string) => Buffer.from(value, "base64").toString();
        this.credentials = {
          ca: decode(config.clusters[0].cluster["certificate-authority-data"]),
          cert: decode(config.users[0].user["client-certificate-data"]),
          key: decode(config.users[0].user["client-key-data"]),
        };
        this.api = this.openApi();
      }
      // Bring up the API before joining workers, then wait for each real
      // kubelet. Nine simultaneous cold starts can starve the single runner's
      // control plane while it bootstraps; no node is counted ready early.
      await eventually(
        `${name} to join and become Ready`,
        () => this.api.request("GET", `/api/v1/nodes/${name}`),
        (node) =>
          node.status?.conditions?.some(
            (condition: { type: string; status: string }) =>
              condition.type === "Ready" && condition.status === "True",
          ),
        240_000,
      );
      console.info(`[scaling-e2e] ${name} is ready.`);
    }
    await eventually(
      `${count} ready Kubernetes nodes`,
      () => this.api.request<{ items: KubernetesObject[] }>("GET", "/api/v1/nodes"),
      ({ items }) =>
        items.length === count &&
        items.every((node) =>
          node.status?.conditions?.some(
            (condition: { type: string; status: string }) =>
              condition.type === "Ready" && condition.status === "True",
          ),
        ),
      240_000,
    );

    if (options.edge === false) return;
    // Build the actual shipped Edge image/config/Lua; only the external ACME
    // service is out of scope (the fixture domain deliberately uses HTTP).
    console.info("[scaling-e2e] Nodes are ready. Building the shipped OpenShip Edge image.");
    this.edgeImage = `openship-e2e:${this.id}-edge`;
    const build = await this.docker.buildImage(
      {
        context: REPO,
        src: [
          "apps/edge/Dockerfile",
          "apps/edge/nginx.conf",
          "packages/adapters/src/infra/lua",
          "apps/api/assets/geoip/GeoLite2-Country.mmdb",
        ],
      },
      { dockerfile: "apps/edge/Dockerfile", t: this.edgeImage },
    );
    await new Promise<void>((resolve, reject) =>
      this.docker.modem.followProgress(
        build,
        (error) => (error ? reject(error) : resolve()),
        (event: { stream?: string }) => {
          if (event.stream?.trim()) console.info(`[scaling-e2e:edge] ${event.stream.trim()}`);
        },
      ),
    );
    const edge = await this.container({
      name: `${this.id}-edge`,
      Image: this.edgeImage,
      HostConfig: { NetworkMode: `container:${this.nodes[0].container.id}` },
    });
    this.executor = containerExecutor(this.docker, edge);
    this.routing = new NginxProvider({
      paths: OPENRESTY_DEFAULT_PATHS,
      executor: rootChecked(this.executor, "Disposable Edge container runs as uid 0."),
      containerEdge: true,
      pinPaths: true,
    });
    await eventually(
      "OpenShip Edge",
      () => this.executor.exec("openresty -t"),
      () => true,
    );
    console.info("[scaling-e2e] Cluster, registry and Edge are ready.");
  }

  openApi(): KubernetesApi {
    if (!this.credentials) throw new Error("The scaling lab has no API credentials.");
    const api = createKubernetesApi({
      host: "127.0.0.1",
      ...this.credentials,
      connect: async () => connect({ host: "127.0.0.1", port: this.apiPort }),
    });
    const dispose = api.dispose.bind(api);
    api.dispose = async () => {
      this.clients.delete(api);
      await dispose();
    };
    this.clients.add(api);
    return api;
  }

  nodeExec(index: number, args: string[], timeoutSeconds = 45) {
    return exec(this.docker, this.nodes[index].container, args, timeoutSeconds);
  }

  async edgeSourceIps(): Promise<string[]> {
    const node = await this.api.request("GET", `/api/v1/nodes/${this.nodes[0].name}`);
    const range = node.spec.podCIDR.split("/")[0].split(".");
    return [this.nodes[0].privateIp, range.join("."), [...range.slice(0, 3), "1"].join(".")];
  }

  /** Fresh upstream TCP connections make distinct backends observable. */
  request(hostname: string): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
      const req = request(
        {
          host: "127.0.0.1",
          port: this.edgePort,
          path: "/",
          agent: false,
          headers: { Host: hostname, Connection: "close" },
        },
        (response) => {
          let body = "";
          response.on("data", (chunk) => {
            body += chunk;
          });
          response.once("error", reject);
          response.once("end", () => resolve({ status: response.statusCode!, body }));
        },
      );
      req.setTimeout(5000, () => req.destroy(new Error("OpenShip Edge request timed out")));
      req.once("error", reject);
      req.end();
    });
  }

  async diagnostics(): Promise<string> {
    const sections: string[] = [];
    for (const container of this.containers) {
      try {
        const info = await container.inspect();
        const output = await container.logs({ stdout: true, stderr: true, tail: 40 });
        // Docker logs use the same multiplexed framing as exec. Strip the
        // headers so CI artifacts are text, not files containing NUL bytes.
        const chunks: Buffer[] = [];
        const raw = Buffer.from(output);
        for (let offset = 0; offset + 8 <= raw.length; ) {
          const length = raw.readUInt32BE(offset + 4);
          chunks.push(raw.subarray(offset + 8, offset + 8 + length));
          offset += 8 + length;
        }
        sections.push(`${info.Name} (${info.State.Status})\n${Buffer.concat(chunks).toString()}`);
      } catch (error) {
        sections.push(`${container.id}: ${String(error)}`);
      }
    }
    if (this.nodes.length) {
      for (const args of [
        ["get", "nodes", "-o", "wide"],
        ["get", "namespaces", "-o", "json"],
        ["get", "pods", "-A", "-o", "wide"],
        ["get", "events", "-A", "--sort-by=.lastTimestamp"],
      ]) {
        try {
          sections.push(await this.nodeExec(0, ["kubectl", ...args]));
        } catch (error) {
          sections.push(String(error));
        }
      }
    }
    return sections.join("\n");
  }

  async close() {
    const failures: unknown[] = [];
    for (const api of [...this.clients]) await api.dispose().catch((error) => failures.push(error));
    for (const container of [...this.containers].reverse()) {
      try {
        const info = await container.inspect();
        if (info.Config.Labels?.["openship.e2e"] !== this.id)
          throw new Error("Refusing to remove a container with different ownership.");
        if (info.State.Paused) await container.unpause();
        await container.remove({ force: true, v: true });
      } catch (error) {
        failures.push(error);
      }
    }
    if (this.edgeImage)
      await this.docker
        .getImage(this.edgeImage)
        .remove({ force: true, noprune: true })
        .catch((error) => failures.push(error));
    if (this.network) await this.network.remove().catch((error) => failures.push(error));
    await this.dockerRuntime?.dispose();
    if (failures.length)
      throw new AggregateError(failures, "Scaling E2E cleanup did not complete.");
  }
}
