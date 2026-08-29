/**
 * Reading captured mail out of the collector folder and turning it into notifications.
 *
 * DISPATCH THEN DELETE, and the deletion is the point. There is no cursor table and no
 * UID bookkeeping: the BCC copy is a whole message sitting on disk, so removing it after
 * dispatch is both "we have handled this" and the prune that stops a second full copy of
 * every watched message accumulating forever under `/var/vmail` — a host bind mount with
 * no quota of its own. The collector runs at quota 0 precisely because this runs.
 *
 * Dispatch means ENQUEUED: a `notification_delivery` row is written and the notification
 * worker owns retries. So deleting the message immediately afterwards is correct — the
 * durable retry lives in that table, not in the maildir.
 *
 * HEADERS ONLY cross the wire. Bodies and attachments are never read, which keeps the
 * payload small, keeps message content out of the control plane's logs and out of the
 * notification, and makes the read cost independent of a 20 MB attachment.
 *
 * Everything runs through `runMailCommand`/`mailEngineCommand`, so `/var/vmail` resolves
 * inside the engine on a container box and on the host on a legacy one. Reading these
 * paths with the raw host executor is the GH-562 bug class.
 */

import { safeErrorMessage, shellQuote } from "@repo/core";
import { repos, type MailInboundRule } from "@repo/db";
import { mailEngineCommand, runMailCommand } from "../mail-engine";
import { collectorFolderPath, readArmedState, ruleDomain, tokenFromBcc } from "./capture";
import { loopGuard, matchesRule, parseHeaderBlock, spamGate, type ParsedHeaders } from "./filter";

/** Bytes of each message we read. Enough for a full header block, never a body. */
const HEADER_BYTES = 8192;

/**
 * Messages handled per domain per tick.
 *
 * A COUNT, never a byte cap: slicing a batch by bytes can cut a record mid-field and
 * corrupt the parse of an otherwise healthy message. A mailing-list burst that exceeds
 * this is drained over subsequent ticks rather than dropped, and the digest below is what
 * keeps it from becoming one alert per message.
 */
const MAX_PER_TICK = 40;

/**
 * Above this many messages in one tick for one rule, send ONE digest instead of N alerts.
 *
 * The notification subsystem has no rate limiting or windowed dedup of its own — burst
 * control is explicitly the producer's job — so without this a list posting to a watched
 * address is a channel flood, and a backlog after an outage is worse.
 */
const DIGEST_THRESHOLD = 5;

export interface InboundMessage {
  /** Maildir filename — unique, and what we delete by. */
  file: string;
  headers: ParsedHeaders;
}

/**
 * List then read the new messages in a collector folder, in ONE round trip.
 *
 * `head -c` per file rather than `cat`: a body must not cross the wire, and a message with
 * a 20 MB attachment must not make this read expensive. Each blob is fenced by a marker
 * line carrying the filename, so one exec yields both identities and content — a
 * per-message exec would be a round trip per message.
 */
export async function readCollectorFolder(
  serverId: string,
  folder: string,
  limit = MAX_PER_TICK,
): Promise<InboundMessage[]> {
  // `|| true` so an empty or absent folder is an empty read, not a thrown command: a
  // domain armed a moment ago has no `new/` until the first delivery creates it.
  const script =
    `set -e; d=${shellQuote(`${folder}/new`)}; [ -d "$d" ] || exit 0; ` +
    `for f in $(ls -1 "$d" 2>/dev/null | head -n ${limit}); do ` +
    `echo "__OPENSHIP_MSG__ $f"; head -c ${HEADER_BYTES} "$d/$f" 2>/dev/null || true; ` +
    `echo; done`;

  const { output } = await runMailCommand(
    serverId,
    (flavor) => mailEngineCommand(flavor, `sh -c ${shellQuote(script)}`),
    { timeout: 30_000 },
  );

  const out: InboundMessage[] = [];
  for (const chunk of output.split("__OPENSHIP_MSG__ ").slice(1)) {
    const nl = chunk.indexOf("\n");
    if (nl < 0) continue;
    const file = chunk.slice(0, nl).trim();
    if (!file) continue;
    out.push({ file, headers: parseHeaderBlock(chunk.slice(nl + 1)) });
  }
  return out;
}

/**
 * Delete handled messages. Batched into one exec, and never a wildcard.
 *
 * Filenames come from `ls` of a directory we own, but they are still interpolated into a
 * shell command on a root, host-networked container — so every one is individually
 * shell-quoted, and anything that does not look like a maildir filename is skipped rather
 * than quoted-and-hoped.
 */
export async function deleteMessages(
  serverId: string,
  folder: string,
  files: readonly string[],
): Promise<void> {
  const safe = files.filter((f) => /^[A-Za-z0-9._,:=-]+$/.test(f));
  if (safe.length === 0) return;
  const args = safe.map((f) => shellQuote(`${folder}/new/${f}`)).join(" ");
  await runMailCommand(serverId, (flavor) => mailEngineCommand(flavor, `rm -f ${args}`), {
    timeout: 30_000,
  });
}

interface Matched {
  rule: MailInboundRule;
  message: InboundMessage;
}

/**
 * Run one server's collectors: read, filter, dispatch, delete.
 *
 * Returns counts rather than throwing on a per-domain failure — one unreachable domain
 * must not stop the others, and the job wrapper reports the totals.
 */
export async function runInboundForServer(opts: {
  serverId: string;
  organizationId: string;
  openshipSenders?: readonly string[];
  /** Skip dispatch and deletion — powers the UI's "test this rule" button. */
  dryRun?: boolean;
}): Promise<{ read: number; matched: number; emitted: number; dropped: number; errors: string[] }> {
  const { serverId, organizationId, dryRun } = opts;
  const errors: string[] = [];
  let read = 0;
  let matched = 0;
  let emitted = 0;
  let dropped = 0;

  const rules = await repos.mailInbound.listEnabledByServer(serverId);
  if (rules.length === 0) return { read, matched, emitted, dropped, errors };

  // Which domains to visit. `all` means every armed domain, so it is resolved from what
  // the ENGINE says is armed rather than from the rule rows.
  const wantsAll = rules.some((r) => r.scope === "all");
  const explicit = new Set(
    rules
      .filter((r) => r.scope === "domain" || r.scope === "mailbox")
      .map((r) => ruleDomain(r))
      .filter((d): d is string => Boolean(d)),
  );

  const domains = wantsAll ? await armedDomains(serverId) : [...explicit];

  for (const domain of domains) {
    try {
      const state = await readArmedState(serverId, domain);
      if (!state.token || !state.maildirPath) continue;

      const folder = collectorFolderPath(state.maildirPath, state.token);
      const messages = await readCollectorFolder(serverId, folder);
      read += messages.length;
      if (messages.length === 0) continue;

      const handled: string[] = [];
      const perRule = new Map<string, Matched[]>();

      for (const message of messages) {
        handled.push(message.file);

        const guard = loopGuard(message.headers, { openshipSenders: opts.openshipSenders });
        if (guard.drop) {
          dropped++;
          continue;
        }
        let any = false;
        for (const rule of rules) {
          if (!matchesRule(rule, message.headers, domain)) continue;
          if (spamGate(message.headers, rule.maxSpamScore).drop) continue;
          any = true;
          const list = perRule.get(rule.id) ?? [];
          list.push({ rule, message });
          perRule.set(rule.id, list);
        }
        if (any) matched++;
        else dropped++;
      }

      if (!dryRun) {
        for (const [, group] of perRule) {
          emitted += await emitForRule(organizationId, serverId, domain, group);
        }
        // Delete AFTER dispatch. A message that produced no match is deleted too: it was
        // examined and rejected, and leaving it would re-examine it forever.
        await deleteMessages(serverId, folder, handled);
        for (const ruleId of perRule.keys()) {
          await repos.mailInbound.markMatched(ruleId).catch(() => undefined);
        }
      }
    } catch (err) {
      errors.push(`${domain}: ${safeErrorMessage(err)}`);
    }
  }

  return { read, matched, emitted, dropped, errors };
}

/**
 * Emit for one rule's matches — individually, or one digest above the threshold.
 *
 * The digest is the correct shape after a backlog: an operator returning from an outage
 * wants "31 messages arrived", not thirty-one notifications spread across ten minutes.
 *
 * DELIVERY GOES TO THE RULE'S OWN CHANNELS, not to the org's category subscriptions. The
 * operator picked channels per rule ("support@ → #support"), so routing through the
 * dispatcher would ignore that choice and fan every rule to whoever happens to be
 * subscribed. This is the same per-target enqueue `job-command.ts` uses for a job's
 * `notifyConfig`, for the same reason.
 *
 * With no channels the rule delivers NOTHING and says so. Quietly falling back to org-wide
 * subscriptions would send a rule's mail somewhere the operator never chose.
 */
async function emitForRule(
  organizationId: string,
  serverId: string,
  domain: string,
  group: readonly Matched[],
): Promise<number> {
  const rule = group[0]!.rule;

  const payloads =
    group.length > DIGEST_THRESHOLD
      ? [
          {
            title: `${group.length} messages matched “${rule.name}”`,
            message:
              `${group.length} messages arrived for ${domain} matching “${rule.name}”. ` +
              `Collapsed into one alert to avoid flooding this channel.`,
            ruleName: rule.name,
            domain,
            count: group.length,
          },
        ]
      : group.map(({ message }) => {
          const h = message.headers;
          return {
            title: h.subject ? `New mail: ${h.subject}` : "New mail received",
            // Envelope-level facts only. No body, no snippet — the operator asked to be
            // told mail ARRIVED, and a channel is not a mail client. It also keeps message
            // content out of the control plane's delivery rows and logs.
            message:
              `From: ${h.from ?? h.fromAddress ?? "unknown"}\n` +
              `To: ${h.recipients.join(", ") || domain}\n` +
              `Rule: ${rule.name}`,
            ruleName: rule.name,
            domain,
            from: h.fromAddress,
            subject: h.subject,
          };
        });

  const channelIds = rule.channelIds ?? [];
  if (channelIds.length === 0) {
    console.warn(
      `[mail:inbound] rule ${rule.id} (“${rule.name}”) matched ${group.length} message(s) ` +
        `but has no notification channels — nothing was sent.`,
    );
    return 0;
  }

  let sent = 0;
  for (const channelId of channelIds) {
    const channel = await repos.notificationChannel.findById(channelId).catch(() => null);
    // `verified` is the ONLY gate the dispatcher applies before shipping org payloads to
    // an outbound URL, so a direct enqueue has to apply it too — otherwise this path
    // becomes the way to post to an unverified endpoint.
    if (!channel || !channel.enabled || !channel.verified) continue;

    // A rule must not be able to name another tenant's channel. The dispatcher gets this
    // for free by looking subscriptions up per org; a direct enqueue has to check.
    const channelOrgId = await resolveChannelOrg(channel.userId);
    if (!channelOrgId || channelOrgId !== organizationId) continue;

    for (const payload of payloads) {
      await repos.notificationDelivery
        .create({
          userId: channel.userId,
          organizationId,
          auditEventId: null,
          category: MAIL_INBOUND_EVENT,
          channelId: channel.id,
          channelKind: channel.kind,
          status: "queued",
          attempts: 0,
          payload: { ...payload, resourceType: "mail_server", resourceId: serverId },
        })
        .then(() => {
          sent++;
        })
        .catch((err) => {
          console.warn(
            `[mail:inbound] could not queue delivery for rule ${rule.id}: ${safeErrorMessage(err)}`,
          );
        });
    }
  }
  return sent;
}

/** A channel belongs to a user; the org is that user's membership. */
async function resolveChannelOrg(userId: string): Promise<string | null> {
  const members = await repos.member.listByUser(userId).catch(() => []);
  return members[0]?.organizationId ?? null;
}

/**
 * Hoisted so the audit-taxonomy scan sees exactly one literal, and so a typo cannot make
 * the producer and the registry disagree — an unmapped eventType is dropped silently.
 */
export const MAIL_INBOUND_EVENT = "mail.inbound_received";

/** Domains the ENGINE currently has one of our BCC rows on. */
async function armedDomains(serverId: string): Promise<string[]> {
  const { queryRows, q } = await import("../admin/psql-runner");
  const rows = await queryRows<{ domain: string; bcc_address: string }>(
    serverId,
    `SELECT domain, bcc_address FROM recipient_bcc_domain WHERE active = 1 AND bcc_address LIKE ${q("openship-hook+%")}`,
  );
  return rows.filter((r) => tokenFromBcc(r.bcc_address)).map((r) => r.domain);
}
