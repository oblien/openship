import { pgTable, text, timestamp, integer, jsonb, uniqueIndex } from "drizzle-orm/pg-core";
import { organization } from "./organization";
import { servers } from "./servers";

/**
 * Proof that a routing TARGET is controlled by us, as required by Openship Cloud's
 * shared edge before it will forward `<slug>.opsh.io` there.
 *
 * Keyed on (organization, target) because that is what the upstream keys it on: one
 * target serves every free domain on that box, so this is target-level state, not
 * domain-level. One install can hold several rows — its own address plus one per
 * remote server it deploys to.
 *
 * WHY THE TOKEN IS PERSISTED HERE and not just written to the edge: the upstream's
 * list endpoint returns id/target/status/expiry but NOT the token, so a token living
 * only on the box's disk is unrecoverable after a rebuild. Verification lasts 90 days
 * and the upstream re-probes THE SAME TOKEN within 7 days of expiry — a 404 then
 * expires the verification and the free domain stops resolving ~83 days after a green
 * deploy, with nothing in our logs. So rows are NEVER deleted when a free domain is
 * dropped, and the token is re-assertable from here forever.
 */
export const edgeTargetVerification = pgTable(
  "edge_target_verification",
  {
    id: text("id").primaryKey(), // "etv_..."
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    /**
     * The canonical target string sent upstream (`http://<host>`), byte-identical to
     * the one the proxy sync sends. The upstream normalizes to
     * `scheme://host:port` and matches on it, so verifying one string and routing
     * another is a permanent `target_unverified` that looks like a broken feature.
     */
    target: text("target").notNull(),
    /** Bare host from `target` — what the challenge vhost's `server_name` must be. */
    host: text("host").notNull(),
    /**
     * Which box answers for this target; null = the control-plane box itself. Not a
     * cascade delete: losing the server row must not drop the token (see above), and
     * the target may still be reachable.
     */
    serverId: text("server_id").references(() => servers.id, { onDelete: "set null" }),
    /** Upstream's numeric verification id, needed to run the check. */
    verificationId: integer("verification_id"),
    /** The token currently expected at `challengePath`. Served permanently. */
    token: text("token"),
    /**
     * Previously-issued tokens, still served. A re-request resets the token while an
     * older record's scheduler may still probe the previous one, so dropping them
     * would fail a verification that was working. Capped by the writer.
     */
    retiredTokens: jsonb("retired_tokens").$type<string[]>(),
    /** Path the upstream returned. Stored rather than reconstructed — if the shape
     *  ever changes, a rebuilt path would 404 silently months later. */
    challengePath: text("challenge_path"),
    /** pending | verified | failed | expired */
    status: text("status").notNull().default("pending"),
    /** Public IP the target resolved to when last proven; the route is pinned to it,
     *  so a change here means re-verification is needed. */
    validatedIp: text("validated_ip"),
    expiresAt: timestamp("expires_at"),
    /** Gates re-attempts — the upstream rate-limits checks and caps failures. */
    lastCheckedAt: timestamp("last_checked_at"),
    /** Last failure reason, verbatim, for the operator-facing message. */
    lastError: text("last_error"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("uq_edge_target_verification").on(t.organizationId, t.target)],
);
