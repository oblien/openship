import { createHash } from "node:crypto";
import type {
  ComputeCluster,
  CreateComputeClusterInput,
  UpdateComputeClusterInput,
} from "@repo/contracts";
import type { ComputeClusterConfig } from "@repo/core";
import { repos, type ComputeClusterRecord } from "@repo/db";
import type { ServerDependencies } from "../../../servers";
import type { ExecutionContext } from "../../../context";
import {
  serverClusterCollection,
  assertClusterManagementAvailable,
  authorizeMember,
  presentCluster,
  record,
} from "./server-cluster.operations";
import { withServerInventoryLock } from "../../lib/server-inventory-lock";
import { authorization } from "../../lib/authorization";
import { NotFoundError } from "@repo/core";

export const infrastructureResources = {
  async infrastructure(ctx, serverId) {
    assertClusterManagementAvailable();
    if (!(await repos.server.getInOrganization(serverId, ctx.organizationId)))
      throw new NotFoundError("Server");
    const [value, canBrowse] = await Promise.all([
      repos.computeCluster.forServer(ctx.organizationId, serverId),
      authorization.checkPermissionOnResource(ctx, {
        resourceType: "server",
        resourceId: "*",
        action: "read",
        scope: "all",
      }),
    ]);
    return { ...value, canBrowse };
  },
} satisfies Pick<ServerDependencies["resources"], "infrastructure">;

/** Canonical network operations reuse the existing journal, authorization and recovery engine. */
export const networkCollection = {
  networkCapabilities: serverClusterCollection.clusterCapabilities,
  listNetworks: serverClusterCollection.listClusters,
  getNetwork: (ctx, { networkId }) =>
    serverClusterCollection.getCluster(ctx, { clusterId: networkId }),
  createNetwork: serverClusterCollection.createCluster,
  updateNetwork: (ctx, { networkId, ...input }) =>
    serverClusterCollection.updateCluster(ctx, { ...input, clusterId: networkId }),
  verifyNetwork: (ctx, { networkId, ...input }) =>
    serverClusterCollection.verifyCluster(ctx, { ...input, clusterId: networkId }),
  removeNetwork: (ctx, { networkId, ...input }) =>
    serverClusterCollection.removeCluster(ctx, { ...input, clusterId: networkId }),
} satisfies Pick<
  ServerDependencies["collection"],
  | "networkCapabilities"
  | "listNetworks"
  | "getNetwork"
  | "createNetwork"
  | "updateNetwork"
  | "verifyNetwork"
  | "removeNetwork"
>;

export async function presentComputeCluster(
  org: string,
  row: ComputeClusterRecord,
  network?: ComputeCluster["network"],
): Promise<ComputeCluster> {
  return {
    id: row.id,
    name: row.name,
    location: row.location,
    revision: row.revision,
    networkId: row.networkId,
    serverIds: row.serverIds,
    network: network ?? presentCluster(await repos.serverCluster.get(org, row.networkId)),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
function config(input: ComputeClusterConfig): ComputeClusterConfig {
  return {
    name: input.name.trim(),
    location: input.location?.trim() || undefined,
    networkId: input.networkId,
    serverIds: [...input.serverIds].sort(),
  };
}
async function manage<T>(ctx: ExecutionContext, action: () => Promise<T>) {
  assertClusterManagementAvailable();
  return withServerInventoryLock(ctx.organizationId, async () => {
    assertClusterManagementAvailable();
    await authorization.authorize(ctx, {
      resourceType: "server",
      resourceId: "*",
      action: "admin",
      scope: "all",
    });
    return action();
  });
}
export const computeClusterCollection = {
  async listComputeClusters(ctx) {
    assertClusterManagementAvailable();
    return Promise.all(
      (await repos.computeCluster.list(ctx.organizationId)).map((row) =>
        presentComputeCluster(ctx.organizationId, row),
      ),
    );
  },
  async getComputeCluster(ctx, input) {
    assertClusterManagementAvailable();
    return presentComputeCluster(
      ctx.organizationId,
      await repos.computeCluster.get(ctx.organizationId, input.clusterId),
    );
  },
  async createComputeCluster(ctx, input: CreateComputeClusterInput) {
    return manage(ctx, async () => {
      const value = config(input);
      for (const id of value.serverIds) await authorizeMember(ctx, id);
      const hash = createHash("sha256").update(JSON.stringify(value)).digest("hex");
      const row = await repos.computeCluster.create(
        ctx.organizationId,
        value,
        input.requestId,
        hash,
      );
      record(ctx, row.id, "cluster.created");
      return presentComputeCluster(ctx.organizationId, row);
    });
  },
  async updateComputeCluster(ctx, input: UpdateComputeClusterInput) {
    return manage(ctx, async () => {
      const value = config(input);
      const current = await repos.computeCluster.get(ctx.organizationId, input.clusterId);
      for (const id of new Set([...current.serverIds, ...value.serverIds]))
        await authorizeMember(ctx, id);
      const row = await repos.computeCluster.update(
        ctx.organizationId,
        input.clusterId,
        input.revision,
        value,
      );
      record(ctx, row.id, "cluster.updated");
      return presentComputeCluster(ctx.organizationId, row);
    });
  },
  async removeComputeCluster(ctx, input) {
    return manage(ctx, async () => {
      const current = await repos.computeCluster.get(ctx.organizationId, input.clusterId);
      for (const id of current.serverIds) await authorizeMember(ctx, id);
      await repos.computeCluster.remove(ctx.organizationId, input.clusterId, input.revision);
      record(ctx, input.clusterId, "cluster.removed");
      return { removed: true as const };
    });
  },
} satisfies Pick<
  ServerDependencies["collection"],
  | "listComputeClusters"
  | "getComputeCluster"
  | "createComputeCluster"
  | "updateComputeCluster"
  | "removeComputeCluster"
>;
