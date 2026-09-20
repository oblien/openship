import { presentComputeCluster } from "./infrastructure-resources.operations";
import { createHash } from "node:crypto";
import { managedNetworkInProgress } from "@repo/core";
import { repos } from "@repo/db";
import type { ServerDependencies } from "../../../servers";
import { authorization } from "../../lib/authorization";
import { durableRunEvents } from "../../lib/durable-run-events";
import {
  assertClusterManagementAvailable,
  presentCluster,
  presentManagedOperation,
} from "./server-cluster.operations";
import { presentNetworkPreparation } from "./network-preparation.operations";
import { networkSetupBus, networkSetupTopic } from "./network-setup-bus";

export const networkSetupStreams: NonNullable<ServerDependencies["networks"]> = {
  async events(ctx, kind, id, signal) {
    const authorize = async () => {
      signal?.throwIfAborted();
      assertClusterManagementAvailable();
      await authorization.authorize(ctx, {
        resourceType: "server",
        resourceId: "*",
        action: "read",
        scope: "all",
      });
    };
    const subscribe = (changed: () => void) =>
      networkSetupBus.subscribe(networkSetupTopic(ctx.organizationId, kind, id), changed);
    if (kind === "preparation") {
      const load = async () => {
        await authorize();
        return presentNetworkPreparation(
          await repos.networkPreparation.get(ctx.organizationId, id!),
        );
      };
      await load(); // Validate organization/authority/existence before HTTP headers.
      return durableRunEvents({
        subscribe,
        load,
        signal,
        version: (row) => row.sequence,
        complete: (row) => row.status !== "preparing" && row.status !== "pending",
      });
    }
    if (kind === "operation") {
      const load = async () => {
        await authorize();
        return presentManagedOperation(
          await repos.serverCluster.getOperation(ctx.organizationId, id!),
        );
      };
      await load();
      return durableRunEvents({
        subscribe,
        load,
        signal,
        version: (row) => row.sequence,
        complete: (row) => !managedNetworkInProgress(row.status),
      });
    }
    const load = async () => {
      await authorize();
      const [clusters, preparations, pools] = await Promise.all([
        repos.serverCluster.list(ctx.organizationId),
        repos.networkPreparation.list(ctx.organizationId),
        repos.computeCluster.list(ctx.organizationId),
      ]);
      const networks = clusters.map((row) => {
        const cluster = presentCluster(row);
        // Lists need status and connectivity, not every server's package log.
        if (cluster.operation)
          cluster.operation = {
            ...cluster.operation,
            hosts: cluster.operation.hosts.map(({ logs: _logs, steps: _steps, ...host }) => host),
          };
        return cluster;
      });
      return {
        clusters: networks, // v1 overview compatibility
        networks,
        computeClusters: await Promise.all(
          pools.map((pool) =>
            presentComputeCluster(
              ctx.organizationId,
              pool,
              networks.find((network) => network.id === pool.networkId),
            ),
          ),
        ),
        preparations,
      };
    };
    await authorize();
    return durableRunEvents({
      subscribe,
      load,
      signal,
      // Lease renewal alone does not change anything displayed in the overview.
      version: (row) =>
        createHash("sha256")
          .update(
            JSON.stringify(row, (key, value) =>
              key === "leaseExpiresAt" || key === "updatedAt" ? undefined : value,
            ),
          )
          .digest("hex"),
      complete: () => false,
    });
  },
};
