import { eq, and, isNull, gt, or, sql, asc } from "drizzle-orm";
import { randomUUID } from "crypto";
import type { Database } from "../client";
import {
  gitInstallation,
  githubInstallState,
  gitSource,
  project,
  projectGroup,
  resourceGrant,
} from "../schema";
import { rebindGitHubInstallationRows } from "./project.repo";

// ─── Types ───────────────────────────────────────────────────────────────────

export type GitInstallation = typeof gitInstallation.$inferSelect;
export type NewGitInstallation = typeof gitInstallation.$inferInsert;

async function findPreferredInstallation(
  database: Database,
  organizationId: string,
  owner: string,
) {
  const rows = await database
    .select({ installation: gitInstallation })
    .from(gitInstallation)
    .leftJoin(gitSource, eq(gitInstallation.sourceId, gitSource.id))
    .where(
      and(
        eq(gitInstallation.organizationId, organizationId),
        eq(gitInstallation.provider, "github"),
        eq(gitInstallation.owner, owner.toLowerCase()),
        isNull(gitInstallation.suspendedAt),
        or(isNull(gitInstallation.sourceId), eq(gitSource.status, "active")),
      ),
    )
    .orderBy(
      sql`
      CASE
        WHEN ${gitSource.isDefault} = true THEN 0
        WHEN ${gitInstallation.sourceId} IS NOT NULL THEN 1
        ELSE 2
      END
    `,
      asc(gitSource.createdAt),
      asc(gitInstallation.createdAt),
    )
    .limit(1);
  return rows[0]?.installation;
}

async function upsertInstallation(
  db: Database,
  data: Omit<NewGitInstallation, "id">,
): Promise<GitInstallation> {
  const id = randomUUID();
  const row = { id, ...data, sourceId: data.sourceId ?? null, owner: data.owner.toLowerCase() };
  const now = new Date();
  const sourced = Boolean(data.sourceId);
  const [returned] = await db
    .insert(gitInstallation)
    .values(row)
    .onConflictDoUpdate({
      target: sourced
        ? [
            gitInstallation.provider,
            gitInstallation.owner,
            gitInstallation.organizationId,
            gitInstallation.sourceId,
          ]
        : [gitInstallation.provider, gitInstallation.owner, gitInstallation.organizationId],
      targetWhere: sourced
        ? sql`${gitInstallation.sourceId} IS NOT NULL`
        : sql`${gitInstallation.sourceId} IS NULL`,
      set: {
        userId: data.userId,
        installationId: data.installationId,
        organizationId: data.organizationId,
        sourceId: data.sourceId ?? null,
        ownerType: data.ownerType,
        providerUserId: data.providerUserId ?? null,
        providerOwnerId: data.providerOwnerId ?? null,
        isOrg: data.isOrg ?? false,
        suspendedAt: data.suspendedAt ?? null,
        updatedAt: now,
      },
    })
    .returning();
  return returned ?? { ...row, createdAt: now, updatedAt: now };
}

async function rebindAfterInstallationLoss(
  database: Database,
  removed: GitInstallation[],
): Promise<Array<{ organizationId: string; owner: string; hasReplacement: boolean }>> {
  const seen = new Set<string>();
  const reconciled: Array<{
    organizationId: string;
    owner: string;
    hasReplacement: boolean;
  }> = [];
  for (const row of removed) {
    const key = `${row.organizationId}\0${row.owner}\0${row.installationId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const replacement = await findPreferredInstallation(database, row.organizationId, row.owner);
    const installationId = replacement?.installationId ?? null;
    reconciled.push({
      organizationId: row.organizationId,
      owner: row.owner,
      hasReplacement: replacement !== undefined,
    });
    const updatedAt = new Date();
    await database
      .update(project)
      .set({
        installationId,
        ...(installationId === null ? { autoDeploy: false } : {}),
        updatedAt,
      })
      .where(
        and(
          eq(project.organizationId, row.organizationId),
          eq(project.gitProvider, "github"),
          sql`lower(${project.gitOwner}) = ${row.owner.toLowerCase()}`,
          eq(project.installationId, row.installationId),
        ),
      );
    await database
      .update(projectGroup)
      .set({ installationId, updatedAt })
      .where(
        and(
          eq(projectGroup.organizationId, row.organizationId),
          eq(projectGroup.gitProvider, "github"),
          sql`lower(${projectGroup.gitOwner}) = ${row.owner.toLowerCase()}`,
          eq(projectGroup.installationId, row.installationId),
        ),
      );
  }
  return reconciled;
}

async function deleteGitHubGrantsForOwner(
  database: Database,
  organizationId: string,
  owner: string,
): Promise<void> {
  const ownerKey = owner.toLowerCase();
  await database.delete(resourceGrant).where(
    and(
      eq(resourceGrant.organizationId, organizationId),
      sql`(
        (${resourceGrant.resourceType} = 'github_installation' AND lower(${resourceGrant.resourceId}) = ${ownerKey})
        OR (${resourceGrant.resourceType} = 'github_repository' AND lower(${resourceGrant.resourceId}) LIKE ${`${ownerKey}/%`})
      )`,
    ),
  );
}

// ─── Repository ──────────────────────────────────────────────────────────────

export function createGitInstallationRepo(db: Database) {
  return {
    /** Find installation by user + owner */
    async findByOwner(userId: string, owner: string) {
      return db.query.gitInstallation.findFirst({
        where: and(
          eq(gitInstallation.userId, userId),
          eq(gitInstallation.provider, "github"),
          eq(gitInstallation.owner, owner.toLowerCase()),
          isNull(gitInstallation.suspendedAt),
        ),
      });
    },

    /**
     * Find installation by organization + owner.
     *
     * Multi-user/org scoping path: a single GitHub App installation may be
     * accessed by any member of the owning org. Resolution by org is the
     * preferred path for multi-user — `findByOwner(userId, ...)` ties the
     * installation to whichever member happened to install it, which breaks
     * the moment that user leaves the org.
     */
    async findByOrgAndOwner(organizationId: string, owner: string) {
      return findPreferredInstallation(db, organizationId, owner);
    },

    /** Resolve a caller-supplied/project-snapshotted installation only inside
     * the active organization and owner. This makes the id useful without ever
     * treating it as authorization. */
    async findByOrgOwnerAndInstallationId(
      organizationId: string,
      owner: string,
      installationId: number,
    ) {
      const row = await db
        .select({ installation: gitInstallation })
        .from(gitInstallation)
        .leftJoin(gitSource, eq(gitInstallation.sourceId, gitSource.id))
        .where(
          and(
            eq(gitInstallation.organizationId, organizationId),
            eq(gitInstallation.provider, "github"),
            eq(gitInstallation.owner, owner.toLowerCase()),
            eq(gitInstallation.installationId, installationId),
            isNull(gitInstallation.suspendedAt),
            or(isNull(gitInstallation.sourceId), eq(gitSource.status, "active")),
          ),
        )
        .limit(1);
      return row[0]?.installation;
    },

    /** Find all installations for a user */
    async listByUser(userId: string) {
      return db.query.gitInstallation.findMany({
        where: and(
          eq(gitInstallation.userId, userId),
          eq(gitInstallation.provider, "github"),
          isNull(gitInstallation.suspendedAt),
        ),
      });
    },

    /** List installations explicitly connected to one Openship workspace. */
    async listByOrganization(organizationId: string) {
      const rows = await db
        .select({ installation: gitInstallation })
        .from(gitInstallation)
        .leftJoin(gitSource, eq(gitInstallation.sourceId, gitSource.id))
        .where(
          and(
            eq(gitInstallation.organizationId, organizationId),
            eq(gitInstallation.provider, "github"),
            isNull(gitInstallation.suspendedAt),
            or(isNull(gitInstallation.sourceId), eq(gitSource.status, "active")),
          ),
        )
        .orderBy(
          sql`
          CASE
            WHEN ${gitSource.isDefault} = true THEN 0
            WHEN ${gitInstallation.sourceId} IS NOT NULL THEN 1
            ELSE 2
          END
        `,
          asc(gitSource.createdAt),
          asc(gitInstallation.createdAt),
        );
      return rows.map((row) => row.installation);
    },

    /** Administrative view, including bindings whose source is currently
     * invalid. Token resolution must use listByOrganization/findPreferred. */
    async listAllByOrganization(organizationId: string) {
      return db.query.gitInstallation.findMany({
        where: and(
          eq(gitInstallation.organizationId, organizationId),
          eq(gitInstallation.provider, "github"),
        ),
      });
    },

    /** Find every workspace binding for an App installation id. */
    async findByInstallationIdForProvider(installationId: number, sourceId?: string | null) {
      return db.query.gitInstallation.findMany({
        where: and(
          eq(gitInstallation.provider, "github"),
          eq(gitInstallation.installationId, installationId),
          ...(sourceId === undefined
            ? []
            : [
                sourceId === null
                  ? isNull(gitInstallation.sourceId)
                  : eq(gitInstallation.sourceId, sourceId),
              ]),
        ),
      });
    },

    /**
     * Atomic upsert keyed on (provider, owner, organizationId). The workspace
     * is the security boundary; userId is attribution, not ownership. A
     * re-install refreshes the row while concurrent callbacks converge.
     */
    async upsert(data: Omit<NewGitInstallation, "id">) {
      return db.transaction(async (tx) => {
        const installation = await upsertInstallation(tx, data);
        const preferred = await findPreferredInstallation(tx, data.organizationId, data.owner);
        if (preferred) {
          await rebindGitHubInstallationRows(
            tx,
            data.organizationId,
            data.owner,
            preferred.installationId,
          );
        }
        return installation;
      });
    },

    /**
     * Consume the verified one-time setup state, upsert the workspace binding,
     * and reconcile every existing project source in one transaction. A crash
     * can therefore leave either the whole claim committed or the nonce still
     * retryable—never a consumed state with a half-bound installation.
     */
    async claimWithState(
      state: string,
      data: Omit<NewGitInstallation, "id">,
    ): Promise<GitInstallation | null> {
      return db.transaction(async (tx) => {
        const [binding] = await tx
          .delete(githubInstallState)
          .where(
            and(
              eq(githubInstallState.state, state),
              eq(githubInstallState.userId, data.userId),
              eq(githubInstallState.organizationId, data.organizationId),
              data.sourceId
                ? eq(githubInstallState.sourceId, data.sourceId)
                : isNull(githubInstallState.sourceId),
              eq(githubInstallState.flow, "install"),
              gt(githubInstallState.expiresAt, new Date()),
            ),
          )
          .returning();
        if (!binding) return null;

        const installation = await upsertInstallation(tx, data);
        const preferred = await findPreferredInstallation(tx, data.organizationId, data.owner);
        if (preferred) {
          await rebindGitHubInstallationRows(
            tx,
            data.organizationId,
            data.owner,
            preferred.installationId,
          );
        }
        return installation;
      });
    },

    /** Replace one user's OAuth-derived snapshot inside one workspace only. */
    async replaceForUserInOrganization(
      userId: string,
      organizationId: string,
      data: Array<Omit<NewGitInstallation, "id" | "userId" | "provider" | "organizationId">>,
    ) {
      const rows = data.map((installation) => ({
        id: randomUUID(),
        userId,
        organizationId,
        provider: "github",
        ...installation,
        sourceId: null,
        owner: installation.owner.toLowerCase(),
      }));

      const replace = async (tx: Database) => {
        await tx
          .delete(gitInstallation)
          .where(
            and(
              eq(gitInstallation.userId, userId),
              eq(gitInstallation.organizationId, organizationId),
              eq(gitInstallation.provider, "github"),
              isNull(gitInstallation.sourceId),
            ),
          );

        if (rows.length > 0) {
          for (const row of rows) {
            await tx
              .insert(gitInstallation)
              .values(row)
              .onConflictDoUpdate({
                target: [
                  gitInstallation.provider,
                  gitInstallation.owner,
                  gitInstallation.organizationId,
                ],
                targetWhere: sql`${gitInstallation.sourceId} IS NULL`,
                set: {
                  userId,
                  installationId: row.installationId,
                  ownerType: row.ownerType,
                  providerUserId: row.providerUserId ?? null,
                  providerOwnerId: row.providerOwnerId ?? null,
                  isOrg: row.isOrg ?? false,
                  suspendedAt: row.suspendedAt ?? null,
                  updatedAt: new Date(),
                },
              });
          }
        }
      };

      await db.transaction(replace);
    },

    /** Remove installation by user + owner */
    async removeByOwner(userId: string, owner: string) {
      return db
        .delete(gitInstallation)
        .where(
          and(
            eq(gitInstallation.userId, userId),
            eq(gitInstallation.provider, "github"),
            eq(gitInstallation.owner, owner.toLowerCase()),
          ),
        );
    },

    /** Remove installation by installation_id */
    async removeByInstallationId(userId: string, installationId: number) {
      return db
        .delete(gitInstallation)
        .where(
          and(
            eq(gitInstallation.userId, userId),
            eq(gitInstallation.provider, "github"),
            eq(gitInstallation.installationId, installationId),
          ),
        );
    },

    /** Remove installation rows by installation_id, regardless of linked OAuth account */
    async removeByInstallationIdForProvider(installationId: number, sourceId?: string | null) {
      return db.transaction(async (tx) => {
        const condition = and(
          eq(gitInstallation.provider, "github"),
          eq(gitInstallation.installationId, installationId),
          ...(sourceId === undefined
            ? []
            : [
                sourceId === null
                  ? isNull(gitInstallation.sourceId)
                  : eq(gitInstallation.sourceId, sourceId),
              ]),
        );
        const removed = await tx.delete(gitInstallation).where(condition).returning();
        await rebindAfterInstallationLoss(tx, removed);
        return removed;
      });
    },

    /** Mark a reversible GitHub suspension without losing workspace ownership. */
    async suspendByInstallationIdForProvider(installationId: number, sourceId?: string | null) {
      return db.transaction(async (tx) => {
        const condition = and(
          eq(gitInstallation.provider, "github"),
          eq(gitInstallation.installationId, installationId),
          ...(sourceId === undefined
            ? []
            : [
                sourceId === null
                  ? isNull(gitInstallation.sourceId)
                  : eq(gitInstallation.sourceId, sourceId),
              ]),
        );
        const suspended = await tx
          .update(gitInstallation)
          .set({ suspendedAt: new Date(), updatedAt: new Date() })
          .where(condition)
          .returning();
        await rebindAfterInstallationLoss(tx, suspended);
        return suspended;
      });
    },

    /**
     * Delete one custom source and all of its installation bindings, promote a
     * replacement default, and repair project snapshots in one transaction.
     * A project is rebound to another active installation for the same owner or
     * cleared; it is never left pointing at a deleted source's id.
     */
    async removeSourceAndRebind(organizationId: string, sourceId: string) {
      return db.transaction(async (tx) => {
        const source = await tx.query.gitSource.findFirst({
          where: and(
            eq(gitSource.organizationId, organizationId),
            eq(gitSource.id, sourceId),
            eq(gitSource.provider, "github"),
          ),
        });
        if (!source) return undefined;

        const installations = await tx.query.gitInstallation.findMany({
          where: and(
            eq(gitInstallation.organizationId, organizationId),
            eq(gitInstallation.sourceId, sourceId),
          ),
        });
        await tx.delete(gitSource).where(eq(gitSource.id, sourceId));

        if (source.isDefault) {
          const next = await tx.query.gitSource.findFirst({
            where: and(
              eq(gitSource.organizationId, organizationId),
              eq(gitSource.provider, "github"),
              eq(gitSource.status, "active"),
            ),
            orderBy: [asc(gitSource.createdAt)],
          });
          if (next) {
            await tx
              .update(gitSource)
              .set({ isDefault: true, updatedAt: new Date() })
              .where(eq(gitSource.id, next.id));
          }
        }

        const reconciled = await rebindAfterInstallationLoss(tx, installations);
        // Grants describe access to an owner/repository, not to a particular
        // App. Preserve them when another source still covers that owner; prune
        // them when deleting this source removes the workspace's last usable
        // installation so stale access cannot spring back on a later reconnect.
        for (const row of reconciled) {
          if (!row.hasReplacement) {
            await deleteGitHubGrantsForOwner(tx, row.organizationId, row.owner);
          }
        }
        return source;
      });
    },

    /** Remove all GitHub installations for a user */
    async removeAllForUser(userId: string) {
      return db
        .delete(gitInstallation)
        .where(and(eq(gitInstallation.userId, userId), eq(gitInstallation.provider, "github")));
    },
  };
}
