import { eq, and, or, isNull, isNotNull, inArray, desc, sql, type SQL } from "drizzle-orm";
import { generateId, ForbiddenError, UnauthorizedError, ConflictError, ValidationError, inspectCommandEnvironment, manualBuildCaches } from "@repo/core";
import type { Database, DatabaseTransaction } from "../connection";
import { createConfigurationSecrets, type ConfigurationEncryption } from "../configuration-secrets";
import { project, projectGroup, envVar, deployment, service, domain } from "../schema";
import { member } from "../schema/organization";
// Cloning a project writes its group and service rows in the same transaction, so this repo
// needs both insert types. Imported from their own repos (where they are already declared)
// rather than re-derived here, so there is one definition of each row shape.
import type { NewProjectGroup } from "./project-group.repo";
import type { NewService } from "./service.repo";
import { personalAccessTokenGrant } from "../schema/personal-access-token-grant";
import { personalAccessToken } from "../schema/personal-access-token";
import { assertCloudWorkspacePlacement } from "./cloud-workspace.repo";
import { projectWorkspaceScope } from "./workspace-scope";
import { assertProjectSwapResources } from "./service-swap-resources";
import { assertProjectConfigurationWritable, withProjectConfigurationWrite } from "./project-work-admission";

// ─── Types ───────────────────────────────────────────────────────────────────

export type Project = typeof project.$inferSelect;
export type NewProject = typeof project.$inferInsert;
export type EnvVar = typeof envVar.$inferSelect;
export type NewEnvVar = typeof envVar.$inferInsert;

type EnvScopeEdit = {
  serviceId?: string | null;
  upserts: { key: string; value: string; isSecret?: boolean }[];
  deletes: string[];
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Build Drizzle conditions for env var queries scoped by project/environment/service */
function envVarScope(projectId: string, environment?: string, serviceId?: string | null): SQL[] {
  const conditions: SQL[] = [eq(envVar.projectId, projectId)];
  if (environment) {
    conditions.push(eq(envVar.environment, environment));
  }
  if (serviceId === null) {
    // Explicitly project-level only
    conditions.push(isNull(envVar.serviceId));
  } else if (serviceId) {
    conditions.push(eq(envVar.serviceId, serviceId));
  }
  return conditions;
}

/**
 * The server a project is actually deployed to: the DURABLE `project.server_id`
 * binding, falling back to the active deployment's `meta.serverId` snapshot for
 * legacy rows never backfilled. Shared by `countActiveByServer` and
 * `listActiveByServer` so the "N projects" chip and the removal confirm's list
 * can never disagree — a second copy of this coalesce is exactly how a modal
 * ends up listing five workloads next to a card that says seven. Both queries
 * join `deployment` on `project.active_deployment_id`, which is what makes the
 * fallback readable at all.
 */
const boundServerId = sql<string>`coalesce(${project.serverId}, ${deployment.meta} ->> 'serverId')`;

/**
 * Transaction-compatible primitive for moving every existing GitHub source row
 * in one workspace to the installation currently claimed for its owner.
 * Exported so the installation-state consume can include this in the SAME DB
 * transaction as its upsert; createProjectRepo wraps it for ordinary callers.
 */
export async function rebindGitHubInstallationRows(
  db: DatabaseTransaction,
  organizationId: string,
  owner: string,
  installationId: number,
): Promise<{ projects: number; groups: number }> {
  const ownerKey = owner.toLowerCase();
  const updatedAt = new Date();
  const projectPredicate = and(
    eq(project.organizationId, organizationId), eq(project.gitProvider, "github"),
    sql`lower(${project.gitOwner}) = ${ownerKey}`, isNull(project.deletedAt),
  )!;
  const groupPredicate = and(
    eq(projectGroup.organizationId, organizationId), eq(projectGroup.gitProvider, "github"),
    sql`lower(${projectGroup.gitOwner}) = ${ownerKey}`, isNull(projectGroup.deletedAt),
  )!;
  await assertProjectConfigurationWritable(db, or(projectPredicate,
    inArray(project.groupId, db.select({ id: projectGroup.id }).from(projectGroup).where(groupPredicate)))!);
  const projects = await db
    .update(project)
    // The App's global webhook is now authoritative. Clearing legacy
    // per-repository hook metadata prevents the same push from being accepted a
    // second time through an old PAT/OAuth hook that may still exist at GitHub.
    .set({ installationId, webhookId: null, webhookSecret: null, updatedAt })
    .where(projectPredicate)
    .returning();
  const groups = await db
    .update(projectGroup)
    .set({ installationId, updatedAt })
    .where(groupPredicate)
    .returning();
  return { projects: projects.length, groups: groups.length };
}

// ─── Repository ──────────────────────────────────────────────────────────────

export function createProjectRepo(db: Database, encryption: ConfigurationEncryption) {
  const codec = createConfigurationSecrets(encryption);
  async function environmentSnapshot(
    connection: Database | DatabaseTransaction,
    projectId: string,
    environment: string,
  ) {
    const [vars, services] = await Promise.all([
      connection.select().from(envVar).where(and(...envVarScope(projectId, environment))),
      connection.select().from(service).where(eq(service.projectId, projectId)),
    ]);
    return { vars, services: services.map(codec.openService) };
  }
  async function mergeEnvVarScopes(
    projectId: string,
    environment: string,
    edits: EnvScopeEdit[],
    validate?: (snapshot: Awaited<ReturnType<typeof environmentSnapshot>>) => void,
  ) {
    await db.transaction(async (tx) => {
      await assertProjectConfigurationWritable(tx, eq(project.id, projectId));
      // Recheck the reviewed sources under the same configuration lock as the
      // writes. A concurrent edit cannot partially update a shared value.
      if (validate) validate(await environmentSnapshot(tx, projectId, environment));
      for (const edit of edits) {
        const affectedKeys = [...new Set([...edit.deletes, ...edit.upserts.map((row) => row.key)])];
        if (!affectedKeys.length) continue;
        await tx.delete(envVar).where(
          and(
            ...envVarScope(projectId, environment, edit.serviceId ?? null),
            inArray(envVar.key, affectedKeys),
          ),
        );
        if (edit.upserts.length) {
          await tx.insert(envVar).values(edit.upserts.map((row) => ({
            id: generateId("env"),
            projectId,
            environment,
            serviceId: edit.serviceId ?? null,
            key: row.key,
            value: row.value,
            isSecret: row.isSecret ?? false,
          })));
        }
      }
    });
  }
  return {
    environmentSnapshot: (projectId: string, environment: string) =>
      environmentSnapshot(db, projectId, environment),
    mergeEnvVarScopes,
    // ── Projects ───────────────────────────────────────────────────────

    async findById(id: string | null | undefined) {
      // Tolerate a null/undefined id (e.g. a webhook-owned domain has no
      // projectId) → no project, which every caller already guards with `!project`.
      if (!id) return undefined;
      return db.query.project.findFirst({
        where: and(eq(project.id, id), isNull(project.deletedAt)),
      });
    },

    /**
     * Batch id → display name. Lets a list response (the audit feed) show
     * "api-gateway" instead of "prj_8fk2abc" with one query per page.
     * Includes soft-deleted rows on purpose: history about a deleted project
     * should still name it.
     */
    async listNamesByIds(ids: string[]): Promise<{ id: string; name: string }[]> {
      if (ids.length === 0) return [];
      return db
        .select({ id: project.id, name: project.name })
        .from(project)
        .where(inArray(project.id, ids));
    },

    /**
     * Ids of projects in an org whose name or slug matches a search term.
     *
     * The inverse of `listNamesByIds`, for the audit feed's free-text search:
     * rows store `prj_8fk2abc`, so searching "api-gateway" can only work by
     * resolving the name to ids first. Soft-deleted included — the row being
     * searched for is often the deletion itself.
     */
    async searchIdsByName(organizationId: string, term: string, limit = 200): Promise<string[]> {
      const pattern = `%${term}%`;
      const rows = await db
        .select({ id: project.id })
        .from(project)
        .where(
          and(
            eq(project.organizationId, organizationId),
            sql`(${project.name} ILIKE ${pattern} OR ${project.slug} ILIKE ${pattern})`,
          ),
        )
        .limit(limit);
      return rows.map((r) => r.id);
    },

    /** Slug uniqueness scoped to one org. */
    async findBySlugInOrg(organizationId: string, slug: string) {
      return db.query.project.findFirst({
        where: and(
          eq(project.organizationId, organizationId),
          eq(project.slug, slug),
          isNull(project.deletedAt),
        ),
      });
    },

    /**
     * The not-yet-deployed catalog-app draft for (org, appTemplateId), if any.
     * A draft = an isApp project that never went live (activeDeploymentId null).
     * Pass `slug` to require an exact-slug match so re-opening a same-named draft
     * is reused while a differently-named install still creates a new instance
     * (multiple apps of the same type). Omit `slug` to match any draft of the type.
     */
    async findDraftByAppTemplate(organizationId: string, appTemplateId: string, slug?: string, workspaceId?: string | null) {
      return db.query.project.findFirst({
        where: and(
          eq(project.organizationId, organizationId),
          eq(project.appTemplateId, appTemplateId),
          projectWorkspaceScope(workspaceId),
          isNull(project.activeDeploymentId),
          isNull(project.deletedAt),
          eq(project.environmentSlug, "production"),
          ...(slug ? [eq(project.slug, slug)] : []),
        ),
        orderBy: [desc(project.createdAt)],
      });
    },

    /**
     * Find a project by slug without scoping to a user. Use ONLY for slugs
     * that are deterministic and globally unique (e.g. `webmail-<serverId>`),
     * never for user-facing slugs where collisions across users are expected.
     */
    async findFirstBySlug(slug: string) {
      return db.query.project.findFirst({
        where: and(eq(project.slug, slug), isNull(project.deletedAt)),
      });
    },

    /** Find all projects linked to a given git owner/repo (for webhook dispatch) */
    async findByGitRepo(owner: string, repo: string) {
      const ownerKey = owner.toLowerCase();
      const repoKey = repo.toLowerCase();
      return db.query.project.findMany({
        where: and(
          sql`lower(${project.gitOwner}) = ${ownerKey}`,
          sql`lower(${project.gitRepo}) = ${repoKey}`,
          isNull(project.deletedAt),
        ),
      });
    },

    /**
     * Auto-deploy projects that have a registered webhook (webhookId set) but no
     * per-project signing secret yet — the self-hosted webhook-secret backfill
     * sweep re-registers these to mint + persist a per-project secret.
     */
    async listNeedingWebhookBackfill() {
      return db.query.project.findMany({
        where: and(
          eq(project.autoDeploy, true),
          isNotNull(project.webhookId),
          isNull(project.webhookSecret),
          isNull(project.deletedAt),
        ),
      });
    },

    async listByGroup(groupId: string) {
      return db.query.project.findMany({
        where: and(eq(project.groupId, groupId), isNull(project.deletedAt)),
        orderBy: [desc(project.createdAt)],
      });
    },

    /**
     * List every project visible to a user — across ALL orgs they're a
     * member of. Resolves via the `member` join (not a stamped user_id
     * column, which doesn't exist anymore). Useful for "show me
     * everything I have access to" views like cross-org dashboards.
     *
     * For scoped lookups on the user's CURRENT org, prefer
     * `listByOrganization(activeOrgId, ...)`.
     */
    async listForUser(userId: string, opts?: { page?: number; perPage?: number }) {
      const page = opts?.page ?? 1;
      const perPage = opts?.perPage ?? 20;
      const offset = (page - 1) * perPage;

      const rows = await db
        .select({ project })
        .from(project)
        .innerJoin(member, eq(member.organizationId, project.organizationId))
        .where(and(eq(member.userId, userId), isNull(project.deletedAt)))
        .orderBy(desc(project.createdAt))
        .limit(perPage)
        .offset(offset);

      const [{ value: total }] = await db
        .select({ value: sql<number>`count(*)` })
        .from(project)
        .innerJoin(member, eq(member.organizationId, project.organizationId))
        .where(and(eq(member.userId, userId), isNull(project.deletedAt)));

      return {
        rows: rows.map((r) => r.project),
        total: Number(total),
        page,
        perPage,
      };
    },

    /**
     * Org-scoped list. Replaces listByUser in multi-user controllers —
     * returns every project visible to the active organization.
     * Membership check is enforced at the middleware layer; this just
     * scopes the rows.
     */
    async listByOrganization(organizationId: string, opts?: { page?: number; perPage?: number }) {
      const page = opts?.page ?? 1;
      const perPage = opts?.perPage ?? 20;
      const offset = (page - 1) * perPage;

      const rows = await db.query.project.findMany({
        where: and(eq(project.organizationId, organizationId), isNull(project.deletedAt)),
        orderBy: [desc(project.createdAt)],
        limit: perPage,
        offset,
      });

      const [{ value: total }] = await db
        .select({ value: sql<number>`count(*)` })
        .from(project)
        .where(and(eq(project.organizationId, organizationId), isNull(project.deletedAt)));

      return { rows, total: Number(total), page, perPage };
    },

    /** Catalog apps on a particular server, scoped before returning any rows. */
    async listAppsOnServer(organizationId: string, serverId: string, appTemplateId: string) {
      return db.query.project.findMany({
        where: and(eq(project.organizationId, organizationId), eq(project.serverId, serverId),
          eq(project.appTemplateId, appTemplateId), eq(project.isApp, true),
          isNull(project.deletedAt)),
        orderBy: [desc(project.createdAt)],
      });
    },

    /**
     * Project counts for the dashboard home — total and with-an-active-
     * deployment, in one aggregate query instead of listing every row.
     */
    async countByOrganization(organizationId: string, projectIds?: readonly string[]): Promise<{ total: number; active: number }> {
      const [row] = await db
        .select({
          total: sql<number>`count(*)::int`,
          active: sql<number>`count(*) filter (where ${project.activeDeploymentId} is not null)::int`,
        })
        .from(project)
        .where(and(eq(project.organizationId, organizationId), isNull(project.deletedAt), projectIds ? inArray(project.id, [...projectIds]) : undefined));

      return { total: Number(row?.total ?? 0), active: Number(row?.active ?? 0) };
    },

    /**
     * Every non-deleted project across ALL orgs — for the instance-wide
     * updates:scan job (each row carries its own organizationId). Capped so a
     * pathological instance can't run an unbounded sweep.
     */
    async listAllForScan(limit = 5000) {
      return db.query.project.findMany({
        where: isNull(project.deletedAt),
        orderBy: [desc(project.createdAt)],
        limit,
      });
    },

    /** Org-scoped findById — verifies the project belongs to the org. */
    async findByIdInOrganization(id: string, organizationId: string) {
      return db.query.project.findFirst({
        where: and(eq(project.id, id), eq(project.organizationId, organizationId)),
      });
    },

    /**
     * Same as listForUser but filtered to production environments only.
     * Used for the "primary" view that hides preview branch deploys.
     */
    async listPrimaryForUser(userId: string, opts?: { page?: number; perPage?: number }) {
      const page = opts?.page ?? 1;
      const perPage = opts?.perPage ?? 20;
      const offset = (page - 1) * perPage;

      const condition = and(
        eq(member.userId, userId),
        eq(project.environmentSlug, "production"),
        isNull(project.deletedAt),
      );

      const rows = await db
        .select({ project })
        .from(project)
        .innerJoin(member, eq(member.organizationId, project.organizationId))
        .where(condition)
        .orderBy(desc(project.createdAt))
        .limit(perPage)
        .offset(offset);

      const [{ value: total }] = await db
        .select({ value: sql<number>`count(*)` })
        .from(project)
        .innerJoin(member, eq(member.organizationId, project.organizationId))
        .where(condition);

      return {
        rows: rows.map((r) => r.project),
        total: Number(total),
        page,
        perPage,
      };
    },

    async create(data: Omit<NewProject, "id"> & { id?: string }, access?: { tokenId: string }) {
      // `id` is normally generated, but re-import (recovering an Openship project
      // from a server's `.openship/manifest.json`) passes the ORIGINAL id so the
      // still-running containers' `openship.project` labels re-attach immediately.
      const { id: providedId, ...rest } = data;
      const id = providedId ?? generateId("proj");
      const row = { id, ...rest };
      let inserted: Project;
      if (access || row.workspaceId || row.serverId) {
        // A create-only credential must acquire access in the same commit as
        // its new project. A revoked/missing token rolls back the project too.
        await db.transaction(async tx => {
          await assertCloudWorkspacePlacement(tx, row);
          if (access) {
          const [token] = await tx.select().from(personalAccessToken)
            .where(eq(personalAccessToken.id, access.tokenId)).for("update");
          if (!token || token.revokedAt || (token.expiresAt && token.expiresAt.getTime() <= Date.now()))
            throw new UnauthorizedError("Project creation credential is no longer valid");
          if (token.readOnly || (token.organizationId && token.organizationId !== row.organizationId))
            throw new ForbiddenError("Project creation credential cannot write to this organization");
          }
          [inserted] = await tx.insert(project).values(row).returning();
          if (access) {
          await tx.insert(personalAccessTokenGrant).values({
            id: generateId("patgrant"), tokenId: access.tokenId,
            resourceType: "project", resourceId: id,
            permissionsJson: JSON.stringify(["read", "write", "admin"]),
          });
          }
        });
      } else {
        [inserted] = await db.insert(project).values(row).returning();
      }
      return inserted!;
    },

    async listByWorkspace(workspaceId: string, organizationId: string) {
      return db.select().from(project).where(and(eq(project.workspaceId, workspaceId), eq(project.organizationId, organizationId), isNull(project.deletedAt))).orderBy(project.createdAt, project.id);
    },

    async countGroupsForOrganization(organizationId: string, workspaceId?: string | null) {
      const [row] = await db.select({ count: sql<number>`count(distinct ${project.groupId})::int` }).from(project).where(and(
        eq(project.organizationId, organizationId), isNull(project.deletedAt), projectWorkspaceScope(workspaceId),
      ));
      return row?.count ?? 0;
    },

    /**
     * Create a whole project — its group, the project row, its service rows and its env vars —
     * in ONE transaction.
     *
     * Exists for duplicating a project (see `project-clone.service.ts`), where a partial
     * result is the worst outcome available: a project row with no services is an empty
     * project the operator has to notice and delete, and a project with services but no env is
     * a stack that boots and fails on a missing DATABASE_URL. The step-by-step create path
     * (`createServicesProject`) compensates by soft-deleting its group on failure, which
     * cannot cover a failure *between* the service and env inserts.
     *
     * The caller decides every value — this deliberately computes nothing. What to copy, what
     * to reset and what to override is a product decision that belongs with the service that
     * understands the two projects; the repo's only job is that all of it lands or none does.
     *
     * Service ids are minted here, so the returned map is how the caller (and any env row
     * scoped to a service) resolves a SOURCE service id to the row that now stands for it.
     */
    async createProjectWithRecords(input: {
      group: Omit<NewProjectGroup, "id">;
      /** Project row minus the two ids this method owns. */
      project: Omit<NewProject, "id" | "groupId">;
      /** `sourceId` is only used to key the returned map (and the env rows below). */
      services: Array<{ sourceId: string; row: Omit<NewService, "id" | "projectId"> }>;
      /** `sourceServiceId: null` = a project-level var; otherwise it follows that service. */
      envVars: Array<{
        sourceServiceId: string | null;
        key: string;
        value: string;
        environment: string;
        isSecret?: boolean;
      }>;
    }): Promise<{ project: Project; serviceIdBySourceId: Record<string, string> }> {
      const groupId = generateId("app");
      const projectId = generateId("proj");
      const serviceIdBySourceId: Record<string, string> = {};
      for (const svc of input.services) serviceIdBySourceId[svc.sourceId] = generateId("svc");

      const projectRow = { id: projectId, groupId, ...input.project };
      let inserted: Project;

      await db.transaction(async (tx) => {
        await assertCloudWorkspacePlacement(tx, projectRow);
        await tx.insert(projectGroup).values({ id: groupId, ...input.group });
        [inserted] = await tx.insert(project).values(projectRow).returning();
        if (input.services.length > 0) {
          await tx.insert(service).values(
            input.services.map((svc) => ({
              id: serviceIdBySourceId[svc.sourceId]!,
              projectId,
              ...codec.sealService(svc.row),
            })),
          );
        }
        if (input.envVars.length > 0) {
          await tx.insert(envVar).values(
            input.envVars.map((v) => {
              let serviceId: string | null = null;
              if (v.sourceServiceId) {
                serviceId = serviceIdBySourceId[v.sourceServiceId] ?? null;
                // A var scoped to a service the caller did not clone. Coalescing to null
                // would PROMOTE it to a project-level var — one service's config, quietly
                // handed to every other service in the new project. Dropping it silently is
                // the other wrong answer. It can only mean the caller's service list and env
                // list disagree, so refuse: we are inside the transaction, and nothing lands.
                if (!serviceId) {
                  throw new Error(
                    `createProjectWithRecords: env var "${v.key}" is scoped to service ` +
                      `${v.sourceServiceId}, which is not in the services being created`,
                  );
                }
              }
              return {
                id: generateId("env"),
                projectId,
                serviceId,
                environment: v.environment,
                key: v.key,
                value: v.value,
                isSecret: v.isSecret ?? false,
              };
            }),
          );
        }
      });

      return {
        project: inserted!,
        serviceIdBySourceId,
      };
    },

    async update(id: string, data: Partial<NewProject>) {
      await withProjectConfigurationWrite(db, eq(project.id, id), async (tx) => {
        if (data.resources !== undefined) {
          await assertProjectSwapResources(tx, eq(project.id, id), data.resources, codec);
        }
        if (data.workspaceId !== undefined) {
          const current = await tx.query.project.findFirst({ where: eq(project.id, id) });
          if (current && data.workspaceId !== current.workspaceId) throw new Error("Changing a project's Cloud workspace requires an explicit migration");
        }
        await tx.update(project).set({ ...data, updatedAt: new Date() }).where(eq(project.id, id));
      });
    },

    /**
     * Atomically consume the one-shot `forceDeployNext` flag.
     *
     * Returns `true` if the flag was set and has now been cleared (the caller
     * should treat this as a force-deploy). Returns `false` if it was already
     * false. Two concurrent webhooks can both observe the flag with a naive
     * read-then-update, so this is a single conditional UPDATE that only
     * touches the row when the flag is true and reports back whether it won.
     */
    async consumeForceDeployNext(id: string): Promise<boolean> {
      const rows = await db
        .update(project)
        .set({ forceDeployNext: false, updatedAt: new Date() })
        .where(and(eq(project.id, id), eq(project.forceDeployNext, true)))
        .returning();
      return rows.length > 0;
    },

    async updateByApp(groupId: string, data: Partial<NewProject>) {
      const predicate = and(eq(project.groupId, groupId), isNull(project.deletedAt))!;
      await withProjectConfigurationWrite(db, predicate, async (tx) => {
        if (data.resources !== undefined) {
          await assertProjectSwapResources(tx, predicate, data.resources, codec);
        }
        await tx.update(project).set({ ...data, updatedAt: new Date() }).where(predicate);
      });
    },

    /** Update a source identity shared by every environment and its project_app
     * row in one transaction. Source transitions span both tables; exposing one
     * repository operation prevents a failed second write from leaving the
     * group and its environments classified differently. */
    async updateSourceByApp(
      groupId: string,
      projectData: Partial<NewProject>,
      groupData: Partial<NewProjectGroup>,
    ) {
      const updatedAt = new Date();
      await db.transaction(async (tx) => {
        const predicate = and(eq(project.groupId, groupId), isNull(project.deletedAt))!;
        await assertProjectConfigurationWritable(tx, predicate);
        if (projectData.resources !== undefined) {
          await assertProjectSwapResources(tx, predicate, projectData.resources, codec);
        }
        await tx
          .update(project)
          .set({ ...projectData, updatedAt })
          .where(and(eq(project.groupId, groupId), isNull(project.deletedAt)));
        await tx
          .update(projectGroup)
          .set({ ...groupData, updatedAt })
          .where(and(eq(projectGroup.id, groupId), isNull(projectGroup.deletedAt)));
      });
    },

    /**
     * Rebind every existing GitHub project for one owner inside one workspace
     * after an App install/reinstall. The installation id is part of webhook
     * tenant isolation, so leaving legacy project rows on the previous/null id
     * would make valid App pushes get dropped. Projects and their shared
     * project_app source rows move together in one transaction.
     */
    async rebindGitHubInstallation(
      organizationId: string,
      owner: string,
      installationId: number,
    ): Promise<{ projects: number; groups: number }> {
      return db.transaction((tx) =>
        rebindGitHubInstallationRows(tx, organizationId, owner, installationId),
      );
    },

    /** Update favicon cache metadata without touching the user-visible updatedAt field. */
    async updateFaviconCache(
      id: string,
      data: { favicon?: string | null; faviconCheckedAt?: Date | null },
    ) {
      const patch: Partial<NewProject> = {};

      if (Object.prototype.hasOwnProperty.call(data, "favicon")) {
        patch.favicon = data.favicon ?? null;
      }
      if (Object.prototype.hasOwnProperty.call(data, "faviconCheckedAt")) {
        patch.faviconCheckedAt = data.faviconCheckedAt ?? null;
      }

      if (Object.keys(patch).length === 0) return;

      await db.update(project).set(patch).where(eq(project.id, id));
    },

    /** Soft-delete a project */
    async softDelete(id: string) {
      await withProjectConfigurationWrite(db, eq(project.id, id), async (tx) => tx
        .update(project)
        .set({ deletedAt: new Date(), updatedAt: new Date() })
        .where(eq(project.id, id)));
    },

    /**
     * Hard-delete a project row. Lets FK ON DELETE CASCADE drop dependent
     * rows (deployment, service, env_var, domain, backup_*). Only call from
     * the atomic teardown flow, AFTER remote/runtime cleanup has succeeded —
     * the soft-delete + per-table hard-delete path in project-cleanup is the
     * legacy variant that left some dependents around.
     */
    async deleteHard(id: string) {
      await db.delete(project).where(eq(project.id, id));
    },

    /**
     * Mark a live project as "teardown in progress".
     *
     * The caller owns the cross-process project-runtime advisory lock. That
     * lock—not this crash-prone boolean—is the concurrency owner, so an old
     * `true` left by a dead process is safely reclaimed here in Cloud and
     * self-hosted modes alike. A protected promotion also fences configuration
     * writes and requires a receipt; false means its live source is unavailable.
     */
    async claimDeletion(id: string, opts?: { protectConfiguration?: boolean }): Promise<boolean> {
      const rows = await db
        .update(project)
        .set({
          deletionInProgress: true,
          updatedAt: new Date(),
          ...(opts?.protectConfiguration && {
            cloudPromotion: sql`jsonb_set(${project.cloudPromotion}, '{cleanupInProgress}', 'true'::jsonb)`,
          }),
        })
        .where(and(eq(project.id, id), isNull(project.deletedAt), opts?.protectConfiguration ? isNotNull(project.cloudPromotion) : undefined))
        .returning();
      return rows.length > 0;
    },

    /** Release a transient fence after preflight rejection or receipt-managed
     * promotion cleanup. Ordinary partial deletion stays fenced. */
    async clearDeletionInProgress(id: string) {
      await db
        .update(project)
        .set({
          deletionInProgress: false,
          lifecycleOperation: null,
          cloudPromotion: sql`${project.cloudPromotion} - 'cleanupInProgress'`,
          updatedAt: new Date(),
        })
        .where(eq(project.id, id));
    },

    /** Workers have quiesced. Fence configuration before reading cleanup manifests. */
    async beginDeletionCleanup(id: string): Promise<boolean> {
      const rows = await db
        .update(project)
        .set({ lifecycleOperation: { kind: "delete", status: "running" }, updatedAt: new Date() })
        .where(
          and(eq(project.id, id), eq(project.deletionInProgress, true), isNull(project.deletedAt)),
        )
        .returning();
      return rows.length > 0;
    },

    /** Caller holds the project runtime lock. A retry preserves this operation's fence. */
    async markDeletionFailed(id: string, error: string) {
      await db
        .update(project)
        .set({
          deletionInProgress: true,
          lifecycleOperation: { kind: "delete", status: "failed", error },
          updatedAt: new Date(),
        })
        .where(and(eq(project.id, id), isNull(project.deletedAt)));
    },

    /**
     * Count projects currently deployed to each server, keyed by server id.
     * A project counts for a server when it has an ACTIVE deployment and resolves
     * to that server — preferring the DURABLE `project.server_id` binding and
     * falling back to the active deployment's `meta.serverId` for legacy rows not
     * yet backfilled. Powers the "N projects" chip + Projects stat on the Servers
     * list. `withRoutes` limits the missing-edge alarm to projects with durable routes.
     */
    async countActiveByServer(organizationId: string, opts: { withRoutes?: boolean } = {}): Promise<Record<string, number>> {
      const rows = await db
        .select({
          serverId: boundServerId,
          count: sql<number>`count(*)::int`,
        })
        .from(project)
        .innerJoin(deployment, eq(project.activeDeploymentId, deployment.id))
        .where(
          and(
            eq(project.organizationId, organizationId),
            isNull(project.deletedAt),
            sql`${boundServerId} is not null`,
            // Domain rows are the durable route inventory. Private services and
            // workers do not require an edge merely because they are deployed.
            opts.withRoutes ? sql`exists (
              select 1 from ${domain}
              left join ${service} on ${domain.serviceId} = ${service.id}
              where ${domain.projectId} = ${project.id} and ${domain.status} <> 'removing'
                and (${domain.targetPort} is not null or ${domain.targetPath} is not null
                  or exists (select 1 from jsonb_array_elements(coalesce(${project.compositeRoutes}, '[]'::jsonb)) route
                    where route->>'hostname' = ${domain.hostname}))
                and (${domain.serviceId} is null or (${service.enabled} and ${service.exposed}))
            )` : undefined,
          ),
        )
        .groupBy(boundServerId);
      const out: Record<string, number> = {};
      for (const r of rows) {
        if (r.serverId) out[r.serverId] = Number(r.count);
      }
      return out;
    },

    /**
     * The same set `countActiveByServer` counts, for ONE server, itemised — what
     * "Remove server" is about to take with it. Left-joins the group so an app
     * install can be named by its collection, and carries `activeDeploymentId`
     * rather than a resolved status: there is no batch latest-status helper, and
     * `getProjectStatus` already derives live-vs-draft from that pointer alone.
     */
    async listActiveByServer(organizationId: string, serverId: string) {
      return db
        .select({
          id: project.id,
          name: project.name,
          slug: project.slug,
          environmentName: project.environmentName,
          environmentSlug: project.environmentSlug,
          groupId: project.groupId,
          groupName: projectGroup.name,
          isApp: project.isApp,
          appTemplateId: project.appTemplateId,
          activeDeploymentId: project.activeDeploymentId,
        })
        .from(project)
        .innerJoin(deployment, eq(project.activeDeploymentId, deployment.id))
        .leftJoin(projectGroup, eq(project.groupId, projectGroup.id))
        .where(
          and(
            eq(project.organizationId, organizationId),
            isNull(project.deletedAt),
            sql`${boundServerId} = ${serverId}`,
          ),
        )
        .orderBy(project.name, project.environmentSlug);
    },

    /**
     * Set the active deployment for a project.
     *
     * Advancing the pointer to a real release also clears `disabledAt`: a release
     * that just went live is, by definition, not a project someone turned off, and
     * a stale marker would tell the health watch to ignore a running workload
     * forever. Clearing to null (a deleted deployment) leaves the marker alone —
     * that isn't a release going live.
     */
    async setActiveDeployment(projectId: string, deploymentId: string | null) {
      await withProjectConfigurationWrite(db, eq(project.id, projectId), async (tx) => tx
        .update(project)
        .set({
          activeDeploymentId: deploymentId,
          ...(deploymentId ? { disabledAt: null } : {}),
          updatedAt: new Date(),
        })
        .where(eq(project.id, projectId)));
    },

    /**
     * List every cloud-bound project in an org. Used by the drift
     * endpoint to diff against Oblien's `workspaces.list`. A project
     * is "cloud-bound" iff it has a non-null workspaceId — that
     * column is the single source of truth, no separate deployTarget.
     *
     * Returns the minimal shape the diff needs — id, name, slug, and
     * the workspace binding — not the full project record, so the
     * dashboard payload stays small.
     */
    async listCloudProjectsByOrganization(organizationId: string) {
      return db
        .select({
          id: project.id,
          name: project.name,
          slug: project.slug,
          workspaceId: project.workspaceId,
        })
        .from(project)
        .where(
          and(
            eq(project.organizationId, organizationId),
            sql`${project.workspaceId} IS NOT NULL`,
            isNull(project.deletedAt),
          ),
        );
    },

    // ── Environment variables ──────────────────────────────────────────

    async listEnvVars(projectId: string, environment?: string, serviceId?: string | null) {
      return db.query.envVar.findMany({
        where: and(...envVarScope(projectId, environment, serviceId)),
      });
    },

    /** Lookup a single env var by id — needed by permission.resolveResourceOrg. */
    async findEnvVarById(id: string) {
      return db.query.envVar.findFirst({ where: eq(envVar.id, id) });
    },

    async setEnvVar(data: Omit<NewEnvVar, "id">) {
      const id = generateId("env");
      const row = { id, ...data };
      await withProjectConfigurationWrite(db, eq(project.id, data.projectId), async (tx) => tx.insert(envVar).values(row));
      return row;
    },

    async updateEnvVar(id: string, value: string) {
      const predicate = inArray(project.id, db.select({ id: envVar.projectId }).from(envVar).where(eq(envVar.id, id)));
      await withProjectConfigurationWrite(db, predicate, async (tx) => tx.update(envVar).set({ value, updatedAt: new Date() }).where(eq(envVar.id, id)));
    },

    async deleteEnvVar(id: string) {
      const predicate = inArray(project.id, db.select({ id: envVar.projectId }).from(envVar).where(eq(envVar.id, id)));
      await withProjectConfigurationWrite(db, predicate, async (tx) => tx.delete(envVar).where(eq(envVar.id, id)));
    },

    /**
     * Full REPLACE of env vars for a project + environment scope (optionally a
     * service). Destructive: deletes the whole scope then inserts `vars`.
     * Atomic — the delete + insert run in one transaction so an insert failure
     * can't leave the scope wiped. Prefer `mergeEnvVars` for partial edits
     * (it never touches untouched vars / masked secrets).
     */
    async bulkSetEnvVars(
      projectId: string,
      environment: string,
      vars: { key: string; value: string; isSecret?: boolean }[],
      serviceId?: string | null,
    ) {
      await db.transaction(async (tx) => {
        await assertProjectConfigurationWritable(tx, eq(project.id, projectId));
        await tx
          .delete(envVar)
          .where(and(...envVarScope(projectId, environment, serviceId ?? null)));

        if (vars.length === 0) return;

        await tx.insert(envVar).values(
          vars.map((v) => ({
            id: generateId("env"),
            projectId,
            environment,
            serviceId: serviceId ?? null,
            key: v.key,
            value: v.value,
            isSecret: v.isSecret ?? false,
          })),
        );
      });
    },

    /**
     * MERGE env vars: upsert the given keys, delete the given keys, and leave
     * every other var (including untouched masked secrets) exactly as-is. Only
     * the keys in (deletes ∪ upserts) are touched, all in one transaction.
     * This is the safe path for a per-variable editor where secret VALUES the
     * user didn't change are never re-sent.
     */
    async mergeEnvVars(
      projectId: string,
      environment: string,
      upserts: { key: string; value: string; isSecret?: boolean }[],
      deletes: string[],
      serviceId?: string | null,
    ) {
      if (!upserts.length && !deletes.length) return;
      return mergeEnvVarScopes(projectId, environment, [{ serviceId, upserts, deletes }]);
    },

    /** Commands and encrypted variables move together, under the configuration lock. */
    async migrateCommandEnvironment(
      projectId: string,
      organizationId: string,
      input: {
        environment: string;
        serviceId?: string;
        commands: Partial<Record<"installCommand" | "buildCommand" | "startCommand", string>>;
      },
    ) {
      return db.transaction(async (tx) => {
        await assertProjectConfigurationWritable(
          tx,
          and(eq(project.id, projectId), eq(project.organizationId, organizationId))!,
        );
        const [owner] = await tx
          .select({ id: project.id })
          .from(project)
          .where(and(eq(project.id, projectId), eq(project.organizationId, organizationId)));
        if (!owner) throw new ForbiddenError("Project is unavailable");
        const row = input.serviceId
          ? (
              await tx
                .select()
                .from(service)
                .where(and(eq(service.id, input.serviceId), eq(service.projectId, projectId)))
                .for("update")
            )[0]
          : (
              await tx
                .select()
                .from(project)
                .where(and(eq(project.id, projectId), eq(project.organizationId, organizationId)))
                .for("update")
            )[0];
        if (!row) throw new ForbiddenError("Configuration is unavailable");
        const update: Partial<Record<"installCommand" | "buildCommand" | "startCommand", string>> =
          {};
        const variables: Record<string, string> = {};
        for (const field of ["installCommand", "buildCommand", "startCommand"] as const) {
          if (input.commands[field] === undefined) continue;
          if (row[field] !== input.commands[field])
            throw new ConflictError("Commands changed. Reload before migrating variables.");
          const parsed = inspectCommandEnvironment(row[field] ?? "");
          if (!parsed.migratable)
            throw new ValidationError(
              `${field} contains shell expressions or has no literal variables to migrate`,
            );
          for (const [key, value] of Object.entries(parsed.variables)) {
            if (Object.hasOwn(variables, key) && variables[key] !== value)
              throw new ConflictError(
                `Commands use different values for ${key}. Resolve the difference before migrating.`,
              );
            variables[key] = value;
          }
          update[field] = parsed.command;
        }
        if (!Object.keys(update).length) throw new ValidationError("Select a command to migrate");
        const existing = await tx
          .select()
          .from(envVar)
          .where(and(...envVarScope(projectId, input.environment, input.serviceId ?? null)));
        const inherited = input.serviceId
          ? await tx
              .select()
              .from(envVar)
              .where(and(...envVarScope(projectId, input.environment, null)))
          : [];
        for (const [key, value] of Object.entries(variables)) {
          const stored = existing.find((v) => v.key === key) ?? inherited.find((v) => v.key === key);
          if (stored) {
            if (encryption.decrypt(stored.value) !== value)
              throw new ConflictError(
                `Environment already has a different value for ${key}. Resolve the difference before migrating.`,
              );
            continue;
          }
          await tx
            .insert(envVar)
            .values({
              id: generateId("env"),
              projectId,
              serviceId: input.serviceId ?? null,
              environment: input.environment,
              key,
              value: encryption.encrypt(value),
              isSecret: true,
            });
        }
        if (input.serviceId)
          await tx
            .update(service)
            .set({ ...update, updatedAt: new Date() })
            .where(and(eq(service.id, input.serviceId), eq(service.projectId, projectId)));
        else
          await tx
            .update(project)
            .set({ ...update, updatedAt: new Date() })
            .where(eq(project.id, projectId));
        return { keys: Object.keys(variables), commands: update };
      });
    },

    async buildCacheMigration(
      projectId: string,
      organizationId: string,
      serviceId?: string,
      remove?: string[],
    ) {
      return db.transaction(async (tx) => {
        await assertProjectConfigurationWritable(tx, eq(project.id, projectId));
        const [owner] = await tx
          .select()
          .from(project)
          .where(and(eq(project.id, projectId), eq(project.organizationId, organizationId)));
        if (!owner) throw new ForbiddenError("Project is unavailable");
        const row = serviceId
          ? (
              await tx
                .select()
                .from(service)
                .where(and(eq(service.id, serviceId), eq(service.projectId, projectId)))
            )[0]
          : owner;
        if (!row) throw new ForbiddenError("Service is unavailable");
        const candidates = manualBuildCaches(row);
        const receipt = owner.buildCacheReceipts?.[serviceId ?? projectId];
        const built = receipt
          ? (
              await tx
                .select()
                .from(deployment)
                .where(
                  and(eq(deployment.id, receipt.deploymentId), eq(deployment.projectId, projectId)),
                )
            )[0]
          : null;
        const canMigrate =
          owner.runtimeMode !== "bare" &&
          built?.status === "ready" &&
          candidates.length > 0 &&
          candidates.every((item) => receipt?.targets.includes(item.target));
        if (remove?.length) {
          if (!canMigrate || remove.some((spec) => !candidates.some((item) => item.spec === spec)))
            throw new ConflictError(
              "Deploy successfully with managed caches before removing these manual mounts. Reload if the configuration changed.",
            );
          const volumes = (row.volumes ?? []).filter((spec) => !remove.includes(spec));
          if (serviceId)
            await tx
              .update(service)
              .set({ volumes, updatedAt: new Date() })
              .where(eq(service.id, serviceId));
          else
            await tx
              .update(project)
              .set({ volumes, updatedAt: new Date() })
              .where(eq(project.id, projectId));
        }
        return {
          candidates,
          canMigrate: Boolean(canMigrate),
          deploymentId: receipt?.deploymentId ?? null,
          removed: remove ?? [],
        };
      });
    },

    async recordBuildCacheReceipt(
      projectId: string,
      scope: string,
      receipt: { targets: string[]; deploymentId: string; completedAt: string; durationMs?: number },
    ) {
      await withProjectConfigurationWrite(db, eq(project.id, projectId), async (tx) => {
        const [row] = await tx.select().from(project).where(eq(project.id, projectId));
        if (row)
          await tx
            .update(project)
            .set({ buildCacheReceipts: { ...row.buildCacheReceipts, [scope]: receipt } })
            .where(eq(project.id, projectId));
      });
    },

    /** Get a map of env vars for injection into builds/containers */
    async getEnvMap(
      projectId: string,
      environment: string,
      serviceId?: string | null,
    ): Promise<Record<string, string>> {
      const rows = await db.query.envVar.findMany({
        where: and(...envVarScope(projectId, environment, serviceId)),
      });
      const map: Record<string, string> = {};
      for (const row of rows) {
        map[row.key] = row.value;
      }
      return map;
    },

    /**
     * Env-var change metadata for a project+environment: each row's scope
     * (serviceId, null = project-level / all services), NAME, and last-modified
     * time. Used by smart redeploy to decide which services need an env-only
     * refresh (updatedAt newer than the active deployment), and by the service
     * restart guard to name the drifted keys back to the operator.
     *
     * `key` is the variable's NAME, never its value — no decryption is involved,
     * so this stays safe to surface in an API error body.
     */
    async listEnvVarChangeMeta(
      projectId: string,
      environment: string,
    ): Promise<Array<{ serviceId: string | null; key: string; updatedAt: Date }>> {
      const rows = await db.query.envVar.findMany({
        where: and(eq(envVar.projectId, projectId), eq(envVar.environment, environment)),
        columns: { serviceId: true, key: true, updatedAt: true },
      });
      return rows.map((r) => ({ serviceId: r.serviceId, key: r.key, updatedAt: r.updatedAt }));
    },
  };
}
