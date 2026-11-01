import { and, eq, isNotNull } from "drizzle-orm";
import { generateId } from "@repo/core";
import type { Database } from "../client";
import type { ConfigurationEncryption } from "../configuration-secrets";
import { project, routeProtection } from "../schema";
import { withProjectConfigurationWrite } from "./project-work-admission";

/** Decryption is an explicit private read; public status cannot contain key material. */
export function createRouteProtectionRepo(db: Database, encryption: ConfigurationEncryption) {
  const owned = (projectId: string, hostname: string) =>
    and(eq(routeProtection.projectId, projectId), eq(routeProtection.hostname, hostname));
  return {
    async list(projectId: string) {
      return db
        .select({
          hostname: routeProtection.hostname,
          revision: routeProtection.revision,
          appliedRevision: routeProtection.appliedRevision,
          updatedAt: routeProtection.updatedAt,
          // Return no encrypted secret through this status-only interface either.
          enabled: routeProtection.enabled,
          hasSecret: isNotNull(routeProtection.secret),
        })
        .from(routeProtection)
        .where(eq(routeProtection.projectId, projectId));
    },
    async readPrivate(projectId: string, hostname: string) {
      const [row] = await db.select().from(routeProtection).where(owned(projectId, hostname));
      return row
        ? { ...row, secret: row.secret === null ? null : encryption.decrypt(row.secret) }
        : null;
    },
    async save(projectId: string, hostname: string, revision: string, secret: string | null) {
      const values = {
        projectId,
        hostname,
        revision,
        enabled: secret !== null,
        secret: secret === null ? null : encryption.encrypt(secret),
        appliedRevision: null,
        updatedAt: new Date(),
      };
      await withProjectConfigurationWrite(db, eq(project.id, projectId), async (tx) => {
        await tx
          .insert(routeProtection)
          .values({ id: generateId("rp"), ...values })
          .onConflictDoUpdate({
            target: [routeProtection.projectId, routeProtection.hostname],
            set: values,
          });
      });
    },
    async markApplied(projectId: string, hostname: string, revision: string) {
      await db
        .update(routeProtection)
        .set({ appliedRevision: revision })
        .where(and(owned(projectId, hostname), eq(routeProtection.revision, revision)));
    },
  };
}
