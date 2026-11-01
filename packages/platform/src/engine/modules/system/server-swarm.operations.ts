import { AppError } from "@repo/core";
import { createHash } from "node:crypto";
import { repos } from "@repo/db";
import { reportCaughtError } from "@repo/core/diagnostics";
import { inspectDockerSwarm } from "@repo/adapters";
import type { ServerDependencies } from "../../../servers";
import { createServerDockerRuntime, resolveServerExecutor } from "../../lib/deployment-runtime";
import { assertSelfHosted, requireConnectedServer } from "./server-access";
import { withServerInventoryLock } from "../../lib/server-inventory-lock";
import { inspectHostIssuedIdentity } from "../../lib/host-port-target";
import { authorization } from "../../lib/authorization";
import { presentComputeCluster } from "./infrastructure-resources.operations";
import { record } from "./server-cluster.operations";

export const serverSwarmResources = {
  async connectSwarm(ctx, id, input) {
    return withServerInventoryLock(ctx.organizationId, async () => {
      await authorization.authorize(ctx, {
        resourceType: "server",
        resourceId: "*",
        action: "admin",
        scope: "all",
      });
      assertSelfHosted();
      const server = await requireConnectedServer(ctx, id);
      const name = input.name.trim();
      if (!name) throw new AppError("Enter a name for this Swarm.", 422, "INVALID_CLUSTER");
      const target = await resolveServerExecutor(id, ctx.organizationId);
      const hostIdentity = await inspectHostIssuedIdentity(target.executor);
      if (!hostIdentity)
        throw new AppError(
          "The manager's machine identity could not be verified.",
          409,
          "CLUSTER_HOST_CHANGED",
        );
      const docker = await createServerDockerRuntime(id, ctx.organizationId);
      try {
        const observed = await inspectDockerSwarm(docker.docker);
        if (
          observed.state !== "active" ||
          observed.role !== "manager" ||
          !observed.clusterId ||
          !observed.nodeId
        )
          throw new AppError(
            "Connect an active Docker Swarm manager before deploying to this cluster.",
            409,
            "SWARM_MANAGER_REQUIRED",
          );
        const row = await repos.computeCluster.connectSwarm(ctx.organizationId, {
          name,
          requestId: input.requestId,
          clusterUid: observed.clusterId,
          inputHash: createHash("sha256")
            .update(
              JSON.stringify({ name, serverId: id, clusterUid: observed.clusterId, hostIdentity }),
            )
            .digest("hex"),
          manager: {
            serverId: id,
            name: server.name || server.sshHost,
            address: server.sshHost,
            privateIp: "",
            nodeName: observed.nodeId,
            role: "server",
            hostIdentity,
            interfaceName: null,
            installed: false,
            ready: true,
            steps: [],
            logs: [],
          },
        });
        record(ctx, row.id, "cluster.connected");
        return presentComputeCluster(ctx.organizationId, row);
      } finally {
        await docker.dispose();
      }
    });
  },
  async inspectSwarm(ctx, id, input = {}) {
    assertSelfHosted();
    await requireConnectedServer(ctx, id);
    const runtime = await createServerDockerRuntime(id, ctx.organizationId);
    try {
      return await inspectDockerSwarm(runtime.docker, input.details === true);
    } catch (error) {
      if (error instanceof AppError) throw error;
      reportCaughtError(error, "platform/engine/modules/system/server-swarm.operations");
      throw new AppError(
        "Could not inspect Docker Swarm. Check the server connection and Docker daemon, then try again.",
        502,
        "SWARM_INSPECTION_UNAVAILABLE",
      );
    } finally {
      await runtime.dispose();
    }
  },
} satisfies Pick<ServerDependencies["resources"], "inspectSwarm" | "connectSwarm">;
