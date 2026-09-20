import { pgTable, text, boolean, integer, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";

/**
 * Personal Access Token — a revocable, per-user Bearer credential for
 * programmatic API access (MCP clients, CLI, scripts). Presented as
 * `Authorization: Bearer opsh_pat_<secret>`; the auth middleware resolves it to
 * the owning user + org and builds the same RequestContext a session would, so
 * the existing permission model applies unchanged.
 *
 * Only the SHA-256 hash of the token is stored — the plaintext is shown to the
 * user exactly once at creation. `tokenPrefix` (e.g. `opsh_pat_ab12`) is kept
 * for display only, so a user can recognise a token in the list.
 */
export const personalAccessToken = pgTable(
  "personal_access_token",
  {
    id: text("id").primaryKey(), // "pat_..."
    userId: text("user_id").notNull(),
    /** Org the token acts in. Null → resolved per request (X-Organization-Id / default). */
    organizationId: text("organization_id"),
    name: text("name").notNull(),
    /** Display-only leading chars of the token; NOT a lookup credential. */
    tokenPrefix: text("token_prefix").notNull(),
    /** SHA-256 hex of the full token — the lookup key. Unique. */
    tokenHash: text("token_hash").notNull().unique(),
    /** Read-only tokens reject mutation methods (POST/PUT/PATCH/DELETE). */
    readOnly: boolean("read_only").notNull().default(false),
    /**
     * When true the token carries its OWN resource grants
     * (personal_access_token_grant) and is enforced as a restricted principal
     * limited to exactly those — even below the owner's role. When false the
     * token acts with the owning user's full role (legacy behavior).
     */
    scoped: boolean("scoped").notNull().default(false),
    /**
     * When set, this row is NOT a user-facing manual token — it's the grant
     * holder for an OAuth MCP client binding, keyed by (userId, oauthClientId).
     * It carries the read-only flag + scoped grants a user chose at OAuth
     * consent, so an OAuth-authorized MCP client runs through the exact same
     * scoped-principal path (`tokenScope` + personal_access_token_grant) as a
     * manual scoped PAT. Never has a real plaintext token; excluded from the
     * manual PAT list.
     */
    oauthClientId: text("oauth_client_id"),
    expiresAt: timestamp("expires_at"),
    lastUsedAt: timestamp("last_used_at"),
    /**
     * Authenticated requests this credential has made. Written by the same
     * best-effort UPDATE as `lastUsedAt`, so it costs nothing extra: one
     * timestamp answers "is this still in use", the counter answers "how much" —
     * the difference between an agent that ran one tool and one that ran a
     * thousand. Approximate by design (the write is fire-and-forget).
     */
    useCount: integer("use_count").notNull().default(0),
    revokedAt: timestamp("revoked_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    index("personal_access_token_user_idx").on(t.userId),
    index("personal_access_token_prefix_idx").on(t.tokenPrefix),
    // One binding row per (user, OAuth client). NULL oauth_client_id (every
    // manual PAT) is distinct under Postgres unique semantics, so manual tokens
    // are unaffected.
    uniqueIndex("personal_access_token_oauth_binding_idx").on(t.userId, t.oauthClientId),
  ],
);
