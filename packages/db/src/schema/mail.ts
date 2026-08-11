import { pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { servers } from "./servers";

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

  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});
