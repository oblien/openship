import { createHash } from "node:crypto";
import {
  AppError,
  clusterRuntimeSteps,
  allocateClusterRuntimeRanges,
  assertClusterRuntimeRanges,
  assertClusterRuntimeNetwork,
  managedNetworkUnsettled,
  type ClusterRuntime,
  type ClusterRuntimeHost,
  type ClusterRuntimeStep,
  type SetupStepProgress,
} from "@repo/core";
import { repos, type ClusterRuntimeRecord } from "@repo/db";
import { k3sTools, type CommandExecutor, type K3sHostContext } from "@repo/adapters";
import type { ExecutionContext } from "../../../context";
import type { ServerDependencies } from "../../../servers";
import { createProvisionLock } from "../../lib/provision-lock";
import { withServerInventoryLock } from "../../lib/server-inventory-lock";
import { inspectHostIssuedIdentity } from "../../lib/host-port-target";
import {
  assertClusterManagementAvailable,
  authorizeMember,
  onServer,
  eachMember,
  record,
} from "./server-cluster.operations";
import { fleetAdmin } from "./managed-network.operations";
import {
  appendNetworkSetupLog,
  updateNetworkSetupStep,
  networkSetupMessage,
} from "./network-setup-progress";
import { notifyNetworkSetup } from "./network-setup-bus";
import { assertNetworkSetupAcceptingWork, deferNetworkSetupWork } from "./network-setup-lifecycle";

export function presentClusterRuntime(row: ClusterRuntimeRecord): ClusterRuntime {
  return {
    id: row.id,
    clusterId: row.clusterId,
    provider: row.provider,
    status: row.status,
    intent: row.intent,
    sequence: row.sequence,
    generation: row.generation,
    plan: row.plan,
    error: row.error,
    verifiedAt: row.verifiedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
const message = (error: unknown) =>
  networkSetupMessage(error instanceof Error ? error.message : String(error));
const pause = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    signal.throwIfAborted();
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, ms);
    signal.addEventListener("abort", abort, { once: true });
  });

/** A saved, lease-fenced workflow. Reconciliation checks real host state on every attempt. */
export async function runClusterRuntime(
  ctx: ExecutionContext,
  row: ClusterRuntimeRecord,
  controllerSignal?: AbortSignal,
) {
  const plan = structuredClone(row.plan);
  const cancellation = new AbortController();
  const signal = AbortSignal.any([
    cancellation.signal,
    AbortSignal.timeout(30 * 60_000),
    ...(controllerSignal ? [controllerSignal] : []),
  ]);
  const context = (host: ClusterRuntimeHost): K3sHostContext => ({
    id: row.id,
    generation: row.generation,
    host,
    plan,
  });
  let writes = Promise.resolve();
  let heartbeat = Promise.resolve();
  let dirty = false;
  const persist = () => {
    const snapshot = structuredClone(plan);
    dirty = false;
    writes = writes.then(async () => {
      await repos.clusterRuntime.progress(row.id, row.generation, snapshot);
      notifyNetworkSetup(ctx.organizationId, "runtime", row.clusterId);
    });
    return writes;
  };
  const active = async () => {
    signal.throwIfAborted();
    await fleetAdmin(ctx);
    if (!(await repos.clusterRuntime.active(row.id, row.generation)))
      throw new AppError(
        "This worker no longer owns cluster setup. Reload its saved progress.",
        409,
        "CLUSTER_RUNTIME_EXPIRED",
      );
  };
  const step = async (
    host: ClusterRuntimeHost,
    id: ClusterRuntimeStep,
    status: SetupStepProgress["status"],
    text: string,
  ) => {
    if (status === "running") await active();
    updateNetworkSetupStep(host, id, status, text);
    await persist();
  };
  const checked = async <T>(
    host: ClusterRuntimeHost,
    work: (executor: CommandExecutor) => Promise<T>,
    mutation = false,
  ): Promise<T> => {
    const run = async () => {
      await active();
      return onServer(ctx, host.serverId, async (executor) => {
        await active();
        if (host.hostIdentity && (await inspectHostIssuedIdentity(executor)) !== host.hostIdentity)
          throw new AppError(
            "The server's machine identity changed. Its runtime installation was left untouched.",
            409,
            "CLUSTER_RUNTIME_HOST_CHANGED",
          );
        return executor.runWithAbortSignal
          ? executor.runWithAbortSignal(signal, () => work(executor))
          : work(executor);
      });
    };
    return mutation
      ? createProvisionLock(`provision:server:${host.serverId}`).run(run, signal)
      : run();
  };
  const leaseTimer = setInterval(() => {
    heartbeat = heartbeat
      .then(async () => {
        if (!signal.aborted && !(await repos.clusterRuntime.heartbeat(row.id, row.generation)))
          cancellation.abort();
      })
      .catch(() => cancellation.abort());
  }, 20_000);
  const logTimer = setInterval(() => {
    if (dirty) void persist().catch(() => cancellation.abort());
  }, 1000);
  leaseTimer.unref();
  logTimer.unref();

  try {
    await active();
    for (const host of plan.hosts) await authorizeMember(ctx, host.serverId);
    const cluster = await repos.computeCluster.get(ctx.organizationId, row.clusterId);
    if (
      cluster.networkId !== plan.networkId ||
      cluster.serverIds.length !== plan.hosts.length ||
      plan.hosts.some((host) => !cluster.serverIds.includes(host.serverId))
    )
      throw new AppError(
        "Cluster membership changed during setup.",
        409,
        "CLUSTER_RUNTIME_CONFLICT",
      );
    const network = await repos.serverCluster.get(ctx.organizationId, plan.networkId);
    if (row.intent === "setup") {
      if (
        network.revision !== plan.networkRevision ||
        (network.operation && managedNetworkUnsettled(network.operation.status))
      )
        throw new AppError(
          "The private network changed or needs recovery. Finish it before retrying runtime setup.",
          409,
          "CLUSTER_RUNTIME_NETWORK",
        );
      assertClusterRuntimeNetwork(plan.hosts, network.network.access ?? undefined);
      for (const host of plan.hosts) {
        host.steps = clusterRuntimeSteps();
        host.ready = false;
      }
    } else for (const host of plan.hosts) host.steps = clusterRuntimeSteps(["remove"]);
    await persist();

    // Resolve every physical host before the first package/configuration change.
    const identities = new Set<string>();
    for (const host of plan.hosts) {
      if (row.intent === "remove" && !host.installed) continue;
      if (row.intent === "setup")
        await step(
          host,
          "connect",
          "running",
          "Connecting and checking this server's persistent identity.",
        );
      const identity = await checked(host, inspectHostIssuedIdentity);
      if (!identity || identities.has(identity))
        throw new AppError(
          "Select distinct servers with persistent machine identities. Two entries may point to the same machine.",
          409,
          "CLUSTER_RUNTIME_HOST_CHANGED",
        );
      identities.add(identity);
      host.hostIdentity = identity;
      if (row.intent === "setup")
        await step(
          host,
          "connect",
          "completed",
          "SSH access and persistent machine identity verified.",
        );
    }

    if (row.intent === "remove") {
      if (!plan.cleanup) {
        let clusterUid: string | null = null;
        let inspected = false;
        const errors: string[] = [];
        // A replacement or missing bootstrap is not proof that the other controls have no data.
        for (const host of plan.hosts.filter(
          (member) => member.role === "server" && member.installed,
        )) {
          const state = await checked(host, (executor) =>
            k3sTools.hasState(executor, context(host)),
          );
          if (!state.hasState) continue;
          try {
            const result = await checked(host, (executor) =>
              k3sTools.assertEmpty(executor, context(host)),
            );
            if (!result.empty || !result.clusterUid)
              throw new AppError(
                "The control server did not confirm an empty cluster and its identity.",
                409,
              );
            if (
              (plan.clusterUid && result.clusterUid !== plan.clusterUid) ||
              (clusterUid && result.clusterUid !== clusterUid)
            )
              throw new AppError(
                "The control servers report different cluster identities. Automatic removal was refused.",
                409,
                "CLUSTER_RUNTIME_IDENTITY",
              );
            clusterUid = result.clusterUid;
            inspected = true;
          } catch (error) {
            if (
              error instanceof AppError &&
              ["CLUSTER_RUNTIME_NOT_EMPTY", "CLUSTER_RUNTIME_IDENTITY"].includes(error.code ?? "")
            )
              throw error;
            errors.push(`${host.name}: ${message(error)}`);
          }
        }
        if (errors.length && !inspected)
          throw new AppError(errors.join("\n"), 409, "CLUSTER_RUNTIME_CLEANUP");
        plan.cleanup = { verifiedAt: new Date().toISOString(), clusterUid };
        // Once removal starts, a saved empty-cluster check is required to resume without quorum.
        await persist();
      }
      // Keep the first control server available until every other host is cleaned up.
      for (const host of [...plan.hosts].reverse()) {
        await step(
          host,
          "remove",
          "running",
          "Removing only this cluster's owned runtime installation.",
        );
        if (host.installed) {
          const result = await checked(
            host,
            (executor) => k3sTools.remove(executor, context(host)),
            true,
          );
          if (!result.removed)
            throw new AppError("This server did not confirm runtime removal.", 409);
        }
        host.installed = false;
        host.ready = false;
        await step(
          host,
          "remove",
          "completed",
          "Cluster runtime removed. Existing Docker services and the private network are retained.",
        );
      }
    } else {
      const reservations: string[] = [...network.network.cidrs];
      await eachMember(
        plan.hosts,
        async (host) => {
          try {
            await step(
              host,
              "prerequisites",
              "running",
              "Checking required tools and installing missing prerequisites under the server provisioning lock.",
            );
            await checked(
              host,
              (executor) =>
                k3sTools.prepare(
                  executor,
                  (entry) => {
                    appendNetworkSetupLog(host, "prerequisites", entry);
                    dirty = true;
                  },
                  signal,
                ),
              true,
            );
            await step(
              host,
              "prerequisites",
              "completed",
              "Python, iproute2, iptables and HTTPS download tools are available.",
            );
            await step(
              host,
              "inspect",
              "running",
              "Inspecting memory, disk, cgroups, private interfaces, existing runtimes and network ranges.",
            );
            const inspection = await checked(host, (executor) =>
              k3sTools.inspect(executor, context(host)),
            );
            host.interfaceName = inspection.interfaceName;
            host.installed = inspection.installed;
            reservations.push(...inspection.ranges);
            await step(
              host,
              "inspect",
              "completed",
              "The host supports cluster setup and its private interface is available.",
            );
          } catch (error) {
            await step(
              host,
              host.steps.find((entry) => entry.status === "running")?.id ?? "inspect",
              "failed",
              message(error),
            );
          }
        },
        3,
      );
      const failed = plan.hosts.find((host) =>
        host.steps.some((entry) => entry.status === "failed"),
      );
      if (failed)
        throw new AppError(
          `${failed.name}: ${failed.steps.find((entry) => entry.status === "failed")!.message}`,
          409,
          "CLUSTER_RUNTIME_PREREQUISITES",
        );
      // Resolve once and persist before any installer sees the version or address ranges.
      if (!plan.podCidr || !plan.serviceCidr)
        Object.assign(plan, allocateClusterRuntimeRanges(reservations));
      else assertClusterRuntimeRanges(plan.podCidr, plan.serviceCidr, reservations);
      if (!plan.version) plan.version = await k3sTools.resolveVersion(signal);
      await persist();
      const bootstrap = plan.hosts.find((host) => host.role === "server")!;
      let joinToken: string | undefined;
      for (const host of plan.hosts) {
        await step(
          host,
          "install",
          "running",
          `Installing verified K3s ${plan.version} and private peer firewall rules.`,
        );
        // Save potential ownership BEFORE dispatch: a disconnected command can still have installed files.
        host.installed = true;
        await persist();
        await checked(
          host,
          (executor) =>
            k3sTools.install(executor, context(host), host === bootstrap ? undefined : joinToken),
          true,
        );
        await step(
          host,
          "install",
          "completed",
          "The owned runtime service and private firewall rules are installed.",
        );
        await step(
          host,
          "join",
          "running",
          host === bootstrap
            ? "Starting the private cluster control plane."
            : "Joining this server to the existing cluster over the private network.",
        );
        if (host === bootstrap && plan.hosts.length > 1) {
          // Existing etcd members may need to restart before the API can become ready.
          // The persisted secure token can be read without a working API or etcd quorum.
          const deadline = Date.now() + 3 * 60_000;
          let diagnostic = "Waiting for the cluster join credential.";
          while (Date.now() < deadline) {
            try {
              joinToken = await checked(bootstrap, (executor) => k3sTools.token(executor));
              break;
            } catch (error) {
              diagnostic = message(error);
              await pause(3000, signal);
            }
          }
          if (!joinToken)
            throw new AppError(
              `${bootstrap.name}: ${diagnostic}`,
              409,
              "CLUSTER_RUNTIME_JOIN_FAILED",
            );
        }
      }
      let clusterUid = plan.clusterUid;
      // Start every saved member before waiting for quorum, including on a retry.
      for (const host of plan.hosts) {
        const deadline = Date.now() + 5 * 60_000;
        let ready = false;
        let diagnostic = "Waiting for the runtime service.";
        while (Date.now() < deadline) {
          const result = await checked(host, (executor) => k3sTools.ready(executor, context(host)));
          if (result.ready) {
            if (host.role === "server") {
              if (!result.clusterUid)
                throw new AppError("The control server did not report its cluster identity.", 409);
              if (clusterUid && clusterUid !== result.clusterUid)
                throw new AppError(
                  "The control servers report different cluster identities. Setup has stopped.",
                  409,
                );
              clusterUid = result.clusterUid;
              plan.clusterUid = clusterUid;
            }
            ready = true;
            break;
          }
          diagnostic = result.message ?? diagnostic;
          await pause(5000, signal);
        }
        if (!ready)
          throw new AppError(
            `${host.name} did not join the cluster. Check its private firewall connections. ${diagnostic}`,
            409,
            "CLUSTER_RUNTIME_JOIN_FAILED",
          );
        await step(host, "join", "completed", "The runtime service joined the saved cluster.");
      }
      for (const host of plan.hosts)
        await step(
          host,
          "verify",
          "running",
          "Checking every node, then testing real pod traffic, private service routing and DNS between servers.",
        );
      const deadline = Date.now() + 3 * 60_000;
      let allReady = false;
      while (Date.now() < deadline) {
        const nodes = await checked(bootstrap, (executor) =>
          k3sTools.nodes(executor, context(bootstrap)),
        );
        allReady =
          nodes.items.length === plan.hosts.length &&
          plan.hosts.every((host) =>
            nodes.items.some(
              (node) =>
                node.metadata.name === host.nodeName &&
                node.metadata.labels?.["openship.io/runtime"] === row.id &&
                node.status.nodeInfo?.kubeletVersion === plan.version &&
                node.status.addresses?.some(
                  (address) => address.type === "InternalIP" && address.address === host.privateIp,
                ) &&
                node.status.conditions?.some(
                  (condition) => condition.type === "Ready" && condition.status === "True",
                ),
            ),
          );
        if (allReady) break;
        await pause(5000, signal);
      }
      if (!allReady)
        throw new AppError(
          "Some cluster nodes did not become Ready with their expected private addresses and version. Inspect their runtime logs and retry.",
          409,
          "CLUSTER_RUNTIME_VERIFY_FAILED",
        );
      await checked(bootstrap, (executor) =>
        k3sTools.verifyNetworking(executor, context(bootstrap)),
      );
      for (const host of plan.hosts) {
        host.ready = true;
        await step(
          host,
          "verify",
          "completed",
          "Node readiness, cross-server pod traffic, service routing and internal DNS passed.",
        );
      }
    }
    await active();
    await writes;
    if (!(await repos.clusterRuntime.finish(row.id, row.generation, plan, row.intent, null)))
      throw new AppError(
        "This worker no longer owns cluster setup. Reload its saved progress.",
        409,
        "CLUSTER_RUNTIME_EXPIRED",
      );
    record(
      ctx,
      row.clusterId,
      row.intent === "setup" ? "cluster.runtime.ready" : "cluster.runtime.removed",
    );
  } catch (error) {
    const reason = message(error);
    for (const host of plan.hosts) {
      const current = host.steps.find((entry) => entry.status === "running");
      if (current) updateNetworkSetupStep(host, current.id, "failed", reason);
    }
    await writes.catch(() => undefined);
    await repos.clusterRuntime
      .finish(row.id, row.generation, plan, row.intent, reason)
      .catch(() => undefined);
  } finally {
    clearInterval(logTimer);
    clearInterval(leaseTimer);
    await heartbeat;
    notifyNetworkSetup(ctx.organizationId, "runtime", row.clusterId);
  }
}

async function schedule(
  ctx: ExecutionContext,
  result: { row: ClusterRuntimeRecord; started: boolean },
) {
  if (result.started) {
    notifyNetworkSetup(ctx.organizationId, "runtime", result.row.clusterId);
    record(
      ctx,
      result.row.clusterId,
      result.row.intent === "setup" ? "cluster.runtime.setup" : "cluster.runtime.cleanup",
    );
    await deferNetworkSetupWork(
      {
        kind: "runtime",
        organizationId: ctx.organizationId,
        id: result.row.id,
        clusterId: result.row.clusterId,
        generation: result.row.generation,
      },
      (signal) => runClusterRuntime(ctx, result.row, signal),
    );
  }
  return presentClusterRuntime(result.row);
}
export const clusterRuntimeCollection = {
  async getClusterRuntime(ctx, input) {
    assertClusterManagementAvailable();
    await repos.computeCluster.get(ctx.organizationId, input.clusterId);
    const row = await repos.clusterRuntime.get(ctx.organizationId, input.clusterId);
    return row ? presentClusterRuntime(row) : null;
  },
  async setupClusterRuntime(ctx, input) {
    assertNetworkSetupAcceptingWork();
    const result = await withServerInventoryLock(ctx.organizationId, async () => {
      await fleetAdmin(ctx);
      const cluster = await repos.computeCluster.get(ctx.organizationId, input.clusterId);
      const network = await repos.serverCluster.get(ctx.organizationId, cluster.networkId);
      if (network.operation && managedNetworkUnsettled(network.operation.status))
        throw new AppError(
          "Finish private network setup or recovery before preparing the cluster runtime.",
          409,
          "CLUSTER_RUNTIME_NETWORK",
        );
      const hosts: ClusterRuntimeHost[] = [];
      const controls = cluster.serverIds.length >= 3 ? 3 : 1;
      const servers = [];
      for (const serverId of [...cluster.serverIds].sort())
        servers.push({ serverId, server: await authorizeMember(ctx, serverId) });
      // The first control server is the API/build/Edge gateway, so the local server (the one
      // with the public address) must lead; other members keep their sorted ID order.
      servers.sort((a, b) => Number(!!b.server.isLocal) - Number(!!a.server.isLocal));
      for (const [index, { serverId, server }] of servers.entries()) {
        const member = network.members.find((item) => item.serverId === serverId);
        if (!member)
          throw new AppError(
            "Connect every cluster member to its private network before setup.",
            409,
          );
        hosts.push({
          serverId,
          name: server.name || server.sshHost,
          address: server.sshHost,
          privateIp: member.privateIp,
          nodeName: `opsh-${createHash("sha256").update(serverId).digest("hex").slice(0, 16)}`,
          role: index < controls ? "server" : "agent",
          hostIdentity: null,
          interfaceName: null,
          installed: false,
          ready: false,
          steps: clusterRuntimeSteps(),
          logs: [],
        });
      }
      assertClusterRuntimeNetwork(hosts, network.network.access ?? undefined);
      return repos.clusterRuntime.start(
        ctx.organizationId,
        cluster.id,
        input.revision,
        input.requestId,
        {
          networkId: cluster.networkId,
          networkRevision: network.revision,
          version: null,
          podCidr: null,
          serviceCidr: null,
          hosts,
        },
      );
    });
    return schedule(ctx, result);
  },
  async retryClusterRuntime(ctx, input) {
    assertNetworkSetupAcceptingWork();
    const result = await withServerInventoryLock(ctx.organizationId, async () => {
      await fleetAdmin(ctx);
      const cluster = await repos.computeCluster.get(ctx.organizationId, input.clusterId);
      for (const serverId of cluster.serverIds) await authorizeMember(ctx, serverId);
      return repos.clusterRuntime.change(ctx.organizationId, cluster.id, input.sequence, "retry");
    });
    return schedule(ctx, result);
  },
  async removeClusterRuntime(ctx, input) {
    assertNetworkSetupAcceptingWork();
    const result = await withServerInventoryLock(ctx.organizationId, async () => {
      await fleetAdmin(ctx);
      const cluster = await repos.computeCluster.get(ctx.organizationId, input.clusterId);
      for (const serverId of cluster.serverIds) await authorizeMember(ctx, serverId);
      return repos.clusterRuntime.change(ctx.organizationId, cluster.id, input.sequence, "remove");
    });
    return schedule(ctx, result);
  },
} satisfies Pick<
  ServerDependencies["collection"],
  "getClusterRuntime" | "setupClusterRuntime" | "retryClusterRuntime" | "removeClusterRuntime"
>;
