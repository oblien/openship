/**
 * Aggregate counters for the admin overview sidebar.
 *
 * One SQL round-trip returns every number the Overview's right sidebar
 * wants to show: domain/mailbox/alias totals + storage usage. Counts are
 * authoritative live values from the source tables, NOT the
 * `vmail.domain.mailboxes` counter (which iRedAdmin keeps in sync but can
 * drift if something outside openship writes the tables).
 *
 * Storage comes from `vmail.used_quota` - Dovecot updates this on every
 * LOGOUT, so the value is "what each mailbox occupies as of the last
 * client session." Good enough for a dashboard; not a real-time number.
 */

import { queryOne } from "@repo/platform/engine/modules/mail/admin/psql-runner";

export interface MailServerStats {
  domains: { total: number; active: number };
  mailboxes: { total: number; active: number };
  aliases: { total: number };
  /** Aggregated bytes from vmail.used_quota. Null if the table is empty. */
  storageBytes: number;
  /** Aggregated message count from vmail.used_quota. */
  messages: number;
}

interface StatsRow {
  domainsTotal: number;
  domainsActive: number;
  mailboxesTotal: number;
  mailboxesActive: number;
  aliasesTotal: number;
  storageBytes: string;
  messages: string;
}

export async function getMailServerStats(
  serverId: string,
): Promise<MailServerStats> {
  // bigint columns come back as strings from psql's JSON output (Postgres
  // serialises them as numeric strings to avoid the int53 trap). We coerce
  // to number at the edge - none of these will realistically exceed 2^53.
  const row = await queryOne<StatsRow>(
    serverId,
    `SELECT
       (SELECT COUNT(*)::int FROM domain) AS "domainsTotal",
       (SELECT COUNT(*)::int FROM domain WHERE active = 1) AS "domainsActive",
       (SELECT COUNT(*)::int FROM mailbox) AS "mailboxesTotal",
       (SELECT COUNT(*)::int FROM mailbox WHERE active = 1) AS "mailboxesActive",
       (SELECT COUNT(*)::int FROM forwardings WHERE is_alias = 1 AND active = 1) AS "aliasesTotal",
       (SELECT COALESCE(SUM(bytes), 0)::text FROM used_quota) AS "storageBytes",
       (SELECT COALESCE(SUM(messages), 0)::text FROM used_quota) AS "messages"`,
  );

  if (!row) {
    return {
      domains: { total: 0, active: 0 },
      mailboxes: { total: 0, active: 0 },
      aliases: { total: 0 },
      storageBytes: 0,
      messages: 0,
    };
  }

  return {
    domains: { total: row.domainsTotal, active: row.domainsActive },
    mailboxes: { total: row.mailboxesTotal, active: row.mailboxesActive },
    aliases: { total: row.aliasesTotal },
    storageBytes: Number(row.storageBytes ?? 0),
    messages: Number(row.messages ?? 0),
  };
}
