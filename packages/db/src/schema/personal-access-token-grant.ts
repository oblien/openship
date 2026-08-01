import { pgTable, text, timestamp, uniqueIndex, index } from "drizzle-orm/pg-core";

import { personalAccessToken } from "./personal-access-token";

/**
 * Per-token resource grants — the scope of a scoped PAT.
 *
 * Kept SEPARATE from `resource_grant` (which is keyed by userId) on purpose: a
 * scoped token's grants must never be read by the member-grant queries, so they
 * live in their own table keyed by tokenId. When a scoped token authenticates,
 * the auth path treats it as a restricted principal whose grants are these rows.
 *
 * resourceId matches the same keying as resource_grant: a specific id, "*"
 * (all of type), a GitHub org login, or "owner/repo".
 */
export const personalAccessTokenGrant = pgTable(
  "personal_access_token_grant",
  {
    id: text("id").primaryKey(), // "patgrant_..."
    tokenId: text("token_id")
      .notNull()
      .references(() => personalAccessToken.id, { onDelete: "cascade" }),
    resourceType: text("resource_type").notNull(),
    resourceId: text("resource_id").notNull(),
    permissionsJson: text("permissions_json").notNull().default("[]"),
    /** Source-access scope (NULL = metadata only). See resource-grant.ts. */
    scopeJson: text("scope_json"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("pat_grant_unique").on(t.tokenId, t.resourceType, t.resourceId),
    index("pat_grant_token_idx").on(t.tokenId),
  ],
);
