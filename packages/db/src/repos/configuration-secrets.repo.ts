import { and, asc, eq, gt, or, sql, type SQL } from "drizzle-orm";
import type { Database } from "../connection";
import { deployment, service } from "../schema";
import {
  createConfigurationSecrets,
  isPlainConfiguration,
  SERVICE_SECRET_FIELDS,
  DEPLOYMENT_SECRET_FIELDS,
  type ConfigurationEncryption,
} from "../configuration-secrets";

/** No schema rewrite or unbounded transaction. New writers always seal; the
 * compare-and-swap guards keep a boot-time backfill from losing concurrent edits. */
export function createConfigurationSecretsRepo(db: Database, encryption: ConfigurationEncryption) {
  const codec = createConfigurationSecrets(encryption);
  const nonemptyJson = (cell: SQL) =>
    sql`jsonb_typeof(${cell}) in ('object', 'array') and ${cell} <> '{}'::jsonb and ${cell} <> '[]'::jsonb`;
  return {
    async backfillLegacy(): Promise<{ services: number; deployments: number }> {
      const counts = { services: 0, deployments: 0 };
      let after: string | undefined;
      for (;;) {
        const rows = await db
          .select()
          .from(service)
          .where(
            and(
              after ? gt(service.id, after) : undefined,
              or(...SERVICE_SECRET_FIELDS.map((key) => nonemptyJson(sql`${service[key]}`))),
            ),
          )
          .orderBy(asc(service.id))
          .limit(100);
        if (!rows.length) break;
        for (const row of rows) {
          const patch: Record<string, unknown> = {};
          const unchanged: SQL[] = [eq(service.id, row.id)];
          for (const key of SERVICE_SECRET_FIELDS) {
            if (!isPlainConfiguration(row[key])) continue;
            patch[key] = codec.sealJson(row[key]);
            unchanged.push(
              sql`${service[key]} is not distinct from ${JSON.stringify(row[key])}::jsonb`,
            );
          }
          if (Object.keys(patch).length) {
            const changed = await db
              .update(service)
              .set(patch)
              .where(and(...unchanged))
              .returning();
            counts.services += changed.length;
          }
        }
        after = rows.at(-1)!.id;
      }
      after = undefined;
      for (;;) {
        const rows = await db
          .select({ id: deployment.id, meta: deployment.meta })
          .from(deployment)
          .where(
            and(
              after ? gt(deployment.id, after) : undefined,
              or(
                ...DEPLOYMENT_SECRET_FIELDS.map((key) =>
                  nonemptyJson(sql`${deployment.meta}->${key}`),
                ),
              ),
            ),
          )
          .orderBy(asc(deployment.id))
          .limit(100);
        if (!rows.length) break;
        for (const row of rows) {
          // Leave fields already sealed by another code path untouched.
          const next = { ...(row.meta as Record<string, unknown>) };
          for (const key of DEPLOYMENT_SECRET_FIELDS) {
            if (isPlainConfiguration(next[key])) next[key] = codec.sealJson(next[key]);
          }
          const changed = await db
            .update(deployment)
            .set({ meta: next })
            .where(
              and(
                eq(deployment.id, row.id),
                sql`${deployment.meta} is not distinct from ${JSON.stringify(row.meta)}::jsonb`,
              ),
            )
            .returning();
          counts.deployments += changed.length;
        }
        after = rows.at(-1)!.id;
      }
      return counts;
    },
  };
}
