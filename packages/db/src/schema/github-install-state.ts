import { sql } from "drizzle-orm";
import { pgTable, text, timestamp, index, jsonb } from "drizzle-orm/pg-core";
import { gitSource } from "./git-source";

export interface GithubInstallStatePayload {
  /** Operator-facing label retained through the external manifest round-trip. */
  name?: string;
  apiBaseUrl?: string;
  webBaseUrl?: string;
}

/**
 * One-time, session-bound nonce minted when a user kicks off the GitHub
 * App install flow.
 *
 * Why this exists
 * ───────────────
 * The `state` parameter returned by the SaaS install-URL endpoint used
 * to be echoed straight back through to GitHub with no local binding.
 * Any actor who could observe (or guess) a state value could ride
 * someone else's install completion — the local instance had no record
 * of who had asked for that state.
 *
 * This table is the local binding: every state we hand back to a user
 * gets a row here, keyed by the state nonce, carrying the originating
 * user/org. When the install-complete callback (or webhook) fires with
 * a matching state, we look the row up, verify the caller matches the
 * stored userId/organizationId, then DELETE the row so the binding is
 * one-shot.
 *
 * Cleanup
 * ───────
 * Rows past expiresAt are dropped lazily by `purgeExpired` (called on
 * each create) — same pattern as `cloud_handoff_code`. No background
 * sweeper required. Default TTL is 10 minutes (binds the install flow
 * window; longer than the user spends choosing repos, shorter than any
 * meaningful pivoting attack window).
 */
export const githubInstallState = pgTable(
  "github_install_state",
  {
    id: text("id").primaryKey(), // "gis_..."
    /** The state nonce echoed to GitHub. Unique per row — the credential. */
    state: text("state").notNull().unique(),
    /** User who initiated the install URL request. */
    userId: text("user_id").notNull(),
    /** Org id resolved for the user at request time (nullable when no org). */
    organizationId: text("organization_id"),
    /** Source being installed. Null for legacy env/Cloud App flows and manifests. */
    sourceId: text("source_id").references(() => gitSource.id, { onDelete: "cascade" }),
    /** `install` or `manifest`; text keeps future setup flows migration-free. */
    flow: text("flow").notNull().default("install"),
    /** Non-secret manifest setup inputs. Never stores conversion credentials. */
    payload: jsonb("payload")
      .$type<GithubInstallStatePayload>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    expiresAt: timestamp("expires_at").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    index("github_install_state_expires_idx").on(t.expiresAt),
    index("github_install_state_user_idx").on(t.userId),
  ],
);
