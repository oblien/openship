/**
 * The overview reads inventory and quota usage in one SQL snapshot.
 * Dovecot's used_quota covers every folder. The optional Inbox breakdown
 * reads folder counters for the mailboxes in that snapshot.
 */

import { queryOne, q } from "@repo/platform/engine/modules/mail/admin/psql-runner";

import { tenantDomainsSql } from "@repo/platform/engine/modules/mail/admin/tenant-domains";

import type { Static } from "@sinclair/typebox";
import type { MailStatsSchema } from "@repo/contracts";
import { inboxCounts, type InboxDomain } from "./inbox-counts";

type MailServerStats = Static<typeof MailStatsSchema>;

interface StatsRow {
  inventory?: InboxDomain[];
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
  excludeDomain?: string,
  namespace?: string,
  includeInbox = false,
): Promise<MailServerStats> {
  // bigint columns come back as strings from psql's JSON output (Postgres
  // serialises them as numeric strings to avoid the int53 trap). We coerce
  // to number at the edge - none of these will realistically exceed 2^53.
  // Hosted accounts exclude the engine's bootstrap domain from every counter.
  const visible = [
    namespace !== undefined && `domain IN (${tenantDomainsSql(namespace)})`,
    excludeDomain && `domain <> ${q(excludeDomain)}`,
  ].filter(Boolean).join(" AND ") || "TRUE";
  const scopedStorage = namespace !== undefined || excludeDomain
    ? "WHERE username IN (SELECT username FROM visible_mailboxes)"
    : "";
  // The optional roster includes empty domains and uses the same rows as the
  // counters. Each source aggregate is computed in the same SQL snapshot.
  const inventory = includeInbox ? `, (
    SELECT COALESCE(json_agg(d ORDER BY domain), '[]') FROM (
      SELECT v.domain, COALESCE(array_agg(m.username ORDER BY m.username)
        FILTER (WHERE m.username IS NOT NULL), '{}') AS usernames
      FROM visible_domains v LEFT JOIN visible_mailboxes m ON m.domain = v.domain
      GROUP BY v.domain
    ) d) AS inventory` : "";
  const row = await queryOne<StatsRow>(serverId, `
    WITH visible_domains AS (SELECT domain, active FROM domain WHERE ${visible}),
         visible_mailboxes AS (SELECT domain, username, active FROM mailbox WHERE ${visible})
    SELECT ds.*, ms.*, usage.*,
      (SELECT COUNT(*)::int FROM forwardings WHERE ${visible} AND is_alias = 1 AND active = 1) AS "aliasesTotal"
      ${inventory}
    FROM (SELECT COUNT(*)::int AS "domainsTotal", COUNT(*) FILTER (WHERE active = 1)::int AS "domainsActive" FROM visible_domains) ds
    CROSS JOIN (SELECT COUNT(*)::int AS "mailboxesTotal", COUNT(*) FILTER (WHERE active = 1)::int AS "mailboxesActive" FROM visible_mailboxes) ms
    CROSS JOIN (SELECT COALESCE(SUM(bytes), 0)::text AS "storageBytes", COALESCE(SUM(messages), 0)::text AS messages
                FROM used_quota ${scopedStorage}) usage
  `);

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
    ...(row.inventory && { inbox: await inboxCounts(serverId, visible, row.inventory) }),
  };
}
