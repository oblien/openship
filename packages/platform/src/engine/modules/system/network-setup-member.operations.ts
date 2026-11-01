import type {
  RemoveManagedNetworkOperationMemberInput,
  RemoveManagedNetworkPreparationMemberInput,
  ReviseManagedNetworkAccessInput,
} from "@repo/contracts";
import { repos } from "@repo/db";
import type { ExecutionContext } from "../../../context";
import type { ServerDependencies } from "../../../servers";
import { withServerInventoryLock } from "../../lib/server-inventory-lock";
import { fleetAdmin, managedNetworkCollection } from "./managed-network.operations";
import {
  networkPreparationCollection,
  presentNetworkPreparation,
} from "./network-preparation.operations";
import { authorizeMember, presentManagedOperation, record } from "./server-cluster.operations";
import { notifyNetworkSetup } from "./network-setup-bus";

async function removeMember(
  ctx: ExecutionContext,
  input: RemoveManagedNetworkPreparationMemberInput | RemoveManagedNetworkOperationMemberInput,
) {
  const result = await withServerInventoryLock(ctx.organizationId, async () => {
    await fleetAdmin(ctx);
    if ("operationId" in input) {
      const operation = await repos.serverCluster.getOperation(
        ctx.organizationId,
        input.operationId,
      );
      for (const host of operation.plan.hosts) await authorizeMember(ctx, host.serverId);
      // Expire a lost preparation worker before the transaction checks its state.
      if (operation.plan.preparationId)
        await repos.networkPreparation.get(ctx.organizationId, operation.plan.preparationId);
    } else {
      const preparation = await repos.networkPreparation.get(
        ctx.organizationId,
        input.preparationId,
      );
      for (const host of preparation.hosts) await authorizeMember(ctx, host.serverId);
      const operation = await repos.serverCluster.findOperation(
        ctx.organizationId,
        preparation.operationId ?? preparation.id,
      );
      if (operation) await repos.serverCluster.getOperation(ctx.organizationId, operation.id);
    }
    return repos.networkPreparation.removeMember(ctx.organizationId, ctx.userId, input);
  });
  notifyNetworkSetup(ctx.organizationId, "preparation", result.preparation.id);
  if (result.sourcePreparation)
    notifyNetworkSetup(ctx.organizationId, "preparation", result.sourcePreparation.id);
  if (result.operation) notifyNetworkSetup(ctx.organizationId, "operation", result.operation.id);
  record(ctx, result.preparation.id, "network.setup.member.removed");

  if (result.operation && ["interrupted", "needs_attention"].includes(result.operation.status)) {
    await managedNetworkCollection.applyManagedNetwork(ctx, {
      operationId: result.operation.id,
      planHash: result.operation.planHash,
      action: "rollback",
    });
  }
  return {
    preparation: presentNetworkPreparation(
      await repos.networkPreparation.get(ctx.organizationId, result.preparation.id),
    ),
    operation: result.operation
      ? presentManagedOperation(
          await repos.serverCluster.getOperation(ctx.organizationId, result.operation.id),
        )
      : null,
  };
}

/** Removing a member may clean up its old network; preparation requires an explicit retry. */
export const networkSetupMemberCollection = {
  async reviseManagedNetworkAccess(ctx: ExecutionContext, input: ReviseManagedNetworkAccessInput) {
    const result = await withServerInventoryLock(ctx.organizationId, async () => {
      await fleetAdmin(ctx);
      const preparation = await repos.networkPreparation.get(
        ctx.organizationId,
        input.preparationId,
      );
      for (const host of preparation.hosts) await authorizeMember(ctx, host.serverId);
      return repos.networkPreparation.reviseAccess(ctx.organizationId, ctx.userId, input);
    });
    notifyNetworkSetup(ctx.organizationId, "preparation", result.preparation.id);
    if (result.sourcePreparation)
      notifyNetworkSetup(ctx.organizationId, "preparation", result.sourcePreparation.id);
    if (result.operation) notifyNetworkSetup(ctx.organizationId, "operation", result.operation.id);
    record(ctx, result.preparation.id, "network.setup.connections.updated");
    return networkPreparationCollection.prepareManagedNetwork(ctx, result.preparation.input);
  },
  removeManagedNetworkPreparationMember: removeMember,
  removeManagedNetworkOperationMember: removeMember,
  applyManagedNetwork: managedNetworkCollection.applyManagedNetwork,
} satisfies Pick<
  ServerDependencies["collection"],
  | "removeManagedNetworkPreparationMember"
  | "reviseManagedNetworkAccess"
  | "removeManagedNetworkOperationMember"
  | "applyManagedNetwork"
>;
