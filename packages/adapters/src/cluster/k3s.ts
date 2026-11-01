import { reportCaughtError as observeCaughtError } from "@repo/core/diagnostics";
import {
  AppError,
  clusterRuntimeFirewallScript,
  type ClusterRuntimeHost,
  type ClusterRuntimePlan,
} from "@repo/core";
import type { CommandExecutor, LogEntry } from "../types";
import { privilegedExecutor } from "../system/privilege";
import { invalidateEnvironment } from "../system/environment";
import { checkTool, installTool } from "../toolchain";
import { sq } from "../system/local-shell";
import { K3S_HOST } from "./k3s-host";

export interface K3sHostContext {
  id: string;
  generation: number;
  plan: ClusterRuntimePlan;
  host: ClusterRuntimeHost;
}
export interface K3sHostInspection {
  interfaceName: string;
  ranges: string[];
  installed: boolean;
}
export interface K3sReadiness {
  ready: boolean;
  message?: string;
  clusterUid?: string;
}
interface K3sNode {
  metadata: { name: string; labels?: Record<string, string> };
  status: {
    addresses?: { type: string; address: string }[];
    conditions?: { type: string; status: string; message?: string }[];
    nodeInfo?: { kubeletVersion?: string };
  };
}
const failure = (message: string) => new AppError(message, 409, "CLUSTER_RUNTIME_HOST");

async function root(executor: CommandExecutor) {
  const result = await privilegedExecutor(executor, "Setting up the cluster runtime");
  if (!result.supported) throw failure(result.reason);
  const { profile } = result.value;
  if (
    profile.os !== "linux" ||
    profile.serviceManager !== "systemd" ||
    !["amd64", "arm64"].includes(profile.arch)
  )
    throw failure(
      "Cluster setup supports Linux amd64 or arm64 servers with systemd and root or passwordless sudo access.",
    );
  if (!["none", "iptables"].includes(profile.firewall))
    throw failure(
      `Automatic K3s firewall setup currently supports unfiltered hosts and iptables (including its nft backend). This server uses ${profile.firewall}; configure a supported host firewall before retrying.`,
    );
  return result.value.executor;
}
function payload(ctx: K3sHostContext) {
  const bootstrap = ctx.plan.hosts.find((host) => host.role === "server");
  if (!bootstrap) throw failure("The cluster has no control server.");
  return {
    id: ctx.id,
    generation: ctx.generation,
    deadline: Date.now() / 1000 + 6 * 60,
    host: {
      nodeName: ctx.host.nodeName,
      role: ctx.host.role,
      privateIp: ctx.host.privateIp,
      interfaceName: ctx.host.interfaceName,
    },
    version: ctx.plan.version,
    podCidr: ctx.plan.podCidr,
    serviceCidr: ctx.plan.serviceCidr,
    cleanup: ctx.plan.cleanup ?? null,
    bootstrap: ctx.host.serverId === bootstrap.serverId,
    bootstrapIp: bootstrap.privateIp,
  };
}
async function action<T>(
  executor: CommandExecutor,
  ctx: K3sHostContext,
  name: string,
  timeout = 60_000,
): Promise<T> {
  const privileged = await root(executor);
  // The remote timeout also ends work when the SSH connection/controller disappears.
  const output = await privileged.exec(
    `timeout --signal=TERM --kill-after=10s ${Math.ceil(timeout / 1000)}s python3 -c ${sq(K3S_HOST)} ${sq(name)} ${sq(JSON.stringify(payload(ctx)))}`,
    { timeout: timeout + 15_000 },
  );
  let data: T & { error?: string; code?: string };
  try {
    data = JSON.parse(output.trim());
  } catch (diagnosticFailure) {
    observeCaughtError(diagnosticFailure, "adapters/cluster/k3s");
    throw failure(
      "The server returned an invalid runtime setup response. Check SSH command access and retry.",
    );
  }
  if (!data || typeof data !== "object")
    throw failure("The server returned an empty runtime setup response.");
  if (data.error)
    throw data.code === "CLUSTER_RUNTIME_NOT_EMPTY"
      ? new AppError(data.error, 409, data.code)
      : failure(data.error);
  return data;
}

export function k3sFirewallScript(ctx: K3sHostContext): string {
  return clusterRuntimeFirewallScript(ctx);
}

export const k3sTools = {
  async resolveVersion(signal?: AbortSignal): Promise<string> {
    const response = await fetch("https://update.k3s.io/v1-release/channels", {
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(20_000)])
        : AbortSignal.timeout(20_000),
    });
    if (!response.ok)
      throw failure(
        `The K3s release service returned HTTP ${response.status}. Retry when it is reachable.`,
      );
    const body = (await response.json()) as { data?: { id?: string; latest?: string }[] };
    const version = body.data?.find((channel) => channel.id === "stable")?.latest;
    if (!version || !/^v1\.\d+\.\d+\+k3s\d+$/.test(version))
      throw failure("The K3s release service did not return a valid stable release.");
    return version;
  },
  async prepare(executor: CommandExecutor, onLog: (entry: LogEntry) => void, signal?: AbortSignal) {
    invalidateEnvironment(executor);
    const privileged = await root(executor);
    for (const [tool, minimum] of [
      ["python3", "3.8"],
      ["iproute2", "4.15"],
      ["iptables", "1.8"],
      ["curl", "7.61"],
    ]) {
      signal?.throwIfAborted();
      let state = await checkTool(privileged, tool!, { minVersion: minimum });
      if (!state.healthy) {
        const result = await installTool(executor, tool!, onLog, minimum, { signal });
        if (!result.success) throw failure(result.error || `${state.label} installation failed.`);
        state = await checkTool(privileged, tool!, { minVersion: minimum });
        if (!state.healthy) throw failure(state.message);
      }
      onLog({ level: "info", timestamp: new Date().toISOString(), message: state.message });
    }
  },
  async inspect(executor: CommandExecutor, ctx: K3sHostContext) {
    const value = await action<K3sHostInspection>(executor, ctx, "inspect");
    if (
      typeof value.interfaceName !== "string" ||
      !Array.isArray(value.ranges) ||
      value.ranges.some((range) => typeof range !== "string") ||
      typeof value.installed !== "boolean"
    )
      throw failure("The server returned an incomplete runtime inspection.");
    return value;
  },
  async install(executor: CommandExecutor, ctx: K3sHostContext, joinToken?: string) {
    await action(executor, ctx, "claim");
    const privileged = await root(executor);
    await privileged.writeFile("/var/lib/openship/k3s/firewall.sh", k3sFirewallScript(ctx), {
      mode: 0o700,
    });
    if (joinToken) {
      if (!/^K10[a-f0-9]+::server:[^\s]+$/.test(joinToken) || joinToken.length > 4096)
        throw failure("The control server returned an invalid secure join token.");
      try {
        await privileged.writeFile(
          `/var/lib/openship/k3s/join-${ctx.generation}.token`,
          joinToken,
          { mode: 0o600 },
        );
      } catch (diagnosticFailure) {
        observeCaughtError(diagnosticFailure, "adapters/cluster/k3s");
        throw failure(
          "The private join credential could not be transferred to this server. Check SSH file access and retry.",
        );
      }
    }
    return action<{ installed: boolean }>(executor, ctx, "install", 360_000);
  },
  async token(executor: CommandExecutor): Promise<string> {
    const privileged = await root(executor);
    let value: string;
    try {
      value = (await privileged.readFile("/var/lib/rancher/k3s/server/node-token")).trim();
    } catch (diagnosticFailure) {
      observeCaughtError(diagnosticFailure, "adapters/cluster/k3s");
      throw failure(
        "The control server's secure join credential is not ready. Retry setup after checking its service logs.",
      );
    }
    if (!/^K10[a-f0-9]+::server:[^\s]+$/.test(value) || value.length > 4096)
      throw failure("The control server returned an invalid secure join token.");
    return value;
  },
  ready: (executor: CommandExecutor, ctx: K3sHostContext) =>
    action<K3sReadiness>(executor, ctx, "ready"),
  nodes: (executor: CommandExecutor, ctx: K3sHostContext) =>
    action<{ items: K3sNode[] }>(executor, ctx, "nodes"),
  assertEmpty: (executor: CommandExecutor, ctx: K3sHostContext) =>
    action<{ empty: boolean; clusterUid: string }>(executor, ctx, "empty", 180_000),
  hasState: (executor: CommandExecutor, ctx: K3sHostContext) =>
    action<{ hasState: boolean }>(executor, ctx, "state"),
  remove: (executor: CommandExecutor, ctx: K3sHostContext) =>
    action<{ removed: boolean }>(executor, ctx, "remove", 180_000),

  /** Real cross-node pods, service routing and DNS. No workloads are reported ready on node status alone. */
  async verifyNetworking(executor: CommandExecutor, ctx: K3sHostContext) {
    const privileged = await root(executor);
    const namespace = `openship-check-${ctx.id.slice(0, 8)}-${ctx.generation}`;
    const prefix = `/usr/local/bin/k3s kubectl --kubeconfig=/etc/rancher/k3s/k3s.yaml --server=${sq(`https://${ctx.host.privateIp}:6443`)} --request-timeout=30s`;
    const kubectl = (args: string, timeout = 45_000) =>
      privileged.exec(`${prefix} ${args}`, { timeout });
    let owned = false;
    let issue: Error | undefined;
    try {
      const leftovers = JSON.parse(
        await kubectl(
          `get namespaces -l ${sq(`openship.io/runtime=${ctx.id},openship.io/purpose=runtime-check`)} -o json`,
        ),
      ) as { items: { metadata: { name: string } }[] };
      const previousNames: string[] = [];
      for (const entry of leftovers.items) {
        const name = entry.metadata.name;
        const match = new RegExp(`^openship-check-${ctx.id.slice(0, 8)}-(\\d+)$`).exec(name);
        if (!match || Number(match[1]) > ctx.generation)
          throw failure(
            "Another verification attempt owns the cluster test namespace. Reload its saved progress.",
          );
        if (name !== namespace) previousNames.push(name);
      }
      if (previousNames.length)
        await kubectl(
          `delete namespace ${previousNames.map(sq).join(" ")} --wait=true --timeout=90s`,
          105_000,
        );
      const previous = (
        await kubectl(`get namespace ${sq(namespace)} --ignore-not-found -o json`)
      ).trim();
      if (previous && JSON.parse(previous).metadata?.labels?.["openship.io/runtime"] !== ctx.id)
        throw failure("The runtime test namespace is already owned by another workload.");
      if (previous)
        await kubectl(`delete namespace ${sq(namespace)} --wait=true --timeout=90s`, 105_000);
      const resources: object[] = [
        {
          apiVersion: "v1",
          kind: "Namespace",
          metadata: {
            name: namespace,
            labels: { "openship.io/runtime": ctx.id, "openship.io/purpose": "runtime-check" },
          },
        },
      ];
      for (const host of ctx.plan.hosts) {
        const name = host.nodeName;
        resources.push(
          {
            apiVersion: "v1",
            kind: "Pod",
            metadata: { name, namespace, labels: { "openship.io/check": name } },
            spec: {
              nodeName: name,
              terminationGracePeriodSeconds: 1,
              restartPolicy: "Never",
              automountServiceAccountToken: false,
              containers: [
                {
                  name: "check",
                  image: "docker.io/library/busybox:1.37.0",
                  command: [
                    "sh",
                    "-c",
                    "mkdir -p /tmp/site; printf openship-ready > /tmp/site/index.html; exec httpd -f -p 8080 -h /tmp/site",
                  ],
                  resources: {
                    requests: { cpu: "10m", memory: "8Mi" },
                    limits: { cpu: "100m", memory: "32Mi" },
                  },
                  readinessProbe: {
                    httpGet: { path: "/", port: 8080 },
                    initialDelaySeconds: 1,
                    periodSeconds: 2,
                  },
                },
              ],
            },
          },
          {
            apiVersion: "v1",
            kind: "Service",
            metadata: { name, namespace },
            spec: {
              selector: { "openship.io/check": name },
              ports: [{ port: 8080, targetPort: 8080 }],
            },
          },
        );
      }
      const path = `/var/lib/openship/k3s/check-${ctx.generation}.json`;
      await privileged.writeFile(
        path,
        JSON.stringify({ apiVersion: "v1", kind: "List", items: resources }),
        { mode: 0o600 },
      );
      // The namespace ownership is included in the same apply; cleanup verifies it again.
      owned = true;
      await kubectl(`apply -f ${sq(path)}`);
      await kubectl(
        `wait -n ${sq(namespace)} --for=condition=Ready pod --all --timeout=240s`,
        255_000,
      );
      for (const host of ctx.plan.hosts) {
        const commands = [
          "nslookup kubernetes.default.svc.cluster.local >/dev/null",
          ...ctx.plan.hosts.map(
            (peer) =>
              `[ "$(wget -T 5 -qO- http://${peer.nodeName}.${namespace}.svc.cluster.local:8080/)" = openship-ready ]`,
          ),
        ];
        await kubectl(
          `exec -n ${sq(namespace)} ${sq(host.nodeName)} -- sh -ec ${sq(commands.join("\n"))}`,
          30_000 + ctx.plan.hosts.length * 6000,
        );
      }
    } catch (error) {
      observeCaughtError(error, "adapters/cluster/k3s");
      let diagnostic = "";
      try {
        diagnostic = await kubectl(`get pods -n ${sq(namespace)} -o wide`);
      } catch (diagnosticFailure) {
        observeCaughtError(diagnosticFailure, "adapters/cluster/k3s");
        /* original SSH/API error is retained */
      }
      issue = failure(
        `${error instanceof Error ? error.message : "Cluster service and DNS verification failed."}${diagnostic ? `\n${diagnostic.slice(-2000)}` : ""}`,
      );
    } finally {
      if (owned) {
        try {
          const current = (
            await kubectl(`get namespace ${sq(namespace)} --ignore-not-found -o json`)
          ).trim();
          if (current && JSON.parse(current).metadata?.labels?.["openship.io/runtime"] === ctx.id)
            await kubectl(`delete namespace ${sq(namespace)} --wait=true --timeout=90s`, 105_000);
        } catch (error) {
          observeCaughtError(error, "adapters/cluster/k3s");
          const detail =
            error instanceof Error
              ? error.message
              : "The temporary test namespace could not be removed.";
          issue = failure(
            `${issue ? `${issue.message}\n` : ""}Test cleanup needs a retry: ${detail}`,
          );
        }
      }
    }
    if (issue) throw issue;
  },
};
