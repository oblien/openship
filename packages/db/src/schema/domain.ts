import {
  pgTable,
  text,
  timestamp,
  boolean,
  integer,
  index,
} from "drizzle-orm/pg-core";
import { project } from "./project";
import { service } from "./service";
import { webhookSource } from "./webhook-source";

// ─── Domains ─────────────────────────────────────────────────────────────────

/**
 * Custom domains linked to a project OR a webhook source (polymorphic owner).
 * Each domain goes through a verification flow (DNS TXT record check)
 * before becoming active and getting SSL provisioned.
 */
export const domain = pgTable("domain", {
  id: text("id").primaryKey(), // "dom_..."
  /**
   * Owner discriminator: "project" (the default — routes to a deployed app) or
   * "webhook" (routes to the inbound webhook receiver for `webhookSourceId`).
   * Existing rows backfill to "project" via the column default.
   */
  ownerType: text("owner_type").notNull().default("project"),
  /** Owning project — NULL for a webhook-owned domain (ownerType='webhook'). */
  projectId: text("project_id")
    .references(() => project.id, { onDelete: "cascade" }),
  /** Owning webhook source — set when ownerType='webhook'; routes to the receiver. */
  webhookSourceId: text("webhook_source_id")
    .references(() => webhookSource.id, { onDelete: "cascade" }),
  /** Service ID for service-scoped domain routing (null = project-level / main service) */
  serviceId: text("service_id").references(() => service.id, { onDelete: "cascade" }),

  /** The custom domain (e.g. "app.example.com") */
  hostname: text("hostname").notNull().unique(),
  /** Internal target port this hostname should route to */
  targetPort: integer("target_port"),
  /** Static output subpath this hostname should serve */
  targetPath: text("target_path"),
  /** Route kind: managed/free subdomain or custom domain */
  domainType: text("domain_type"),
  /** Is this the primary domain for the project? */
  isPrimary: boolean("is_primary").notNull().default(false),

  /**
   * Externally-managed ingress + TLS. When true, an upstream (Cloudflare Tunnel,
   * a load balancer, etc.) terminates TLS and forwards HTTP to this box, so the
   * hostname does NOT resolve to the server's (possibly Tailscale) SSH address.
   * Openship then: verifies ownership via TXT only (no A-record check), skips
   * certbot, and serves a plain-HTTP OpenResty route. DNS/LB/firewall stay
   * outside Openship.
   */
  externalIngress: boolean("external_ingress").notNull().default(false),

  /**
   * Origin TLS from an operator-supplied certificate (bring-your-own /
   * Cloudflare Origin CA) instead of certbot. When true we serve HTTPS from
   * the uploaded cert and never run ACME — this is what lets an
   * externalIngress domain (Cloudflare Full-strict, L4 passthrough LB) hold a
   * real cert at origin even though DNS points upstream. Orthogonal to
   * externalIngress; also valid on a direct domain that supplies its own cert.
   * The cert itself lives on disk (see the SSL block); this flag is the
   * route-planner signal and survives verify/recheck (which would otherwise
   * relabel sslIssuer back to "certbot").
   */
  manualSsl: boolean("manual_ssl").notNull().default(false),

  /* ── Verification ───────────────────────────────────────────────────── */
  /** Domain status: pending | active | failed | removing */
  status: text("status").notNull().default("pending"),
  /** DNS TXT verification value (e.g. "openship-verify=abc123") */
  verificationToken: text("verification_token"),
  /** Whether DNS verification has passed */
  verified: boolean("verified").notNull().default(false),
  verifiedAt: timestamp("verified_at"),
  /**
   * Verify state machine (so the UI can tell never-tried vs propagating vs
   * persistently-failing, instead of an eternal "pending"). `verifyAttempts`
   * counts consecutive failed checks (reset to 0 on success); `lastVerifyError`
   * is the most recent human-readable failure reason; `lastCheckedAt` is when
   * verify last ran (manual or the auto cron). Status flips to `failed` only
   * after enough attempts that it's clearly misconfigured, not mid-propagation.
   */
  verifyAttempts: integer("verify_attempts").notNull().default(0),
  lastVerifyError: text("last_verify_error"),
  lastCheckedAt: timestamp("last_checked_at"),

  /* ── SSL ─────────────────────────────────────────────────────────────── */
  /** SSL status: none | provisioning | active | expired | error */
  sslStatus: text("ssl_status").notNull().default("none"),
  /** Issuer (e.g. "letsencrypt", "oblien") */
  sslIssuer: text("ssl_issuer"),
  /** When the current certificate expires */
  sslExpiresAt: timestamp("ssl_expires_at"),

  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (t) => [
  // Routing hot path — every request that resolves a hostname hits this.
  index("idx_domain_project").on(t.projectId),
  index("idx_domain_project_hostname").on(t.projectId, t.hostname),
  index("idx_domain_webhook_source").on(t.webhookSourceId),
]);
