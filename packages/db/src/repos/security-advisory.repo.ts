import { and, eq, gt, isNull, isNotNull, lt, ne, lte, or, sql } from "drizzle-orm";
import type { Database } from "../client";
import { advisoryFeed, projectSecurity, securityRefreshAttempt, serverSecurity, securityScanState } from "../schema/security-advisory";
import { servers } from "../schema/servers";
import { project } from "../schema/project";
import { organization } from "../schema/organization";

export function createSecurityAdvisoryRepo(db: Database) {
  return {
    async scanState(organizationId: string) {
      return db.query.securityScanState.findFirst({ where: eq(securityScanState.organizationId, organizationId) });
    },
    async startScan(organizationId: string, startedAt: Date) {
      await db.insert(securityScanState).values({ organizationId, startedAt, status: "running" })
        .onConflictDoUpdate({ target: securityScanState.organizationId, set: { startedAt, finishedAt: null, status: "running" } });
    },
    async finishScan(organizationId: string, startedAt: Date, status: string) {
      await db.update(securityScanState).set({ status, finishedAt: new Date() })
        .where(and(eq(securityScanState.organizationId, organizationId), eq(securityScanState.startedAt, startedAt)));
    },
    async host(serverId: string) {
      return db.query.serverSecurity.findFirst({ where: eq(serverSecurity.serverId, serverId) });
    },
    async hosts(organizationId: string) {
      return db.query.serverSecurity.findMany({ where: eq(serverSecurity.organizationId, organizationId) });
    },
    async hostCandidates(probeKey: string, limit = 20) {
      return db.select({ server: servers }).from(servers)
        .innerJoin(organization, eq(organization.id, servers.organizationId))
        .leftJoin(serverSecurity, eq(serverSecurity.serverId, servers.id))
        .where(and(isNull(servers.workspaceId), eq(servers.purpose, "deployment"),
          eq(organization.securityAdvisoryChecksEnabled, true),
          or(isNull(serverSecurity.checkedAt), isNull(serverSecurity.nextInspectionAt),
            gt(servers.updatedAt, serverSecurity.checkedAt),
            ne(serverSecurity.probeKey, probeKey), lte(serverSecurity.nextInspectionAt, new Date()))))
        .orderBy(sql`${serverSecurity.checkedAt} ASC NULLS FIRST`, servers.id).limit(limit);
    },
    async saveHost(data: typeof serverSecurity.$inferInsert) {
      await db.insert(serverSecurity).values(data).onConflictDoUpdate({ target: serverSecurity.serverId,
        set: data, setWhere: or(isNull(serverSecurity.checkedAt), lte(serverSecurity.checkedAt, sql`excluded.checked_at`)) });
    },
    async checksEnabled(organizationId: string) {
      const row = await db.query.organization.findFirst({
        where: eq(organization.id, organizationId),
        columns: { securityAdvisoryChecksEnabled: true },
      });
      return row?.securityAdvisoryChecksEnabled ?? true;
    },
    async setChecksEnabled(organizationId: string, checksEnabled: boolean) {
      await db.update(organization)
        .set({ securityAdvisoryChecksEnabled: checksEnabled })
        .where(eq(organization.id, organizationId));
    },
    async organizationsForScan(afterId?: string, limit = 100) {
      return db
        .select({ id: organization.id })
        .from(organization)
        .where(afterId ? gt(organization.id, afterId) : undefined)
        .orderBy(organization.id)
        .limit(limit);
    },
    async candidates(feedRevision: number, limit = 100) {
      const rows = await db
        .select({ project })
        .from(project)
        .innerJoin(organization, eq(organization.id, project.organizationId))
        .leftJoin(projectSecurity, eq(projectSecurity.projectId, project.id))
        .where(
          and(
            isNull(project.deletedAt),
            eq(organization.securityAdvisoryChecksEnabled, true),
            isNotNull(project.activeDeploymentId),
            or(
              isNull(projectSecurity.evaluatedAt),
              isNull(projectSecurity.nextInspectionAt),
              lte(projectSecurity.nextInspectionAt, new Date()),
              isNull(projectSecurity.deploymentId),
              lt(projectSecurity.feedRevision, feedRevision),
              ne(projectSecurity.deploymentId, project.activeDeploymentId),
              lt(projectSecurity.evaluatedAt, new Date(Date.now() - 3_600_000)),
            ),
          ),
        )
        .orderBy(sql`${projectSecurity.evaluatedAt} ASC NULLS FIRST`, project.id)
        .limit(limit);
      return rows.map((row) => row.project);
    },
    async evaluated(projectId: string, organizationId: string, feedRevision: number) {
      await db
        .insert(projectSecurity)
        .values({ projectId, organizationId, feedRevision, evaluatedAt: new Date() })
        .onConflictDoUpdate({
          target: projectSecurity.projectId,
          set: { feedRevision, evaluatedAt: new Date() },
        });
    },
    async feed(id: string) {
      return db.query.advisoryFeed.findFirst({ where: eq(advisoryFeed.id, id) });
    },
    async claimFeed(id: string, now: Date, leaseUntil: Date) {
      await db.insert(advisoryFeed).values({ id, nextCheckAt: now }).onConflictDoNothing();
      const rows = await db
        .update(advisoryFeed)
        .set({ leaseUntil })
        .where(
          and(
            eq(advisoryFeed.id, id),
            lte(advisoryFeed.nextCheckAt, now),
            or(isNull(advisoryFeed.leaseUntil), lte(advisoryFeed.leaseUntil, now)),
          ),
        )
        .returning();
      return rows[0];
    },
    async saveFeed(id: string, leaseUntil: Date, data: Partial<typeof advisoryFeed.$inferInsert>) {
      // A late fetch cannot overwrite a newer poll after its lease expires.
      await db
        .update(advisoryFeed)
        .set({ ...data, leaseUntil: null })
        .where(and(eq(advisoryFeed.id, id), eq(advisoryFeed.leaseUntil, leaseUntil)));
    },
    async project(projectId: string) {
      return db.query.projectSecurity.findFirst({
        where: eq(projectSecurity.projectId, projectId),
      });
    },
    async listByOrganization(organizationId: string) {
      return db.query.projectSecurity.findMany({
        where: eq(projectSecurity.organizationId, organizationId),
      });
    },
    async saveInventory(
      projectId: string,
      organizationId: string,
      deploymentId: string,
      inventory: unknown,
      checkedAt: Date,
      nextInspectionAt = new Date(checkedAt.getTime() + 6 * 3_600_000),
      probeFailures = 0,
    ) {
      await db
        .insert(projectSecurity)
        .values({ projectId, organizationId, deploymentId, inventory, checkedAt, nextInspectionAt, probeFailures })
        .onConflictDoUpdate({
          target: projectSecurity.projectId,
          set: { deploymentId, inventory, checkedAt, nextInspectionAt, probeFailures },
          setWhere: or(
            isNull(projectSecurity.checkedAt),
            lte(projectSecurity.checkedAt, sql`excluded.checked_at`),
          ),
        });
    },
    async policy(
      projectId: string,
      organizationId: string,
      approvedBy: string,
      autoRefresh: boolean,
    ) {
      const [row] = await db
        .insert(projectSecurity)
        .values({ projectId, organizationId, approvedBy, autoRefresh })
        .onConflictDoUpdate({
          target: projectSecurity.projectId,
          set: { approvedBy, autoRefresh, updatedAt: new Date() },
        })
        .returning();
      return row!;
    },
    async claimAttempt(
      id: string,
      projectId: string,
      verification?: { advisoryId: string; serviceId: string; image: string },
    ) {
      const rows = await db
        .insert(securityRefreshAttempt)
        .values({ id, projectId, ...verification })
        .onConflictDoNothing()
        .returning();
      return rows.length === 1;
    },
    async pendingAttempts() {
      return db
        .select()
        .from(securityRefreshAttempt)
        .where(
          or(
            eq(securityRefreshAttempt.status, "queued"),
            eq(securityRefreshAttempt.status, "awaiting_actions"),
            and(
              eq(securityRefreshAttempt.status, "pending"),
              lt(securityRefreshAttempt.createdAt, new Date(Date.now() - 15 * 60_000)),
            ),
          ),
        )
        .orderBy(securityRefreshAttempt.createdAt)
        .limit(100);
    },
    async finishAttempt(
      id: string,
      data: { status: string; deploymentId?: string; actionRequestId?: string; error?: string },
    ) {
      await db.update(securityRefreshAttempt).set(data).where(eq(securityRefreshAttempt.id, id));
    },
  };
}
