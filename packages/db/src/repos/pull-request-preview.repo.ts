import { and, asc, eq, isNull, lte, or, sql } from "drizzle-orm";
import { generateId, ConflictError, ForbiddenError } from "@repo/core";
import type { Database } from "../connection";
import { pullRequestPreview as previews, project, service, envVar, deployment } from "../schema";
import { createConfigurationSecrets, type ConfigurationEncryption } from "../configuration-secrets";
import type { NewProject } from "./project.repo";
import type { NewService } from "./service.repo";

export type PullRequestPreview = typeof previews.$inferSelect;
export function createPullRequestPreviewRepo(db: Database, encryption: ConfigurationEncryption) {
  const codec = createConfigurationSecrets(encryption);
  const leased = (id: string, token: string) =>
    and(
      eq(previews.id, id),
      eq(previews.leaseToken, token),
      sql`${previews.leaseExpiresAt} > now()`,
    );
  return {
    async findByProject(projectId: string) {
      return (await db.select().from(previews).where(eq(previews.projectId, projectId)))[0];
    },
    async findLeased(id: string, token: string) {
      return (await db.select().from(previews).where(leased(id, token)))[0];
    },
    async admittedDeployment(id: string, token: string, sha: string) {
      const [row] = await db
        .select({ deployment })
        .from(previews)
        .innerJoin(deployment, eq(deployment.id, previews.deploymentId))
        .where(and(leased(id, token), eq(previews.headSha, sha)));
      return row ? codec.openDeployment(row.deployment) : undefined;
    },
    async claimSources() {
      return db.transaction(async (tx) => {
        const due = await tx
          .select()
          .from(project)
          .where(
            and(
              isNull(project.deletedAt),
              sql`${project.previewSettings}->>'enabled' = 'true'`,
              or(
                isNull(project.previewScannedAt),
                lte(project.previewScannedAt, new Date(Date.now() - 300_000)),
              ),
            ),
          )
          .orderBy(asc(project.previewScannedAt))
          .limit(10)
          .for("update", { skipLocked: true });
        for (const source of due)
          await tx
            .update(project)
            .set({ previewScannedAt: new Date() })
            .where(eq(project.id, source.id));
        return due;
      });
    },
    async enqueue(
      input: Pick<
        PullRequestPreview,
        "organizationId" | "sourceProjectId" | "owner" | "repo" | "number"
      >,
    ) {
      await db
        .insert(previews)
        .values({
          ...input,
          owner: input.owner.toLowerCase(),
          repo: input.repo.toLowerCase(),
          id: generateId("prp"),
          nextAttemptAt: new Date(),
        })
        .onConflictDoUpdate({
          target: [previews.sourceProjectId, previews.owner, previews.repo, previews.number],
          set: { nextAttemptAt: new Date(), updatedAt: new Date() },
        });
    },
    async list(sourceProjectId: string, organizationId: string) {
      return db
        .select()
        .from(previews)
        .where(
          and(
            eq(previews.sourceProjectId, sourceProjectId),
            eq(previews.organizationId, organizationId),
          ),
        )
        .orderBy(asc(previews.number));
    },
    async due() {
      const now = new Date();
      return db
        .select()
        .from(previews)
        .where(
          and(
            lte(previews.nextAttemptAt, now),
            or(isNull(previews.leaseExpiresAt), lte(previews.leaseExpiresAt, now)),
          ),
        )
        .orderBy(asc(previews.nextAttemptAt))
        .limit(10);
    },
    async claim(id: string, token: string) {
      const now = new Date();
      return (
        await db
          .update(previews)
          .set({ leaseToken: token, leaseExpiresAt: new Date(now.getTime() + 120_000) })
          .where(
            and(
              eq(previews.id, id),
              or(isNull(previews.leaseExpiresAt), lte(previews.leaseExpiresAt, now)),
            ),
          )
          .returning()
      )[0];
    },
    async renew(id: string, token: string) {
      return (
        (
          await db
            .update(previews)
            .set({ leaseExpiresAt: new Date(Date.now() + 120_000) })
            .where(leased(id, token))
            .returning()
        ).length > 0
      );
    },
    async update(
      id: string,
      token: string,
      patch: Partial<
        Pick<
          PullRequestPreview,
          | "headSha"
          | "deploymentId"
          | "status"
          | "url"
          | "commentId"
          | "publishedDigest"
          | "error"
          | "nextAttemptAt"
        >
      >,
    ) {
      return (
        await db
          .update(previews)
          .set({ ...patch, updatedAt: new Date() })
          .where(leased(id, token))
          .returning()
      )[0];
    },
    async release(id: string, token: string) {
      await db
        .update(previews)
        .set({ leaseToken: null, leaseExpiresAt: null })
        .where(leased(id, token));
    },
    /** Preview identity, isolated service rows and preview-only env commit together. */
    async createEnvironment(
      id: string,
      token: string,
      input: {
        project: Omit<NewProject, "id">;
        services: Array<{ sourceId: string; row: Omit<NewService, "id" | "projectId"> }>;
      },
    ) {
      return db.transaction(async (tx) => {
        const [intent] = await tx.select().from(previews).where(leased(id, token)).for("update");
        if (!intent) throw new ConflictError("Preview lease expired");
        if (intent.projectId)
          return (await tx.select().from(project).where(eq(project.id, intent.projectId)))[0]!;
        const [source] = await tx
          .select()
          .from(project)
          .where(
            and(
              eq(project.id, intent.sourceProjectId),
              eq(project.organizationId, intent.organizationId),
            ),
          )
          .for("update");
        if (!source?.previewSettings?.enabled || source.deletionInProgress || source.deletedAt)
          throw new ForbiddenError("Preview deployments are disabled");
        const projectId = generateId("proj");
        const serviceIds = new Map(input.services.map((row) => [row.sourceId, generateId("svc")]));
        const [created] = await tx
          .insert(project)
          .values({
            ...input.project,
            id: projectId,
            organizationId: source.organizationId,
            groupId: source.groupId,
          })
          .returning();
        if (input.services.length)
          await tx
            .insert(service)
            .values(
              input.services.map((item) =>
                codec.sealService({ ...item.row, id: serviceIds.get(item.sourceId)!, projectId }),
              ),
            );
        const variables = await tx
          .select()
          .from(envVar)
          .where(and(eq(envVar.projectId, source.id), eq(envVar.environment, "preview")));
        if (variables.length)
          await tx.insert(envVar).values(
            variables
              .map((row) => ({
                ...row,
                id: generateId("env"),
                projectId,
                // A preview project uses its own production variable set, like manual environments.
                environment: "production",
                serviceId: row.serviceId ? serviceIds.get(row.serviceId) : null,
              }))
              .filter((row) => row.serviceId !== undefined),
          );
        await tx
          .update(previews)
          .set({
            projectId,
            headSha: null,
            deploymentId: null,
            status: "pending",
            updatedAt: new Date(),
          })
          .where(leased(id, token));
        return created!;
      });
    },
  };
}
