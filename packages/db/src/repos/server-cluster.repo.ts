import { and, desc, eq, gt, inArray, isNull, lte, ne, or, sql, type SQL } from "drizzle-orm";
import {
  AppError,
  NotFoundError,
  NETWORK_CHECK_DEADLINE_MS,
  MANAGED_NETWORK_LEASE_MS,
  infrastructureCidr,
  networkReportSucceeded,
  nativeNetworkSource,
  managedNetworkInProgress,
  type NativeClusterConfig,
  type ClusterNetworkReport,
  type ClusterSpeedTest,
  type InfrastructureClusterConfig,
  type ManagedNetworkPlan,
  type ManagedNetworkHostProgress,
  type ManagedNetworkOperationStatus,
} from "@repo/core";
import type { Database, DatabaseTransaction } from "../client";
import { hashStringToInt } from "../advisory-lock-factory";
import {
  serverCluster,
  clusterNetwork,
  clusterMember,
  serverNetworkAttachment,
  clusterVerification,
  managedNetworkOperation,
  managedNetworkPreparation,
  managedNetworkClaim,
  organization,
  servers,
} from "../schema";
import { discardNetworkSetup } from "./network-setup-discard";
import { assertNetworkDependencies } from "./compute-cluster.repo";

export type ClusterVerificationRecord = typeof clusterVerification.$inferSelect;
export type ManagedNetworkOperationRecord = typeof managedNetworkOperation.$inferSelect;
export type ServerClusterRecord = Awaited<
  ReturnType<ReturnType<typeof createServerClusterRepo>["get"]>
>;
const conflict = (message: string) => new AppError(message, 409, "CLUSTER_CONFLICT");
const runningStates: ManagedNetworkOperationStatus[] = [
  "applying",
  "verifying",
  "committing",
  "rolling_back",
];
const unsettledStates: ManagedNetworkOperationStatus[] = [
  ...runningStates,
  "interrupted",
  "needs_attention",
];

export function createServerClusterRepo(db: Database) {
  const owned = (org: string, id: string) =>
    and(eq(serverCluster.id, id), eq(serverCluster.organizationId, org));

  async function lockHostIdentities(tx: DatabaseTransaction, identities: string[]) {
    // Membership and pending claims have separate unique indexes. Serialize
    // ownership changes across both tables (and organizations) on this same
    // transaction connection, before taking any cluster row lock.
    const keys = [...new Set(identities.map((id) => hashStringToInt(`cluster-host:${id}`)))];
    for (const key of keys.sort((a, b) => a - b))
      await tx.execute(sql`select pg_advisory_xact_lock(${key})`);
  }

  async function interruptVerification(
    tx: Database | DatabaseTransaction,
    condition: SQL | undefined,
    error: string,
  ) {
    const rows = await tx
      .update(clusterVerification)
      .set({
        status: "interrupted",
        finishedAt: new Date(),
        error,
      })
      .where(and(eq(clusterVerification.status, "running"), condition))
      .returning();
    return rows.map(({ id, clusterId }) => ({ id, clusterId }));
  }

  async function expire(tx: Database | DatabaseTransaction, clusterId: string) {
    await interruptVerification(
      tx,
      and(
        eq(clusterVerification.clusterId, clusterId),
        lte(clusterVerification.expiresAt, new Date()),
      ),
      "Verification was interrupted. Run it again.",
    );
  }

  async function lock(tx: DatabaseTransaction, org: string, id: string, revision: number) {
    const [row] = await tx.select().from(serverCluster).where(owned(org, id)).for("update");
    if (!row) throw new NotFoundError("Network", id);
    if (row.revision !== revision)
      throw conflict("The network changed. Reload it before continuing.");
    await expire(tx, id);
    return row;
  }

  async function assertIdle(tx: DatabaseTransaction, id: string, exceptOperation?: string) {
    const [active] = await tx
      .select()
      .from(clusterVerification)
      .where(and(eq(clusterVerification.clusterId, id), eq(clusterVerification.status, "running")));
    if (active) throw conflict("Network verification is still running.");
    const [operation] = await tx
      .select()
      .from(managedNetworkOperation)
      .where(
        and(
          eq(managedNetworkOperation.clusterId, id),
          inArray(managedNetworkOperation.status, unsettledStates),
          exceptOperation ? ne(managedNetworkOperation.id, exceptOperation) : undefined,
        ),
      );
    if (operation) throw conflict("Finish or restore the current managed network operation first.");
  }

  async function nativeOnly(tx: DatabaseTransaction, id: string) {
    const [network] = await tx
      .select()
      .from(clusterNetwork)
      .where(eq(clusterNetwork.clusterId, id));
    if (network?.mode !== "native")
      throw conflict("Managed networks require a reviewed network operation.");
  }

  async function assertMembers(
    tx: DatabaseTransaction,
    org: string,
    config: Pick<NativeClusterConfig, "members">,
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
    const claims = await tx
      .select()
      .from(managedNetworkClaim)
      .where(
        inArray(
          managedNetworkClaim.serverId,
          config.members.map((m) => m.serverId),
        ),
      );
    if (claims.some((claim) => claim.clusterId !== existingId))
      throw conflict("A selected server is reserved by a managed network operation.");
  }

  async function get(org: string, id: string) {
    await expireManaged(db, org, id);
    return db.transaction(async (tx) => {
      const [row] = await tx.select().from(serverCluster).where(owned(org, id)).for("share");
      if (!row) throw new NotFoundError("Network", id);
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
      const [operation] = await tx
        .select()
        .from(managedNetworkOperation)
        .where(
          and(
            eq(managedNetworkOperation.organizationId, org),
            eq(managedNetworkOperation.clusterId, id),
            ne(managedNetworkOperation.status, "planned"),
            ne(managedNetworkOperation.status, "cancelled"),
          ),
        )
        .orderBy(desc(managedNetworkOperation.createdAt))
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
        operation: operation ?? null,
      };
    });
  }

  async function writeMembers(
    tx: DatabaseTransaction,
    id: string,
    networkId: string,
    config: InfrastructureClusterConfig,
    identities = new Map<string, string | null>(),
  ) {
    await tx.insert(clusterMember).values(
      config.members.map((m) => ({
        clusterId: id,
        serverId: m.serverId,
        hostIdentity: identities.get(m.serverId) ?? null,
      })),
    );
    await tx.insert(serverNetworkAttachment).values(
      config.members.map((m) => ({
        networkId,
        ...m,
        interfaceName: m.interfaceName || null,
        networkRef: m.networkRef || null,
      })),
    );
  }

  async function interruptOperation(
    tx: Database | DatabaseTransaction,
    condition: SQL | undefined,
    error: string,
  ) {
    const rows = await tx
      .update(managedNetworkOperation)
      .set({
        status: "interrupted",
        sequence: sql`${managedNetworkOperation.sequence} + 1`,
        leaseExpiresAt: null,
        error,
        updatedAt: new Date(),
      })
      .where(and(inArray(managedNetworkOperation.status, runningStates), condition))
      .returning();
    return rows.map(({ id, organizationId }) => ({ id, organizationId }));
  }
  const expiredManagedLease = () =>
    or(
      isNull(managedNetworkOperation.leaseExpiresAt),
      lte(managedNetworkOperation.leaseExpiresAt, new Date()),
    );
  async function expireManaged(
    tx: Database | DatabaseTransaction,
    org: string,
    clusterId?: string,
  ) {
    await interruptOperation(
      tx,
      and(
        eq(managedNetworkOperation.organizationId, org),
        clusterId ? eq(managedNetworkOperation.clusterId, clusterId) : undefined,
        expiredManagedLease(),
      ),
      "The controller stopped reporting progress. Resume or restore this operation; each host also has a local rollback deadline.",
    );
  }

  async function getOperation(org: string, id: string) {
    await expireManaged(db, org);
    const [operation] = await db
      .select()
      .from(managedNetworkOperation)
      .where(
        and(eq(managedNetworkOperation.id, id), eq(managedNetworkOperation.organizationId, org)),
      );
    if (!operation) throw new NotFoundError("Network operation", id);
    return operation;
  }

  function worker(id: string, generation: number) {
    return and(
      eq(managedNetworkOperation.id, id),
      eq(managedNetworkOperation.generation, generation),
      inArray(managedNetworkOperation.status, runningStates),
      gt(managedNetworkOperation.leaseExpiresAt, new Date()),
    );
  }

  return {
    get,
    /** Never expire another live controller's work on a shared PostgreSQL database. */
    async recoverInterrupted(exclusive: boolean) {
      return db.transaction(async (tx) => {
        const operations = await interruptOperation(
          tx,
          exclusive ? undefined : expiredManagedLease(),
          exclusive
            ? "OpenShip restarted before network setup finished. Resume or restore this operation to check the host recovery state; host rollback timers run independently."
            : "The controller stopped reporting progress. Resume or restore this operation; each host also has a local rollback deadline.",
        );
        const interrupted = await interruptVerification(
          tx,
          exclusive ? undefined : lte(clusterVerification.expiresAt, new Date()),
          exclusive
            ? "OpenShip restarted during network verification. Run the checks again."
            : "Verification was interrupted. Run it again.",
        );
        const verifications = interrupted.length
          ? await tx
              .select({ organizationId: serverCluster.organizationId })
              .from(serverCluster)
              .where(
                inArray(
                  serverCluster.id,
                  interrupted.map((run) => run.clusterId),
                ),
              )
          : [];
        return { operations, verifications };
      });
    },
    async interruptOperation(id: string, generation: number, error: string) {
      return interruptOperation(
        db,
        and(eq(managedNetworkOperation.id, id), eq(managedNetworkOperation.generation, generation)),
        error,
      );
    },
    async interruptVerification(id: string, error: string) {
      return interruptVerification(db, eq(clusterVerification.id, id), error);
    },
    async list(org: string) {
      const rows = await db
        .select({ id: serverCluster.id })
        .from(serverCluster)
        .where(eq(serverCluster.organizationId, org))
        .orderBy(desc(serverCluster.createdAt));
      return Promise.all(rows.map((row) => get(org, row.id)));
    },
    async hasManagedNetworkState(org: string): Promise<boolean> {
      // The deletion trigger uses this same predicate, closing the race between
      // the friendly auth preflight and Better Auth's subsequent DELETE.
      const [row] = await db
        .select({ active: sql<boolean>`openship_has_managed_network_state(${org})` })
        .from(organization)
        .where(eq(organization.id, org));
      return row?.active ?? false;
    },
    async membership(serverId: string, reservationsOnly = false) {
      const [row] = await db
        .select()
        .from(clusterMember)
        .where(eq(clusterMember.serverId, serverId));
      if (row && !reservationsOnly) return row;
      const [claim] = await db
        .select()
        .from(managedNetworkClaim)
        .where(eq(managedNetworkClaim.serverId, serverId));
      return claim
        ? {
            id: claim.operationId,
            clusterId: claim.clusterId,
            serverId: claim.serverId,
            hostIdentity: claim.hostIdentity,
          }
        : null;
    },
    assertDependencies: (org: string, id: string, serverIds?: string[]) =>
      assertNetworkDependencies(db, org, id, serverIds),
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
          .values({ clusterId: created.id, ...config.network, source: nativeNetworkSource(config) })
          .returning();
        await writeMembers(tx, created.id, network!.id, config);
        return created.id;
      });
      return get(org, id);
    },
    async update(org: string, id: string, revision: number, config: NativeClusterConfig) {
      await db.transaction(async (tx) => {
        await lock(tx, org, id, revision);
        await nativeOnly(tx, id);
        await assertIdle(tx, id);
        await assertMembers(tx, org, config, id);
        await assertNetworkDependencies(tx, org, id, config.members.map((member) => member.serverId));
        const members = await tx
          .select()
          .from(clusterMember)
          .where(eq(clusterMember.clusterId, id));
        const [network] = await tx
          .update(clusterNetwork)
          .set({ ...config.network, source: nativeNetworkSource(config) })
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
        await nativeOnly(tx, id);
        await assertIdle(tx, id);
        await assertNetworkDependencies(tx, org, id);
        // Native networks are externally owned. This removes inventory only.
        await tx.delete(serverCluster).where(owned(org, id));
      });
    },
    async startVerification(
      org: string,
      id: string,
      revision: number,
      createdBy: string,
      speedTest?: ClusterSpeedTest,
    ) {
      return db.transaction(async (tx) => {
        await lock(tx, org, id, revision);
        if (speedTest) {
          const members = await tx
            .select({ serverId: clusterMember.serverId })
            .from(clusterMember)
            .where(eq(clusterMember.clusterId, id));
          if (
            speedTest.sourceServerId === speedTest.targetServerId ||
            ![speedTest.sourceServerId, speedTest.targetServerId].every((serverId) =>
              members.some((member) => member.serverId === serverId),
            )
          )
            throw conflict("Choose two different members of this network for the speed test.");
        }
        const [active] = await tx
          .select()
          .from(clusterVerification)
          .where(
            and(eq(clusterVerification.clusterId, id), eq(clusterVerification.status, "running")),
          );
        if (active) {
          const pair = (value?: ClusterSpeedTest) =>
            value ? JSON.stringify([value.sourceServerId, value.targetServerId].sort()) : null;
          if (pair(active.report.speedTest) !== pair(speedTest))
            throw conflict(
              "Another network test is running. Wait for its results before starting a different test.",
            );
          return { run: active, created: false };
        }
        await assertIdle(tx, id);
        const [run] = await tx
          .insert(clusterVerification)
          .values({
            clusterId: id,
            revision,
            createdBy,
            status: "running",
            expiresAt: new Date(Date.now() + NETWORK_CHECK_DEADLINE_MS),
            report: {
              stage: "inspecting",
              hosts: [],
              peers: [],
              ...(speedTest ? { speedTest, throughput: [] } : {}),
            },
          })
          .returning();
        return { run: run!, created: true };
      });
    },
    async recordIdentity(clusterId: string, serverId: string, identity: string, runId: string) {
      try {
        await db.transaction(async (tx) => {
          await lockHostIdentities(tx, [identity]);
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
            .where(and(eq(clusterMember.hostIdentity, identity), ne(clusterMember.serverId, serverId)));
          if (other)
            throw conflict(
              "This physical server is already enrolled through another server entry.",
            );
          const [claim] = await tx
            .select()
            .from(managedNetworkClaim)
            .where(eq(managedNetworkClaim.hostIdentity, identity));
          if (claim && (claim.clusterId !== clusterId || claim.serverId !== serverId))
            throw conflict("This physical server is reserved by a managed network operation.");
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

    getOperation,
    async discardPlan(org: string, id: string, planHash: string) {
      return discardNetworkSetup(db, org, { operationId: id, planHash });
    },
    async findOperation(org: string, id: string) {
      const [operation] = await db
        .select()
        .from(managedNetworkOperation)
        .where(
          and(eq(managedNetworkOperation.id, id), eq(managedNetworkOperation.organizationId, org)),
        );
      return operation ?? null;
    },
    async savePlan(
      org: string,
      id: string,
      createdBy: string,
      inputHash: string,
      planHash: string,
      plan: ManagedNetworkPlan,
      preparationGeneration?: number,
    ) {
      await db.transaction(async (tx) => {
        const [preparation] = await tx
          .select()
          .from(managedNetworkPreparation)
          .where(
            and(
              eq(managedNetworkPreparation.organizationId, org),
              eq(managedNetworkPreparation.id, plan.preparationId ?? id),
            ),
          )
          .for("update");
        if (preparation?.status === "cancelled")
          throw conflict("This setup was discarded. Start a new setup to review a network plan.");
        if (
          plan.preparationId &&
          (!preparation ||
            preparation.status !== "preparing" ||
            preparation.generation !== preparationGeneration ||
            !preparation.leaseExpiresAt ||
            preparation.leaseExpiresAt.getTime() <= Date.now())
        )
          throw conflict("This worker no longer owns server preparation.");
        await tx
          .insert(managedNetworkOperation)
          .values({
            id,
            organizationId: org,
            clusterId: plan.clusterId,
            createdBy,
            inputHash,
            planHash,
            plan,
            status: "planned",
            hosts: plan.hosts.map((host) => ({
              serverId: host.serverId,
              stage: "pending",
              publicKey: null,
              error: null,
            })),
          })
          .onConflictDoNothing();
      });
      const operation = await getOperation(org, id);
      if (operation.inputHash !== inputHash)
        throw conflict("This plan request was already used for different settings.");
      return operation;
    },
    async claimOperation(
      org: string,
      id: string,
      planHash: string,
      action: "apply" | "resume" | "rollback",
    ) {
      return db.transaction(async (tx) => {
        await expireManaged(tx, org);
        const [operation] = await tx
          .select()
          .from(managedNetworkOperation)
          .where(
            and(
              eq(managedNetworkOperation.id, id),
              eq(managedNetworkOperation.organizationId, org),
            ),
          )
          .for("update");
        if (!operation) throw new NotFoundError("Network operation", id);
        if (operation.planHash !== planHash)
          throw conflict("The reviewed plan changed. Review it again.");
        if (operation.replacementPreparationId && action !== "rollback")
          throw conflict(
            "This server selection has changed. Finish cleanup and open the updated setup.",
          );
        if (managedNetworkInProgress(operation.status)) return { operation, started: false };
        if (
          operation.status === "succeeded" ||
          operation.status === "rolled_back" ||
          operation.status === "cancelled"
        )
          return { operation, started: false };
        const plan = operation.plan;
        if (operation.status === "planned") {
          if (action !== "apply") throw conflict("Apply the reviewed plan first.");
          if (new Date(plan.expiresAt).getTime() <= Date.now())
            throw conflict("This plan expired. Inspect the servers and review a new plan.");
        } else if (action === "apply")
          throw conflict("This operation needs an explicit resume or restore action.");
        if (new Set(plan.hosts.map((host) => host.hostIdentity)).size !== plan.hosts.length)
          throw conflict("Two server entries point to the same physical host.");
        await lockHostIdentities(
          tx,
          plan.hosts.map((host) => host.hostIdentity),
        );
        for (const host of plan.hosts) {
          const memberships = await tx
            .select()
            .from(clusterMember)
            .where(
              or(
                eq(clusterMember.hostIdentity, host.hostIdentity),
                eq(clusterMember.serverId, host.serverId),
              ),
            );
          if (
            memberships.some(
              (member) =>
                member.serverId !== host.serverId ||
                (member.hostIdentity && member.hostIdentity !== host.hostIdentity),
            )
          )
            throw conflict(
              "A server identity changed or is enrolled through another server entry.",
            );
        }
        if (action !== "rollback" && plan.intent !== "remove") {
          const otherNetworks = await tx
            .select({ cidrs: clusterNetwork.cidrs })
            .from(clusterNetwork)
            .innerJoin(serverCluster, eq(serverCluster.id, clusterNetwork.clusterId))
            .where(
              and(eq(serverCluster.organizationId, org), ne(serverCluster.id, plan.clusterId)),
            );
          const ranges = plan.config.network.cidrs.map(infrastructureCidr);
          if (
            otherNetworks.some((network) =>
              network.cidrs
                .map(infrastructureCidr)
                .some(
                  (other) =>
                    other &&
                    ranges.some(
                      (range) => range && range.start <= other.end && other.start <= range.end,
                    ),
                ),
            )
          )
            throw conflict(
              "Another network reserved this range after planning. Inspect and review a new plan.",
            );
        }
        if (plan.baseRevision !== null) {
          await lock(tx, org, plan.clusterId, plan.baseRevision);
        } else {
          const [existing] = await tx
            .select()
            .from(serverCluster)
            .where(owned(org, plan.clusterId))
            .for("update");
          if (!existing) {
            await tx.insert(serverCluster).values({
              id: plan.clusterId,
              organizationId: org,
              name: plan.config.name,
              location: plan.config.location || null,
              requestId: operation.id,
              inputHash: operation.inputHash,
            });
            await assertMembers(tx, org, plan.config);
            const [network] = await tx
              .insert(clusterNetwork)
              .values({ clusterId: plan.clusterId, ...plan.config.network, ownership: "openship" })
              .returning();
            await writeMembers(
              tx,
              plan.clusterId,
              network!.id,
              plan.config,
              new Map(plan.hosts.map((host) => [host.serverId, host.hostIdentity])),
            );
          } else if (existing.requestId !== operation.id || existing.revision !== 1)
            throw conflict("The network changed after planning.");
        }
        await assertIdle(tx, plan.clusterId, operation.id);
        if (action !== "rollback")
          await assertNetworkDependencies(tx, org, plan.clusterId, plan.intent === "remove" ? undefined : plan.config.members.map((member) => member.serverId));
        // Keep former members reserved until their owned network has been removed.
        const allMembers = plan.hosts.map((host) => ({
          ...(plan.config.members.find((member) => member.serverId === host.serverId) ??
            plan.previous!.members.find((member) => member.serverId === host.serverId)!),
          serverId: host.serverId,
        }));
        await assertMembers(tx, org, { members: allMembers }, plan.clusterId);
        for (const host of [...plan.hosts].sort((a, b) => a.serverId.localeCompare(b.serverId))) {
          const [claim] = await tx
            .select()
            .from(managedNetworkClaim)
            .where(
              or(
                eq(managedNetworkClaim.serverId, host.serverId),
                eq(managedNetworkClaim.hostIdentity, host.hostIdentity),
              ),
            );
          if (claim && (claim.operationId !== operation.id || claim.serverId !== host.serverId))
            throw conflict("A server is already reserved by another network operation.");
          if (!claim)
            await tx.insert(managedNetworkClaim).values({
              organizationId: org,
              clusterId: plan.clusterId,
              operationId: id,
              serverId: host.serverId,
              hostIdentity: host.hostIdentity,
            });
        }
        const [claimed] = await tx
          .update(managedNetworkOperation)
          .set({
            status: action === "rollback" ? "rolling_back" : "applying",
            generation: operation.generation + 1,
            sequence: sql`${managedNetworkOperation.sequence} + 1`,
            leaseExpiresAt: new Date(Date.now() + MANAGED_NETWORK_LEASE_MS),
            error: null,
            updatedAt: new Date(),
          })
          .where(eq(managedNetworkOperation.id, id))
          .returning();
        return { operation: claimed!, started: true };
      });
    },
    async heartbeatOperation(id: string, generation: number) {
      const [row] = await db
        .update(managedNetworkOperation)
        .set({
          leaseExpiresAt: new Date(Date.now() + MANAGED_NETWORK_LEASE_MS),
          updatedAt: new Date(),
        })
        .where(worker(id, generation))
        .returning();
      return !!row;
    },
    async operationActive(id: string, generation: number) {
      const [row] = await db
        .select({ id: managedNetworkOperation.id })
        .from(managedNetworkOperation)
        .where(worker(id, generation));
      return !!row;
    },
    async progressOperation(
      id: string,
      generation: number,
      status: ManagedNetworkOperationStatus,
      hosts: ManagedNetworkHostProgress[],
      report?: ClusterNetworkReport | null,
      error?: string | null,
    ) {
      if (!unsettledStates.includes(status))
        throw conflict(
          "Terminal network outcomes require a complete host acknowledgement transaction.",
        );
      const [row] = await db
        .update(managedNetworkOperation)
        .set({
          status,
          hosts,
          sequence: sql`${managedNetworkOperation.sequence} + 1`,
          ...(report !== undefined ? { report } : {}),
          ...(error !== undefined ? { error } : {}),
          updatedAt: new Date(),
          ...(!managedNetworkInProgress(status) ? { leaseExpiresAt: null } : {}),
        })
        .where(worker(id, generation))
        .returning();
      if (!row) throw conflict("This network worker no longer owns the operation.");
    },
    async finishOperation(
      org: string,
      id: string,
      generation: number,
      outcome: "succeeded" | "rolled_back",
      hosts: ManagedNetworkHostProgress[],
      report: ClusterNetworkReport | null,
      error: string | null,
    ) {
      await db.transaction(async (tx) => {
        const [operation] = await tx
          .select()
          .from(managedNetworkOperation)
          .where(and(worker(id, generation), eq(managedNetworkOperation.organizationId, org)))
          .for("update");
        if (!operation) throw conflict("This network worker no longer owns the operation.");
        const plan = operation.plan;
        await lockHostIdentities(
          tx,
          plan.hosts.map((host) => host.hostIdentity),
        );
        const expected = outcome === "succeeded" ? "committed" : "rolled_back";
        if (
          hosts.length !== plan.hosts.length ||
          hosts.some(
            (host) =>
              host.stage !== expected ||
              !plan.hosts.some((planned) => planned.serverId === host.serverId),
          ) ||
          new Set(hosts.map((host) => host.serverId)).size !== plan.hosts.length
        )
          throw conflict(
            "Every server must acknowledge the network outcome before membership is released.",
          );
        if (outcome === "succeeded" && plan.intent === "configure") {
          const revision = plan.baseRevision === null ? 1 : plan.baseRevision + 1;
          const config = {
            ...plan.config,
            members: plan.config.members.map((member) => ({
              ...member,
              publicKey: hosts.find((host) => host.serverId === member.serverId)!.publicKey!,
            })),
          };
          if (config.members.some((member) => !member.publicKey))
            throw conflict("Each member needs its host-generated public key.");
          const [network] = await tx
            .update(clusterNetwork)
            .set({ ...config.network, source: null, ownership: "openship" })
            .where(eq(clusterNetwork.clusterId, plan.clusterId))
            .returning();
          if (!network) throw conflict("The cluster network is missing.");
          await tx
            .delete(serverNetworkAttachment)
            .where(eq(serverNetworkAttachment.networkId, network.id));
          await tx.delete(clusterMember).where(eq(clusterMember.clusterId, plan.clusterId));
          await writeMembers(
            tx,
            plan.clusterId,
            network.id,
            config,
            new Map(plan.hosts.map((host) => [host.serverId, host.hostIdentity])),
          );
          await tx
            .update(serverCluster)
            .set({
              name: config.name,
              location: config.location || null,
              revision,
              updatedAt: new Date(),
            })
            .where(owned(org, plan.clusterId));
          if (
            !report ||
            report.stage !== "complete" ||
            !networkReportSucceeded(
              report,
              config.members.map((member) => member.serverId),
              config.network.access,
            )
          )
            throw conflict("A managed network needs a successful, complete connectivity report.");
          await tx.insert(clusterVerification).values({
            clusterId: plan.clusterId,
            revision,
            createdBy: operation.createdBy,
            status: "succeeded",
            report,
            finishedAt: new Date(),
            expiresAt: new Date(Date.now() + NETWORK_CHECK_DEADLINE_MS),
          });
        }
        await tx.delete(managedNetworkClaim).where(eq(managedNetworkClaim.operationId, id));
        if (
          (outcome === "succeeded" && plan.intent === "remove") ||
          (outcome === "rolled_back" && plan.baseRevision === null)
        )
          await tx.delete(serverCluster).where(owned(org, plan.clusterId));
        await tx
          .update(managedNetworkOperation)
          .set({
            status: outcome,
            sequence: sql`${managedNetworkOperation.sequence} + 1`,
            hosts,
            report,
            error,
            leaseExpiresAt: null,
            updatedAt: new Date(),
          })
          .where(eq(managedNetworkOperation.id, id));
      });
      return getOperation(org, id);
    },
  };
}
