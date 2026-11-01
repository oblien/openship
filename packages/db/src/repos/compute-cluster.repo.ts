import { and, desc, eq, inArray, ne, sql } from "drizzle-orm";
import {
  AppError,
  NotFoundError,
  type ComputeClusterConfig,
  type ClusterRuntimeHost,
} from "@repo/core";
import type { Database, DatabaseTransaction } from "../client";
import { hashStringToInt } from "../advisory-lock-factory";
import {
  computeCluster,
  computeClusterMember,
  clusterRuntime,
  serverCluster as privateNetwork,
  clusterMember as networkMember,
  clusterNetwork as networkConfig,
  serverNetworkAttachment,
  managedNetworkOperation,
  servers,
  project,
  deployment,
} from "../schema";

const conflict = (message: string) => new AppError(message, 409, "CLUSTER_CONFLICT");
const unsettled = [
  "applying",
  "verifying",
  "committing",
  "rolling_back",
  "interrupted",
  "needs_attention",
] as const;

/** Check before host mutation; deferred database references also protect direct writes. */
export async function assertNetworkDependencies(
  tx: Database | DatabaseTransaction,
  org: string,
  networkId: string,
  nextServerIds?: string[],
) {
  const users = await tx
    .select({ id: computeCluster.id, name: computeCluster.name })
    .from(computeCluster)
    .where(and(eq(computeCluster.organizationId, org), eq(computeCluster.networkId, networkId)));
  if (!users.length) return;
  const [runtime] = await tx
    .select({ id: clusterRuntime.id })
    .from(clusterRuntime)
    .where(
      and(
        inArray(
          clusterRuntime.clusterId,
          users.map((cluster) => cluster.id),
        ),
        ne(clusterRuntime.status, "removed"),
      ),
    );
  if (runtime)
    throw new AppError(
      "This network supports an installed or unfinished cluster runtime. Remove that runtime before changing the network.",
      409,
      "NETWORK_IN_USE",
    );
  if (!nextServerIds)
    throw new AppError(
      `This network is used by ${users.map((cluster) => cluster.name).join(", ")}. Change or remove those cluster references before deleting the network.`,
      409,
      "NETWORK_IN_USE",
    );
  const members = await tx
    .select({ serverId: computeClusterMember.serverId })
    .from(computeClusterMember)
    .where(
      inArray(
        computeClusterMember.clusterId,
        users.map((cluster) => cluster.id),
      ),
    );
  if (members.some((member) => !nextServerIds.includes(member.serverId)))
    throw new AppError(
      "A server being detached is still used by a cluster on this network. Update cluster membership first.",
      409,
      "NETWORK_IN_USE",
    );
}

export function createComputeClusterRepo(db: Database) {
  const owned = (org: string, id: string) =>
    and(eq(computeCluster.organizationId, org), eq(computeCluster.id, id));
  async function read(tx: Database | DatabaseTransaction, org: string, id: string) {
    const [row] = await tx
      .select({
        cluster: computeCluster,
        scaling: {
          provider: clusterRuntime.provider,
          status: clusterRuntime.status,
          verifiedAt: clusterRuntime.verifiedAt,
        },
      })
      .from(computeCluster)
      .leftJoin(
        clusterRuntime,
        and(
          eq(clusterRuntime.clusterId, computeCluster.id),
          eq(clusterRuntime.organizationId, org),
        ),
      )
      .where(owned(org, id));
    if (!row) throw new NotFoundError("Cluster", id);
    const members = await tx
      .select({ serverId: computeClusterMember.serverId })
      .from(computeClusterMember)
      .where(eq(computeClusterMember.clusterId, id))
      .orderBy(computeClusterMember.serverId);
    return {
      ...row.cluster,
      scaling: row.scaling,
      serverIds: members.map((member) => member.serverId),
    };
  }
  async function validate(
    tx: DatabaseTransaction,
    org: string,
    config: ComputeClusterConfig,
    id?: string,
  ) {
    if (
      !config.name.trim() ||
      !config.serverIds.length ||
      new Set(config.serverIds).size !== config.serverIds.length
    )
      throw new AppError(
        "Choose a name and distinct servers for this cluster.",
        400,
        "INVALID_CLUSTER",
      );
    // Network mutations take this same row lock. A pool cannot acquire a dependency
    // between network cleanup's preflight and its durable operation claim.
    const [network] = await tx
      .select()
      .from(privateNetwork)
      .where(and(eq(privateNetwork.organizationId, org), eq(privateNetwork.id, config.networkId)))
      .for("update");
    if (!network) throw new NotFoundError("Network", config.networkId);
    const [operation] = await tx
      .select({ id: managedNetworkOperation.id })
      .from(managedNetworkOperation)
      .where(
        and(
          eq(managedNetworkOperation.clusterId, config.networkId),
          inArray(managedNetworkOperation.status, [...unsettled]),
        ),
      );
    if (operation)
      throw conflict(
        "Finish network setup or recovery before selecting this network for a cluster.",
      );
    const attached = await tx
      .select({ serverId: networkMember.serverId })
      .from(networkMember)
      .innerJoin(servers, eq(servers.id, networkMember.serverId))
      .where(
        and(
          eq(networkMember.clusterId, config.networkId),
          eq(servers.organizationId, org),
          inArray(networkMember.serverId, config.serverIds),
        ),
      );
    if (attached.length !== config.serverIds.length)
      throw conflict("Connect every selected server to this network in Networking first.");
    const found = await tx
      .select({ id: servers.id })
      .from(servers)
      .where(
        and(eq(servers.organizationId, org), inArray(servers.id, [...config.serverIds].sort())),
      )
      .orderBy(servers.id)
      .for("update");
    if (found.length !== config.serverIds.length) throw new NotFoundError("Server");
    const [existing] = await tx
      .select({ id: computeClusterMember.id })
      .from(computeClusterMember)
      .where(
        and(
          inArray(computeClusterMember.serverId, config.serverIds),
          id ? ne(computeClusterMember.clusterId, id) : undefined,
        ),
      );
    if (existing) throw conflict("A selected server already belongs to another compute cluster.");
  }
  async function write(tx: DatabaseTransaction, id: string, config: ComputeClusterConfig) {
    await tx.delete(computeClusterMember).where(eq(computeClusterMember.clusterId, id));
    await tx.insert(computeClusterMember).values(
      config.serverIds.map((serverId) => ({
        clusterId: id,
        networkId: config.networkId,
        serverId,
      })),
    );
  }
  return {
    /** Register a verified, externally managed scheduler. No host/network mutation. */
    async connectSwarm(
      org: string,
      input: {
        name: string;
        requestId: string;
        inputHash: string;
        clusterUid: string;
        manager: ClusterRuntimeHost;
      },
    ) {
      return db.transaction(async (tx) => {
        await tx.execute(
          sql`select pg_advisory_xact_lock(${hashStringToInt(`compute-cluster:${org}:${input.requestId}`)})`,
        );
        await tx.execute(
          sql`select pg_advisory_xact_lock(${hashStringToInt(`swarm-cluster:${org}:${input.clusterUid}`)})`,
        );
        const [prior] = await tx
          .select()
          .from(computeCluster)
          .where(
            and(
              eq(computeCluster.organizationId, org),
              eq(computeCluster.requestId, input.requestId),
            ),
          );
        if (prior) {
          if (prior.inputHash !== input.inputHash)
            throw conflict("This request was already used for different cluster settings.");
          return read(tx, org, prior.id);
        }
        const [server] = await tx
          .select()
          .from(servers)
          .where(and(eq(servers.id, input.manager.serverId), eq(servers.organizationId, org)))
          .for("update");
        if (!server) throw new NotFoundError("Server");
        const [member] = await tx
          .select()
          .from(computeClusterMember)
          .where(eq(computeClusterMember.serverId, server.id));
        const [registered] = await tx
          .select()
          .from(clusterRuntime)
          .where(
            and(
              eq(clusterRuntime.organizationId, org),
              eq(clusterRuntime.provider, "swarm"),
              sql`${clusterRuntime.plan}->>'clusterUid' = ${input.clusterUid}`,
            ),
          );
        if (member || registered)
          throw conflict("This server or Swarm is already connected to a compute cluster.");
        const [created] = await tx
          .insert(computeCluster)
          .values({
            organizationId: org,
            name: input.name,
            networkId: null,
            requestId: input.requestId,
            inputHash: input.inputHash,
          })
          .returning();
        await tx
          .insert(computeClusterMember)
          .values({ clusterId: created!.id, networkId: null, serverId: server.id });
        await tx.insert(clusterRuntime).values({
          clusterId: created!.id,
          organizationId: org,
          clusterRevision: 1,
          requestId: input.requestId,
          provider: "swarm",
          status: "ready",
          verifiedAt: new Date(),
          plan: {
            networkId: null,
            networkRevision: null,
            version: null,
            podCidr: null,
            serviceCidr: null,
            clusterUid: input.clusterUid,
            hosts: [input.manager],
          },
        });
        return read(tx, org, created!.id);
      });
    },
    /** Only associations of the authorized server; never exposes other network members. */
    async forServer(org: string, serverId: string) {
      return db.transaction(async (tx) => {
        const networks = await tx
          .select({
            id: privateNetwork.id,
            name: privateNetwork.name,
            mode: networkConfig.mode,
            privateIp: serverNetworkAttachment.privateIp,
          })
          .from(privateNetwork)
          .innerJoin(networkConfig, eq(networkConfig.clusterId, privateNetwork.id))
          .innerJoin(
            serverNetworkAttachment,
            eq(serverNetworkAttachment.networkId, networkConfig.id),
          )
          .innerJoin(servers, eq(servers.id, serverNetworkAttachment.serverId))
          .where(
            and(
              eq(privateNetwork.organizationId, org),
              eq(servers.organizationId, org),
              eq(servers.id, serverId),
            ),
          )
          .orderBy(privateNetwork.name);
        const [cluster] = await tx
          .select({ id: computeCluster.id, name: computeCluster.name })
          .from(computeCluster)
          .innerJoin(computeClusterMember, eq(computeClusterMember.clusterId, computeCluster.id))
          .where(
            and(
              eq(computeCluster.organizationId, org),
              eq(computeClusterMember.serverId, serverId),
            ),
          );
        return { networks, cluster: cluster ?? null };
      });
    },
    get: (org: string, id: string) => db.transaction((tx) => read(tx, org, id)),
    async list(org: string) {
      return db.transaction(async (tx) => {
        const rows = await tx
          .select({ id: computeCluster.id })
          .from(computeCluster)
          .where(eq(computeCluster.organizationId, org))
          .orderBy(desc(computeCluster.createdAt));
        return Promise.all(rows.map((row) => read(tx, org, row.id)));
      });
    },
    async create(org: string, config: ComputeClusterConfig, requestId: string, inputHash: string) {
      return db.transaction(async (tx) => {
        await tx.execute(
          sql`select pg_advisory_xact_lock(${hashStringToInt(`compute-cluster:${org}:${requestId}`)})`,
        );
        const [prior] = await tx
          .select()
          .from(computeCluster)
          .where(
            and(eq(computeCluster.organizationId, org), eq(computeCluster.requestId, requestId)),
          );
        if (prior) {
          if (prior.inputHash !== inputHash)
            throw conflict("This request was already used for different cluster settings.");
          return read(tx, org, prior.id);
        }
        await validate(tx, org, config);
        const [created] = await tx
          .insert(computeCluster)
          .values({
            organizationId: org,
            name: config.name,
            location: config.location || null,
            networkId: config.networkId,
            requestId,
            inputHash,
          })
          .returning();
        await write(tx, created!.id, config);
        return read(tx, org, created!.id);
      });
    },
    async update(org: string, id: string, revision: number, config: ComputeClusterConfig) {
      return db.transaction(async (tx) => {
        const [current] = await tx
          .select()
          .from(computeCluster)
          .where(owned(org, id))
          .for("update");
        if (!current) throw new NotFoundError("Cluster", id);
        if (!current.networkId)
          throw conflict(
            "This cluster is managed by Docker Swarm. Its membership and network must be changed on its manager.",
          );
        if (current.revision !== revision)
          throw conflict("The cluster changed. Reload it before continuing.");
        const [runtime] = await tx
          .select({ id: clusterRuntime.id })
          .from(clusterRuntime)
          .where(and(eq(clusterRuntime.clusterId, id), ne(clusterRuntime.status, "removed")));
        if (runtime) {
          const members = await tx
            .select({ serverId: computeClusterMember.serverId })
            .from(computeClusterMember)
            .where(eq(computeClusterMember.clusterId, id));
          if (
            current.networkId !== config.networkId ||
            members.length !== config.serverIds.length ||
            members.some((member) => !config.serverIds.includes(member.serverId))
          )
            throw new AppError(
              "Remove the cluster runtime before changing its servers or private network.",
              409,
              "CLUSTER_RUNTIME_IN_USE",
            );
        }
        await validate(tx, org, config, id);
        await tx
          .update(computeCluster)
          .set({
            name: config.name,
            location: config.location || null,
            networkId: config.networkId,
            revision: revision + 1,
            updatedAt: new Date(),
          })
          .where(owned(org, id));
        await write(tx, id, config);
        return read(tx, org, id);
      });
    },
    async remove(org: string, id: string, revision: number) {
      return db.transaction(async (tx) => {
        const [current] = await tx
          .select()
          .from(computeCluster)
          .where(owned(org, id))
          .for("update");
        if (!current) throw new NotFoundError("Cluster", id);
        if (current.revision !== revision)
          throw conflict("The cluster changed. Reload it before continuing.");
        const [runtime] = await tx
          .select()
          .from(clusterRuntime)
          .where(eq(clusterRuntime.clusterId, id));
        if (runtime?.provider === "swarm") {
          const [bound] = await tx
            .select({ id: project.id })
            .from(project)
            .where(eq(project.clusterId, id));
          const [release] = await tx
            .select({ id: deployment.id })
            .from(deployment)
            .where(sql`${deployment.meta}->>'clusterRuntimeId' = ${runtime.id}`);
          if (bound || release)
            throw conflict(
              "Projects or retained releases still use this Swarm connection. Remove those projects before disconnecting it.",
            );
        }
        if (runtime && runtime.provider !== "swarm" && runtime.status !== "removed")
          throw new AppError(
            "Remove the cluster runtime first so OpenShip can clean up its installation on every server.",
            409,
            "CLUSTER_RUNTIME_IN_USE",
          );
        if (runtime) await tx.delete(clusterRuntime).where(eq(clusterRuntime.id, runtime.id));
        await tx.delete(computeCluster).where(owned(org, id));
      });
    },
  };
}
export type ComputeClusterRecord = Awaited<
  ReturnType<ReturnType<typeof createComputeClusterRepo>["get"]>
>;
