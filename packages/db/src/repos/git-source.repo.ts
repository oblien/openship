import { and, asc, desc, eq, gt, isNull } from "drizzle-orm";
import { generateId } from "@repo/core";
import type { Database } from "../client";
import { githubInstallState, gitInstallation, gitSource } from "../schema";
import { rebindGitHubInstallationRows } from "./project.repo";

export type GitSource = typeof gitSource.$inferSelect;
export type NewGitSource = typeof gitSource.$inferInsert;

type CreateGitSourceData = Omit<NewGitSource, "id" | "provider" | "createdAt" | "updatedAt">;

async function insertSource(database: Database, data: CreateGitSourceData): Promise<GitSource> {
  const existingDefault = await database.query.gitSource.findFirst({
    where: and(
      eq(gitSource.organizationId, data.organizationId),
      eq(gitSource.provider, "github"),
      eq(gitSource.status, "active"),
      eq(gitSource.isDefault, true),
    ),
    columns: { id: true },
  });
  // The first usable source becomes the default even if an older invalid row
  // remains for repair. Otherwise the UI can show active sources while runtime
  // selection has no declared default.
  const makeDefault = data.isDefault === true || !existingDefault;
  if (makeDefault) {
    await database
      .update(gitSource)
      .set({ isDefault: false, updatedAt: new Date() })
      .where(
        and(eq(gitSource.organizationId, data.organizationId), eq(gitSource.provider, "github")),
      );
  }
  const [created] = await database
    .insert(gitSource)
    .values({
      id: generateId("src"),
      provider: "github",
      ...data,
      isDefault: makeDefault,
    })
    .returning();
  if (!created) throw new Error("git source insert did not persist");
  return created;
}

/**
 * Organization-scoped storage for independently registered Git provider Apps.
 * Secret encryption belongs to the API service; this repository treats the
 * envelope as opaque and never returns a row without an explicit scope except
 * through the webhook-only active-source lookups.
 */
export function createGitSourceRepo(db: Database) {
  return {
    async listByOrganization(organizationId: string): Promise<GitSource[]> {
      return db.query.gitSource.findMany({
        where: and(eq(gitSource.organizationId, organizationId), eq(gitSource.provider, "github")),
        orderBy: [desc(gitSource.isDefault), asc(gitSource.createdAt)],
      });
    },

    async listActiveByOrganization(organizationId: string): Promise<GitSource[]> {
      return db.query.gitSource.findMany({
        where: and(
          eq(gitSource.organizationId, organizationId),
          eq(gitSource.provider, "github"),
          eq(gitSource.status, "active"),
        ),
        orderBy: [desc(gitSource.isDefault), asc(gitSource.createdAt)],
      });
    },

    async findById(organizationId: string, id: string): Promise<GitSource | undefined> {
      return db.query.gitSource.findFirst({
        where: and(
          eq(gitSource.organizationId, organizationId),
          eq(gitSource.id, id),
          eq(gitSource.provider, "github"),
        ),
      });
    },

    async findActiveById(organizationId: string, id: string): Promise<GitSource | undefined> {
      return db.query.gitSource.findFirst({
        where: and(
          eq(gitSource.organizationId, organizationId),
          eq(gitSource.id, id),
          eq(gitSource.provider, "github"),
          eq(gitSource.status, "active"),
        ),
      });
    },

    async findDefault(organizationId: string): Promise<GitSource | undefined> {
      return db.query.gitSource.findFirst({
        where: and(
          eq(gitSource.organizationId, organizationId),
          eq(gitSource.provider, "github"),
          eq(gitSource.status, "active"),
          eq(gitSource.isDefault, true),
        ),
      });
    },

    /** Internal webhook lookup. The caller still verifies the HMAC. */
    async listActiveByAppId(appId: number): Promise<GitSource[]> {
      return db.query.gitSource.findMany({
        where: and(
          eq(gitSource.provider, "github"),
          eq(gitSource.status, "active"),
          eq(gitSource.appId, appId),
        ),
      });
    },

    /** Ping deliveries may not carry an installation id; HMAC tries active Apps. */
    async listAllActive(): Promise<GitSource[]> {
      return db.query.gitSource.findMany({
        where: and(eq(gitSource.provider, "github"), eq(gitSource.status, "active")),
      });
    },

    async nameTaken(organizationId: string, name: string, exceptId?: string): Promise<boolean> {
      const rows = await db.query.gitSource.findMany({
        where: and(eq(gitSource.organizationId, organizationId), eq(gitSource.provider, "github")),
        columns: { id: true, name: true },
      });
      // The DB index compares lower(name); mirror it here for a useful 409.
      return rows.some(
        (row) => row.id !== exceptId && row.name.toLowerCase() === name.toLowerCase(),
      );
    },

    async appTaken(
      organizationId: string,
      apiBaseUrl: string,
      appId: number,
      exceptId?: string,
    ): Promise<boolean> {
      const rows = await db.query.gitSource.findMany({
        where: and(
          eq(gitSource.organizationId, organizationId),
          eq(gitSource.provider, "github"),
          eq(gitSource.apiBaseUrl, apiBaseUrl),
          eq(gitSource.appId, appId),
        ),
        columns: { id: true },
      });
      return rows.some((row) => row.id !== exceptId);
    },

    async create(data: CreateGitSourceData): Promise<GitSource> {
      return db.transaction((tx) => insertSource(tx, data));
    },

    /** Consume a user/org-bound manifest nonce and persist its converted App in
     * the same transaction, so replay can never create a second source. */
    async createFromManifestState(
      state: string,
      userId: string,
      organizationId: string,
      data: CreateGitSourceData,
    ): Promise<GitSource | null> {
      return db.transaction(async (tx) => {
        const [binding] = await tx
          .delete(githubInstallState)
          .where(
            and(
              eq(githubInstallState.state, state),
              eq(githubInstallState.userId, userId),
              eq(githubInstallState.organizationId, organizationId),
              eq(githubInstallState.flow, "manifest"),
              isNull(githubInstallState.sourceId),
              gt(githubInstallState.expiresAt, new Date()),
            ),
          )
          .returning();
        if (!binding) return null;
        return insertSource(tx, data);
      });
    },

    async update(
      organizationId: string,
      id: string,
      patch: Partial<
        Pick<
          NewGitSource,
          | "name"
          | "appId"
          | "slug"
          | "clientId"
          | "appName"
          | "avatarUrl"
          | "apiBaseUrl"
          | "webBaseUrl"
          | "webhookUrl"
          | "secretsEnc"
          | "status"
          | "lastVerifiedAt"
          | "lastError"
        >
      >,
    ): Promise<GitSource | undefined> {
      const [updated] = await db
        .update(gitSource)
        .set({ ...patch, updatedAt: new Date() })
        .where(
          and(
            eq(gitSource.organizationId, organizationId),
            eq(gitSource.id, id),
            eq(gitSource.provider, "github"),
          ),
        )
        .returning();
      return updated;
    },

    async setDefault(organizationId: string, id: string): Promise<GitSource | undefined> {
      return db.transaction(async (tx) => {
        const source = await tx.query.gitSource.findFirst({
          where: and(
            eq(gitSource.organizationId, organizationId),
            eq(gitSource.id, id),
            eq(gitSource.provider, "github"),
            eq(gitSource.status, "active"),
          ),
        });
        if (!source) return undefined;
        await tx
          .update(gitSource)
          .set({ isDefault: false, updatedAt: new Date() })
          .where(
            and(eq(gitSource.organizationId, organizationId), eq(gitSource.provider, "github")),
          );
        const [updated] = await tx
          .update(gitSource)
          .set({ isDefault: true, updatedAt: new Date() })
          .where(eq(gitSource.id, id))
          .returning();

        // Existing projects snapshot an installation id for webhook tenant
        // isolation. When the operator changes the preferred App, move each
        // owner covered by that App in the same transaction; otherwise the UI
        // would say "default" while established projects silently kept using
        // the old source forever.
        const installations = await tx.query.gitInstallation.findMany({
          where: and(
            eq(gitInstallation.organizationId, organizationId),
            eq(gitInstallation.sourceId, id),
            isNull(gitInstallation.suspendedAt),
          ),
        });
        for (const installation of installations) {
          await rebindGitHubInstallationRows(
            tx,
            organizationId,
            installation.owner,
            installation.installationId,
          );
        }
        return updated;
      });
    },

    async markVerified(organizationId: string, id: string): Promise<void> {
      await db
        .update(gitSource)
        .set({
          status: "active",
          lastVerifiedAt: new Date(),
          lastError: null,
          updatedAt: new Date(),
        })
        .where(and(eq(gitSource.organizationId, organizationId), eq(gitSource.id, id)));
    },

    async markInvalid(organizationId: string, id: string, reason: string): Promise<void> {
      await db
        .update(gitSource)
        .set({ status: "invalid", lastError: reason.slice(0, 500), updatedAt: new Date() })
        .where(and(eq(gitSource.organizationId, organizationId), eq(gitSource.id, id)));
    },

    async remove(organizationId: string, id: string): Promise<GitSource | undefined> {
      const [removed] = await db
        .delete(gitSource)
        .where(
          and(
            eq(gitSource.organizationId, organizationId),
            eq(gitSource.id, id),
            eq(gitSource.provider, "github"),
          ),
        )
        .returning();
      if (!removed?.isDefault) return removed;

      // Keep the invariant useful after deletion: promote the oldest remaining
      // active source. This runs after the delete; the partial unique index
      // guarantees concurrent attempts cannot create two defaults.
      const next = await db.query.gitSource.findFirst({
        where: and(
          eq(gitSource.organizationId, organizationId),
          eq(gitSource.provider, "github"),
          eq(gitSource.status, "active"),
        ),
        orderBy: [asc(gitSource.createdAt)],
      });
      if (next) {
        await db
          .update(gitSource)
          .set({ isDefault: true, updatedAt: new Date() })
          .where(and(eq(gitSource.organizationId, organizationId), eq(gitSource.id, next.id)));
      }
      return removed;
    },
  };
}
