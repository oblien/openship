import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  real,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { servers } from "./servers";
import { project } from "./project";
import { organization } from "./organization";

/**
 * Mail-server install record.
 *
 * A row here is openship's fast answer to "is this server a mail server?".
 * The state file on the host (/root/.openship-mail-state.json) remains the
 * source of truth for STEP-level progress; this table just lets the
 * dashboard skip an SSH round-trip on every /emails page load.
 *
 * Lifecycle:
 *   - INSERTED when an operator starts the install wizard (so /emails can
 *     pre-select that server even while the install is in progress).
 *   - `installed_at` is stamped when the wizard completes successfully.
 *   - DELETED when an operator runs the uninstall / reset action.
 *
 * `server_id` is the FK and the PK - one mail install per server.
 * ON DELETE CASCADE: dropping the server row removes the mail record too.
 */
export const mailServers = pgTable("mail_servers", {
  serverId: text("server_id")
    .primaryKey()
    .references(() => servers.id, { onDelete: "cascade" }),

  /**
   * The primary mail domain the user gave during install (e.g. "oblien.com").
   * The mail server listens on `mail.<domain>`; postmaster mailbox is
   * `postmaster@<domain>`.
   */
  domain: text("domain").notNull(),

  /** Stamped when the install wizard hits the "completed" terminal state. */
  installedAt: timestamp("installed_at"),

  /**
   * The step the setup wizard is paused at, mirrored from the on-host state
   * file's `resumeStep` whenever the install halts (a failed step, or a
   * DNS/PTR hold). NULL once the wizard completes or before it ever halts.
   *
   * Lets the /emails server list show WHERE an incomplete install stopped
   * ("Stopped · step 6: Retrieve DKIM Keys") without the per-server SSH probe
   * this table exists to avoid — the human label is derived from the step id
   * against MAIL_SETUP_STEPS, so only the id is stored here.
   */
  resumeStep: integer("resume_step"),

  /**
   * The webmail project serving this mail server, when one was installed from
   * the app catalog (`catalog/webmail.json`). Null = no webmail, or one an
   * operator runs outside openship.
   *
   * A stored FK, not a naming convention: webmail installs through the SAME
   * generic catalog installer as every other app, so its slug comes from the
   * project NAME the operator typed. The old `webmail-<serverId>` slug regex
   * therefore can't be produced any more — and while it existed it mislinked
   * any project a user happened to name "Webmail Prod" (slug `webmail-prod`,
   * read back as mail server "prod").
   *
   * ON DELETE SET NULL: deleting the webmail project clears the link, so
   * /emails falls back to offering the install CTA instead of pointing at a row
   * that no longer exists.
   */
  webmailProjectId: text("webmail_project_id").references(() => project.id, {
    onDelete: "set null",
  }),

  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

/**
 * An operator rule: "mail matching this, tell me in these channels."
 *
 * The ONLY table this feature adds. Capture state deliberately is not mirrored here: the
 * token lives inside `vmail.recipient_bcc_domain.bcc_address`, the collector's maildir in
 * `vmail.mailbox`, and "a foreign BCC took the slot" is derivable from that address — so
 * the engine stays the single source of truth for what is armed, and there is no cache to
 * go stale. What has to persist is this: rules reference `notification_channel` ids that
 * exist only in this database, and they are edited from a dashboard tab.
 *
 * Scope and filters are evaluated in the control plane against the captured headers, which
 * is what lets a rule be edited with no mail-box change at all. Only a rule's DOMAIN
 * decides whether a BCC row has to exist on the engine.
 */
export const mailInboundRule = pgTable(
  "mail_inbound_rule",
  {
    id: text("id").primaryKey(),

    serverId: text("server_id")
      .notNull()
      .references(() => mailServers.serverId, { onDelete: "cascade" }),

    /**
     * Carried so dispatch can fan out to the right org's channels without joining back
     * through `servers`. Note this does NOT make the table org-scope for dump purposes:
     * its FKs point at instance-scope rows (see dump.ts).
     */
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),

    /** Operator-facing label, e.g. "Support inbox → #support". */
    name: text("name").notNull(),

    /** mailbox | domain | all. Text so a new scope is a registry entry, not a migration. */
    scope: text("scope").notNull(),

    /**
     * Full address for `mailbox`, the domain for `domain`, NULL for `all`.
     *
     * `all` is a genuine fan-out: there is no global `always_bcc` anywhere in the
     * shipped Postfix config, and the domain lookup keys on exact equality with no
     * wildcard convention — so it arms one BCC row per domain and needs a reconcile
     * when a domain is added.
     *
     * No CHECK ties this to `scope` (this schema has none anywhere, and the SQL and
     * drizzle definitions are hand-maintained in parallel). The invariant is enforced
     * fail-closed instead: a `mailbox` rule with no target matches NOTHING.
     */
    target: text("target"),

    /** Optional extra matching, applied at filter time. NULL = match everything. */
    fromPattern: text("from_pattern"),
    subjectPattern: text("subject_pattern"),

    /**
     * Spam gate, and it is NOT optional in practice. The shipped amavis policy sets
     * `spam_lover='Y'` and `bad_header_lover='Y'` on the catch-all `@.` policy with
     * empty quarantine targets, so the global `$final_spam_destiny = D_DISCARD` is dead
     * for every recipient: spam and bad-header mail are delivered, and therefore
     * captured. Nothing upstream filters on our behalf.
     */
    maxSpamScore: real("max_spam_score"),

    /**
     * Target channels as a jsonb array of ids — deliberately not a join table with an FK
     * to `notification_channel`. The dump's FK_PARENT maps a bare `channelId` column to
     * that table unconditionally for ANY table, so a real join row would make
     * `assertDumpSelfContained` reject any dump carrying it on a remap path.
     */
    channelIds: jsonb("channel_ids").$type<string[]>().notNull().default([]),

    enabled: boolean("enabled").notNull().default(true),

    /**
     * Burst control state. The notification subsystem has no rate limiting or windowed
     * dedup of its own — that is explicitly the producer's job — so a mailing list
     * hitting a watched address must not become one alert per message.
     */
    pausedReason: text("paused_reason"),
    lastMatchedAt: timestamp("last_matched_at"),

    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    index("idx_mail_inbound_rule_server_enabled").on(t.serverId, t.enabled),
    index("idx_mail_inbound_rule_org").on(t.organizationId),
  ],
);
