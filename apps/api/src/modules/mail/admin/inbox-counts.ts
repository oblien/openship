import { createHash } from "node:crypto";
import { shellQuote } from "@repo/core";
import { diagnostics } from "@repo/core/diagnostics";
import type { MailInboxCountsSchema } from "@repo/contracts";
import type { Static } from "@sinclair/typebox";
import { mailEngineCommand, mailPsqlCommand, runMailCommand } from "@repo/platform/engine/modules/mail/mail-engine";

export interface InboxDomain {
  domain: string;
  mailboxes: Array<{ username: string; created: string }>;
}
type Counts = Static<typeof MailInboxCountsSchema>;
const snapshots = new Map<string, { expires: number; value: Promise<Counts> }>();
// Dovecot 2.3 seeks in the -F file, so a pipe or /dev/stdin cannot serve as
// the roster. Keep the file inside the engine and remove it when the read ends.
const statusScript = `set -eu
umask 077
users=$(mktemp)
trap 'rm -f "$users"' EXIT
trap 'exit 1' HUP INT TERM
cat > "$users"
doveadm -f tab mailbox status -F "$users" messages INBOX || [ "$?" -eq 67 ]`;

function sum(values: Array<number | null>): number | null {
  return values.reduce<number | null>((total, n) => total === null || n === null ? null : total + n, 0);
}

async function readCounts(serverId: string, visible: string, inventory: InboxDomain[]): Promise<Counts> {
  const counts = new Map<string, number>();
  if (inventory.some(d => d.mailboxes.length)) {
    try {
      // Pipe the worker's scoped SQL roster directly into Dovecot. The command
      // size is independent of the number of accounts. Never enumerate all
      // Dovecot users or list message files to count another tenant's inbox.
      const users = `SELECT username FROM mailbox WHERE ${visible}
        AND username !~ '[[:cntrl:]*?]' AND split_part(username, '@', 2) = domain ORDER BY username`;
      const { output } = await runMailCommand(serverId, flavor =>
        mailPsqlCommand(flavor, users) + " | " +
        mailEngineCommand(flavor, "sh -c " + shellQuote(statusScript), { stdin: true }),
        { timeout: 25_000 },
      );
      for (const line of output.split(/\r?\n/)) {
        const [username, folder, raw] = line.split("\t");
        if (!username || folder !== "INBOX" || !raw || !/^\d+$/.test(raw)) continue;
        const n = Number(raw);
        if (Number.isSafeInteger(n)) counts.set(username, n);
      }
    } catch {
      diagnostics.warn("mail", "Could not read Dovecot INBOX counters.", { serverId });
    }
  }
  const domains = inventory.map(({ domain, mailboxes: roster }) => {
    const mailboxes = roster.map(({ username }) => ({ username, messages: counts.get(username) ?? null }));
    return { domain, mailboxes, messages: sum(mailboxes.map(m => m.messages)) };
  });
  return { total: sum(domains.map(d => d.messages)), domains };
}

/** Share a worker read across concurrent overview requests. Changing domain
 * ownership, membership or mailbox creation time invalidates the snapshot. */
export function inboxCounts(serverId: string, visible: string, inventory: InboxDomain[]) {
  const key = createHash("sha256").update(JSON.stringify([serverId, visible, inventory])).digest("hex");
  const now = Date.now();
  const cached = snapshots.get(key);
  if (cached && now < cached.expires) return cached.value;
  for (const [id, entry] of snapshots) if (entry.expires <= now) snapshots.delete(id);
  if (snapshots.size >= 128) snapshots.delete(snapshots.keys().next().value!);
  const value = readCounts(serverId, visible, inventory);
  snapshots.set(key, { expires: now + 30_000, value });
  return value;
}
