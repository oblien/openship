import { integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { servers } from "./servers";
import { project } from "./project";

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
