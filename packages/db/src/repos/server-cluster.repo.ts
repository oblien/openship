import { and, desc, eq, gt, inArray, lte } from "drizzle-orm";
import {
  AppError,
  NotFoundError,
  NETWORK_CHECK_DEADLINE_MS,
  type NativeClusterConfig,
  type ClusterNetworkReport,
} from "@repo/core";
import type { Database, DatabaseTransaction } from "../client";
import {
  serverCluster,
  clusterNetwork,
  clusterMember,
  serverNetworkAttachment,
  clusterVerification,
  servers,
} from "../schema";

export type ClusterVerificationRecord = typeof clusterVerification.$inferSelect;
export type ServerClusterRecord = Awaited<
  ReturnType<ReturnType<typeof createServerClusterRepo>["get"]>
>;
const conflict = (message: string) => new AppError(message, 409, "CLUSTER_CONFLICT");

export function createServerClusterRepo(db: Database) {
  const owned = (org: string, id: string) =>
    and(eq(serverCluster.id, id), eq(serverCluster.organizationId, org));

  async function expire(tx: Database | DatabaseTransaction, clusterId: string) {
    await tx
      .update(clusterVerification)
      .set({
        status: "interrupted",
        finishedAt: new Date(),
        error: "Verification was interrupted. Run it again.",
      })
      .where(
        and(
          eq(clusterVerification.clusterId, clusterId),
          eq(clusterVerification.status, "running"),
          lte(clusterVerification.expiresAt, new Date()),
        ),
      );
  }

  async function lock(tx: DatabaseTransaction, org: string, id: string, revision: number) {
    const [row] = await tx.select().from(serverCluster).where(owned(org, id)).for("update");
    if (!row) throw new NotFoundError("Cluster", id);
    if (row.revision !== revision)
      throw conflict("The cluster changed. Reload it before continuing.");
    await expire(tx, id);
    return row;
  }

  async function assertIdle(tx: DatabaseTransaction, id: string) {
    const [active] = await tx
      .select()
      .from(clusterVerification)
      .where(and(eq(clusterVerification.clusterId, id), eq(clusterVerification.status, "running")));
    if (active) throw conflict("Network verification is still running.");
  }

  async function assertMembers(
    tx: DatabaseTransaction,
    org: string,
    config: NativeClusterConfig,
    existingId?: string,
  ) {
    // Lock inventory rows too: deletion must not race enrollment. NO ACTION
    // blocks server removal but allows a whole organization to cascade together.
    const found = await tx
      .select({ id: servers.id })
      .from(servers)
      .where(
        and(
          eq(servers.organizationId, org),
          inArray(servers.id, config.members.map((m) => m.serverId).sort()),
        ),
      )
      .orderBy(servers.id)
      .for("update");
    if (found.length !== config.members.length) throw new NotFoundError("Server");
    const memberships = await tx
      .select()
      .from(clusterMember)
      .where(
        inArray(
          clusterMember.serverId,
          config.members.map((m) => m.serverId),
        ),
      );
    if (memberships.some((m) => m.clusterId !== existingId))
      throw conflict("A selected server already belongs to a cluster.");
  }

  async function get(org: string, id: string) {
    return db.transaction(async (tx) => {
      const [row] = await tx.select().from(serverCluster).where(owned(org, id)).for("share");
      if (!row) throw new NotFoundError("Cluster", id);
      await expire(tx, id);
      const [network] = await tx
        .select()
        .from(clusterNetwork)
        .where(eq(clusterNetwork.clusterId, id));
      if (!network) throw new AppError("Cluster network is missing", 500, "CLUSTER_STATE_INVALID");
      const members = await tx
        .select({
          member: clusterMember,
          attachment: serverNetworkAttachment,
          name: servers.name,
          host: servers.sshHost,
        })
        .from(clusterMember)
        .innerJoin(servers, eq(servers.id, clusterMember.serverId))
        .innerJoin(
          serverNetworkAttachment,
          and(
            eq(serverNetworkAttachment.serverId, clusterMember.serverId),
            eq(serverNetworkAttachment.networkId, network.id),
          ),
        )
        .where(eq(clusterMember.clusterId, id))
        .orderBy(clusterMember.serverId);
      const [verification] = await tx
        .select()
        .from(clusterVerification)
        .where(
          and(
            eq(clusterVerification.clusterId, id),
            eq(clusterVerification.revision, row.revision),
          ),
        )
        .orderBy(desc(clusterVerification.startedAt), desc(clusterVerification.id))
        .limit(1);
      return {
        ...row,
        network,
        members: members.map(({ member, attachment, name, host }) => ({
          ...attachment,
          ...member,
          name: name || host,
        })),
        verification: verification ?? null,
      };
    });
  }

  async function writeMembers(
    tx: DatabaseTransaction,
    id: string,
    networkId: string,
    config: NativeClusterConfig,
    identities = new Map<string, string | null>(),
  ) {
    await tx.insert(clusterMember).values(
      config.members.map((m) => ({
        clusterId: id,
        serverId: m.serverId,
        hostIdentity: identities.get(m.serverId) ?? null,
      })),
    );
    await tx
      .insert(serverNetworkAttachment)
      .values(
        config.members.map((m) => ({
          networkId,
          ...m,
          interfaceName: m.interfaceName || null,
          networkRef: m.networkRef || null,
        })),
      );
  }

  return {
    get,
    async list(org: string) {
      const rows = await db
        .select({ id: serverCluster.id })
        .from(serverCluster)
        .where(eq(serverCluster.organizationId, org))
        .orderBy(desc(serverCluster.createdAt));
      return Promise.all(rows.map((row) => get(org, row.id)));
    },
    async membership(serverId: string) {
      const [row] = await db
        .select()
        .from(clusterMember)
        .where(eq(clusterMember.serverId, serverId));
      return row ?? null;
    },
    async create(org: string, config: NativeClusterConfig, requestId: string, inputHash: string) {
      const id = await db.transaction(async (tx) => {
        const [created] = await tx
          .insert(serverCluster)
          .values({
            organizationId: org,
            name: config.name,
            location: config.location || null,
            requestId,
            inputHash,
          })
          .onConflictDoNothing({ target: [serverCluster.organizationId, serverCluster.requestId] })
          .returning();
        if (!created) {
          const [existing] = await tx
            .select()
            .from(serverCluster)
            .where(
              and(eq(serverCluster.organizationId, org), eq(serverCluster.requestId, requestId)),
            );
          if (!existing || existing.inputHash !== inputHash)
            throw conflict("This creation request was already used for different settings.");
          return existing.id;
        }
        await assertMembers(tx, org, config);
        const [network] = await tx
          .insert(clusterNetwork)
          .values({ clusterId: created.id, ...config.network })
          .returning();
        await writeMembers(tx, created.id, network!.id, config);
        return created.id;
      });
      return get(org, id);
    },
    async update(org: string, id: string, revision: number, config: NativeClusterConfig) {
      await db.transaction(async (tx) => {
        await lock(tx, org, id, revision);
        await assertIdle(tx, id);
        await assertMembers(tx, org, config, id);
        const members = await tx
          .select()
          .from(clusterMember)
          .where(eq(clusterMember.clusterId, id));
        const [network] = await tx
          .update(clusterNetwork)
          .set(config.network)
          .where(eq(clusterNetwork.clusterId, id))
          .returning();
        await tx
          .delete(serverNetworkAttachment)
          .where(eq(serverNetworkAttachment.networkId, network!.id));
        await tx.delete(clusterMember).where(eq(clusterMember.clusterId, id));
        await writeMembers(
          tx,
          id,
          network!.id,
          config,
          new Map(members.map((m) => [m.serverId, m.hostIdentity])),
        );
        await tx
          .update(serverCluster)
          .set({
            name: config.name,
            location: config.location || null,
            revision: revision + 1,
            updatedAt: new Date(),
          })
          .where(owned(org, id));
      });
      return get(org, id);
    },
    async remove(org: string, id: string, revision: number) {
      await db.transaction(async (tx) => {
        await lock(tx, org, id, revision);
        await assertIdle(tx, id);
        // Native networks are externally owned. This removes inventory only.
        await tx.delete(serverCluster).where(owned(org, id));
      });
    },
    async startVerification(org: string, id: string, revision: number, createdBy: string) {
      return db.transaction(async (tx) => {
        await lock(tx, org, id, revision);
        const [active] = await tx
          .select()
          .from(clusterVerification)
          .where(
            and(eq(clusterVerification.clusterId, id), eq(clusterVerification.status, "running")),
          );
        if (active) return { run: active, created: false };
        const [run] = await tx
          .insert(clusterVerification)
          .values({
            clusterId: id,
            revision,
            createdBy,
            status: "running",
            expiresAt: new Date(Date.now() + NETWORK_CHECK_DEADLINE_MS),
            report: { stage: "inspecting", hosts: [], peers: [] },
          })
          .returning();
        return { run: run!, created: true };
      });
    },
    async recordIdentity(clusterId: string, serverId: string, identity: string, runId: string) {
      try {
        await db.transaction(async (tx) => {
          const [cluster] = await tx
            .select()
            .from(serverCluster)
            .where(eq(serverCluster.id, clusterId))
            .for("update");
          const [run] = await tx
            .select()
            .from(clusterVerification)
            .where(
              and(
                eq(clusterVerification.id, runId),
                eq(clusterVerification.clusterId, clusterId),
                eq(clusterVerification.status, "running"),
                gt(clusterVerification.expiresAt, new Date()),
              ),
            );
          if (!cluster || !run || run.revision !== cluster.revision)
            throw conflict("Verification is no longer active. Run it again.");
          const [member] = await tx
            .select()
            .from(clusterMember)
            .where(
              and(eq(clusterMember.clusterId, clusterId), eq(clusterMember.serverId, serverId)),
            );
          if (member?.hostIdentity && member.hostIdentity !== identity)
            throw conflict(
              "This server's physical identity changed. Remove and re-enroll its server entry after reviewing the SSH target.",
            );
          const [other] = await tx
            .select()
            .from(clusterMember)
            .where(eq(clusterMember.hostIdentity, identity));
          if (other && other.id !== member?.id)
            throw conflict(
              "This physical server is already enrolled through another server entry.",
            );
          await tx
            .update(clusterMember)
            .set({ hostIdentity: identity })
            .where(
              and(eq(clusterMember.clusterId, clusterId), eq(clusterMember.serverId, serverId)),
            );
        });
      } catch (error) {
        if (
          (error as { cause?: { code?: string }; code?: string }).code === "23505" ||
          (error as { cause?: { code?: string } }).cause?.code === "23505"
        )
          throw conflict("This physical server is already enrolled through another server entry.");
        throw error;
      }
    },
    async progress(id: string, report: ClusterNetworkReport) {
      const [updated] = await db
        .update(clusterVerification)
        .set({ report })
        .where(
          and(
            eq(clusterVerification.id, id),
            eq(clusterVerification.status, "running"),
            gt(clusterVerification.expiresAt, new Date()),
          ),
        )
        .returning();
      return !!updated;
    },
    async finish(id: string, report: ClusterNetworkReport, success: boolean, error: string | null) {
      await db
        .update(clusterVerification)
        .set({ report, status: success ? "succeeded" : "failed", error, finishedAt: new Date() })
        .where(
          and(
            eq(clusterVerification.id, id),
            eq(clusterVerification.status, "running"),
            gt(clusterVerification.expiresAt, new Date()),
          ),
        );
    },
    async active(id: string) {
      const [run] = await db
        .select({ id: clusterVerification.id })
        .from(clusterVerification)
        .where(
          and(
            eq(clusterVerification.id, id),
            eq(clusterVerification.status, "running"),
            gt(clusterVerification.expiresAt, new Date()),
          ),
        );
      return !!run;
    },
  };
}
