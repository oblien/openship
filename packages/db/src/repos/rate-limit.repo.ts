import { and, sql } from "drizzle-orm";
import type { Database } from "../client";
import { verification } from "../schema/auth";

interface RateLimitWindow {
  limit: number;
  windowMs: number;
}

export function createRateLimitRepo(db: Database) {
  return {
    /** Check and consume all windows in one write against an expiring record. */
    async reserve(
      key: string,
      windows: readonly [RateLimitWindow, ...RateLimitWindow[]],
    ): Promise<boolean> {
      const now = Date.now();
      const historySize = Math.max(...windows.map(({ limit }) => limit));
      const expiresAt = new Date(now + Math.max(...windows.map(({ windowMs }) => windowMs)));
      const history = sql`(${verification.value}::jsonb)`;
      const below = windows.map(
        ({ limit, windowMs }) =>
          sql`coalesce((${history} ->> ${limit - 1}::int)::bigint, 0) <= ${now - windowMs}`,
      );
      const accepted = await db
        .insert(verification)
        .values({ id: key, identifier: key, value: JSON.stringify([now]), expiresAt })
        .onConflictDoUpdate({
          target: verification.id,
          set: {
            value: sql`(excluded.value::jsonb || (${history} - ${historySize - 1}::int))::text`,
            expiresAt,
          },
          setWhere: and(...below),
        })
        .returning();
      return accepted.length === 1;
    },
  };
}
