import { and, asc, desc, eq, isNull, lte, or, sql } from "drizzle-orm";
import { deploymentCheckName, generateId, resolveGitHubDeploymentChecks } from "@repo/core";
import type { Database } from "../connection";
import { deployment, deploymentCheckRun as checks, project, service } from "../schema";

type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
export type DeploymentCheck = typeof checks.$inferSelect;

/** The intent and deployment commit together. No network I/O in admission. */
export async function queueDeploymentChecks(tx: Transaction, dep: typeof deployment.$inferSelect) {
  if (dep.status !== "queued") return; // Imported history is not a new deployment.
  const [owner] = await tx.select().from(project).where(and(
    eq(project.id, dep.projectId), eq(project.organizationId, dep.organizationId),
  ));
  if (!owner || owner.gitProvider !== "github" || !owner.gitOwner || !owner.gitRepo) return;
  const config = resolveGitHubDeploymentChecks(owner.githubChecks);
  if (!config.enabled || (!config.deployment && config.services !== "all" && !config.services.length)) return;
  const services = await tx.select({ id: service.id, name: service.name, enabled: service.enabled })
    .from(service).where(eq(service.projectId, dep.projectId));
  const meta = dep.meta as { serviceDeploymentMode?: string; targetServiceIds?: string[]; composeServices?: Array<{ name?: string; enabled?: boolean }> } | null;
  const targetIds = Array.isArray(meta?.targetServiceIds) ? meta.targetServiceIds : [];
  const targetNames = new Set(services.filter(row => targetIds.includes(row.id)).map(row => row.name));
  // The admitted snapshot already resolved the execution mode. An attached
  // database on a single-app project is not part of every application deploy.
  const names = new Set(services.filter(row => row.enabled && targetIds.includes(row.id)).map(row => row.name));
  const compose = meta?.serviceDeploymentMode === "single" && !targetIds.length ? [] : meta?.composeServices;
  if (Array.isArray(compose)) for (const item of compose) {
    if (item && typeof item.name === "string" && item.enabled !== false) names.add(item.name);
  }
  await tx.insert(checks).values({
    id: generateId("dcr"), deploymentId: dep.id, kind: "rollup", status: "queued",
    name: deploymentCheckName(owner.slug, owner.environmentSlug),
    source: {
      owner: owner.gitOwner, repo: owner.gitRepo,
      name: deploymentCheckName(owner.slug, owner.environmentSlug), checks: config,
      services: [...names].map(name => ({ name, targeted: dep.forceAll || !targetIds.length || targetNames.has(name) })),
    },
    nextAttemptAt: new Date(),
  }).onConflictDoNothing();
}

/** A short durable lease prevents concurrent controllers from creating duplicate Checks. */
export function createDeploymentCheckRepo(db: Database) {
  const liveLease = (id: string, token: string) => and(
    eq(checks.id, id), eq(checks.leaseToken, token), sql`${checks.leaseExpiresAt} > now()`,
  );
  return {
    async due(limit = 50) {
      const now = new Date();
      return db.select({ id: checks.id }).from(checks).where(and(
        eq(checks.kind, "rollup"), lte(checks.nextAttemptAt, now),
        or(isNull(checks.leaseExpiresAt), lte(checks.leaseExpiresAt, now)),
      )).orderBy(asc(checks.nextAttemptAt), asc(checks.id)).limit(limit);
    },
    async claim(id: string, token: string) {
      const now = new Date();
      return (await db.update(checks).set({ leaseToken: token, leaseExpiresAt: new Date(now.getTime() + 120_000) })
        .where(and(eq(checks.id, id), eq(checks.kind, "rollup"), lte(checks.nextAttemptAt, now),
          or(isNull(checks.leaseExpiresAt), lte(checks.leaseExpiresAt, now))))
        .returning())[0];
    },
    async renew(id: string, token: string): Promise<boolean> {
      return (await db.update(checks).set({ leaseExpiresAt: new Date(Date.now() + 120_000) })
        .where(liveLease(id, token)).returning()).length > 0;
    },
    async list(deploymentId: string) {
      return db.select().from(checks).where(eq(checks.deploymentId, deploymentId));
    },
    async ensureService(root: DeploymentCheck, name: string) {
      await db.insert(checks).values({
        id: generateId("dcr"), deploymentId: root.deploymentId, kind: "service",
        serviceName: name, name: `${root.name} / ${name}`.slice(0, 255), status: "queued",
      }).onConflictDoNothing();
      return (await db.select().from(checks).where(and(
        eq(checks.deploymentId, root.deploymentId), eq(checks.kind, "service"), eq(checks.serviceName, name),
      )))[0]!;
    },
    async published(rootId: string, token: string, id: string, data: {
      checkRunId: number; status: string; conclusion: string | null; publishedDigest: string;
      serviceDeploymentId?: string;
    }) {
      // Both rows are local bookkeeping. Never hold this transaction over HTTP.
      return db.transaction(async tx => {
        const [lease] = await tx.select({ deploymentId: checks.deploymentId }).from(checks)
          .where(liveLease(rootId, token)).for("update");
        if (!lease) return false;
        await tx.update(checks).set({ ...data, updatedAt: new Date() })
          .where(and(eq(checks.id, id), eq(checks.deploymentId, lease.deploymentId)));
        return true;
      });
    },
    async release(id: string, token: string, result: { nextAttemptAt: Date | null; lastError: string | null; attempts: number }) {
      await db.update(checks).set({ ...result, leaseToken: null, leaseExpiresAt: null, updatedAt: new Date() })
        .where(liveLease(id, token));
    },
    async findByCheckRunId(id: number) {
      return (await db.select().from(checks).where(eq(checks.checkRunId, id)).limit(1))[0];
    },
    async latestForProject(projectId: string, organizationId: string) {
      return (await db.select({ error: checks.lastError, updatedAt: checks.updatedAt, pending: checks.nextAttemptAt })
        .from(checks).innerJoin(deployment, eq(deployment.id, checks.deploymentId))
        .where(and(eq(deployment.projectId, projectId), eq(deployment.organizationId, organizationId), eq(checks.kind, "rollup")))
        .orderBy(desc(deployment.createdAt)).limit(1))[0] ?? null;
    },
  };
}
