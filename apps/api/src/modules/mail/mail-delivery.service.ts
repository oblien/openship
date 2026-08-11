/**
 * Outbound delivery health — "is mail actually LEAVING this box?"
 *
 * The daemon sweep (`./mail-health.service`) answers a different question than it
 * looks like it does. Nine green rows mean nine processes are running; they say
 * nothing about whether Postfix can hand a message to the next hop. The gap is
 * silent by construction, and split delivery widened it: point the send hop at a
 * provider with one wrong character in the SASL password and you get nine green
 * daemons, green DNS, a Test-tab email that reports success (our Postfix accepts
 * and queues it — the relay hop happens after the `250 OK`), and mail that quietly
 * defers forever.
 *
 * The queue is where that becomes visible, and Postfix already writes the
 * diagnosis into it: every deferred message carries the remote's own refusal
 * ("said: 535 Authentication Credentials Invalid"). So this reads the queue rather
 * than re-probing the relay by hand, which means ONE probe covers every way a send
 * hop fails — bad credentials, TLS mismatch, blocked egress, rate limiting,
 * greylisting — instead of only the ones we thought to test for.
 *
 * Relay-aware because the same refusal means different things: an auth failure can
 * only come from the host we authenticate to, so on a relayed box it IS our
 * credentials and it's fatal; on a direct box a rejection is one destination's
 * opinion and the rest of the queue is fine.
 */

import type { CommandExecutor } from "@repo/adapters";
import { relayedDomainsFor, safeErrorMessage } from "@repo/core";

import { mailQueueProbeCommand, resolveMailEngine } from "./mail-engine";
import { readState } from "./mail-state";
import type { OutboundRelay } from "./mail-state";

/** How outbound mail leaves the box. */
export type MailOutboundMode = "direct" | "relay";

export type MailDeliveryStatus = "ok" | "warn" | "fail" | "unknown";

/** What a deferral reason is diagnostic OF — decides the remedy we can name. */
export type MailDeferralKind = "auth" | "tls" | "network" | "rejected" | "other";

export interface MailDeferral {
  kind: MailDeferralKind;
  /** How many queued messages carry this reason, within the sampled window. */
  count: number;
  /** The remote's own words, trimmed of Postfix's parentheses and capped. */
  reason: string;
}

export interface MailDeliveryHealth {
  status: MailDeliveryStatus;
  mode: MailOutboundMode;
  /** The smarthost, when relaying — `host:port`. Absent when sending direct. */
  relayHost?: string;
  /** `all` = every sender relays; `selected` = only the listed senders/domains. */
  relayScope?: "all" | "selected";
  /** Domains whose senders relay under `selected` scope, for the operator's eyes. */
  relayDomains?: string[];
  /** Messages in the queue, from postqueue's own total (never a sampled count). */
  queued: number;
  /** Whether that total came from a queue larger than the window we sampled. */
  sampled: boolean;
  /** Distinct deferral reasons, most frequent first. Capped. */
  deferrals: MailDeferral[];
  /**
   * Why the status is `unknown` — the probe's own words. Absent for every state we
   * actually determined, so "we didn't look" can't render as "delivery is broken".
   */
  detail?: string;
}

/** How many distinct deferral reasons we report. Beyond this it's the same story. */
const MAX_DEFERRALS = 3;
const MAX_REASON_LEN = 240;

/**
 * Reason → what kind of failure it is, most specific first.
 *
 * Matched against the remote's refusal text, so these are SMTP facts, not our
 * wording: `535`/`530` and "authentication failed" are what a provider says to a
 * bad SASL credential, and Postfix's own TLS and connection errors are fixed
 * strings. Ordered because a TLS failure during AUTH would match both.
 */
const DEFERRAL_PATTERNS: readonly { kind: MailDeferralKind; test: RegExp }[] = [
  {
    kind: "auth",
    test: /\b(?:535|530)\b|authentication (?:failed|credentials|required)|sasl|auth.*(?:invalid|denied)/i,
  },
  {
    kind: "tls",
    // `certificate` unqualified: Postfix phrases the same fault three ways
    // ("certificate verification failed", "Server certificate not verified",
    // "certificate has expired"), and any mention of one in a deferral is a TLS
    // matter — matching the phrasings we thought of missed the commonest one.
    test: /\btls\b|\bssl\b|\bcertificate\b|handshake/i,
  },
  {
    kind: "network",
    test: /connection (?:timed out|refused|reset)|no route to host|network is unreachable|name or service not known|lost connection/i,
  },
  {
    kind: "rejected",
    test: /\b(?:4\d\d|5\d\d)\b|refused to talk to me|blocked|spam|greylist|rate limit|too many/i,
  },
];

function classifyReason(reason: string): MailDeferralKind {
  return DEFERRAL_PATTERNS.find((p) => p.test.test(reason))?.kind ?? "other";
}

/** "We didn't get a reading" — zeroed, never graded, always paired with a `detail`. */
const unread = { status: "unknown" as const, queued: 0, sampled: false, deferrals: [] };

/**
 * The outbound path, and whether anything is stuck on it.
 *
 * Reads the state file for the send hop and the queue for the evidence. Never
 * throws: a box we can't probe reports `unknown` with the probe's own words, which
 * the panel renders as "we couldn't check" rather than as a fault.
 */
export async function checkMailDelivery(exec: CommandExecutor): Promise<MailDeliveryHealth> {
  const relay = await readState(exec)
    .then((state) => (state?.outboundRelay?.enabled ? state.outboundRelay : undefined))
    .catch(() => undefined);
  const base = describePath(relay);

  const probe = await resolveMailEngine(exec).catch(() => null);
  if (probe?.flavor === "none") {
    return { ...base, ...unread, detail: "No mail engine on this server." };
  }
  // A stopped CONTAINER can't be exec'd into at all, so say that rather than
  // surfacing docker's "is not running" as if the queue itself were unreadable.
  // Not applied to the legacy host flavor: `postqueue` reads the spool directly
  // there, so a stopped Postfix still gives a truthful — and more useful — answer.
  if (probe?.flavor === "container" && !probe.running) {
    return { ...base, ...unread, detail: "The mail engine isn't running." };
  }
  const flavor = probe?.flavor ?? "container";

  let raw: string;
  try {
    raw = await exec.exec(mailQueueProbeCommand(flavor));
  } catch (err) {
    return { ...base, ...unread, detail: firstLine(safeErrorMessage(err)) };
  }

  const queue = parseMailQueue(raw);
  if (queue === null) {
    return { ...base, ...unread, detail: firstLine(raw) };
  }
  return { ...base, ...queue, status: gradeDelivery(queue, relay) };
}

/** Which send hop the state file describes — pure, so the UI shape is testable. */
export function describePath(relay: OutboundRelay | undefined): {
  mode: MailOutboundMode;
  relayHost?: string;
  relayScope?: "all" | "selected";
  relayDomains?: string[];
} {
  if (!relay?.enabled) return { mode: "direct" };
  const scope = relay.scope === "selected" ? "selected" : "all";
  return {
    mode: "relay",
    relayHost: relay.port ? `${relay.host}:${relay.port}` : relay.host,
    relayScope: scope,
    // Only meaningful for `selected` — under `all` the answer is "every domain",
    // and listing them would read as a limit that isn't there.
    relayDomains:
      scope === "selected"
        ? relayedDomainsFor({ domains: relay.domains, addresses: relay.addresses })
        : undefined,
  };
}

/** Queue facts, without the verdict. `null` = this isn't postqueue output. */
export type MailQueueReading = Pick<MailDeliveryHealth, "queued" | "sampled" | "deferrals">;

/**
 * Parse `postqueue -p`.
 *
 * Its format is stable and line-oriented:
 *
 *   -Queue ID-  --Size-- ----Arrival Time---- -Sender/Recipient-------
 *   A1B2C3D4E5*    1234 Fri Aug  8 02:00:00  sender@example.com
 *   (host smtp.example.net[203.0.113.9] said: 535 Bad credentials …)
 *                                            rcpt@example.org
 *   -- 12 Kbytes in 3 Requests.
 *
 * `queued` comes from the trailer, which counts the WHOLE queue even when we only
 * read the tail — so the number an operator acts on is never a sample. The reasons
 * are the parenthesised lines, which is where Postfix records the remote's verbatim
 * refusal; identical reasons collapse with a count, because "three messages, one
 * cause" is the shape of every real relay outage.
 *
 * Returns `null` for output that is neither a queue listing nor "empty" — a
 * docker error, a `postqueue: not found`, a permission denial. That has to stay
 * distinguishable from an empty queue, or a broken probe reads as healthy.
 */
export function parseMailQueue(raw: string): MailQueueReading | null {
  const lines = raw.split("\n").map((l) => l.trimEnd());
  const trailer = lines.find((l) => /^--\s*\d+\s+\S*bytes\s+in\s+\d+\s+Request/i.test(l.trim()));
  const empty = lines.some((l) => /^mail queue is empty$/i.test(l.trim()));
  if (!trailer && !empty) return null;

  const queued = trailer ? Number(/in\s+(\d+)\s+Request/i.exec(trailer)?.[1] ?? 0) : 0;
  // postqueue prints its column header FIRST and its total LAST, and we read the
  // tail — so a total with no header above it is proof the window truncated, which
  // is exactly when the reasons below are a sample of the queue rather than all of
  // it. Not `queued > reasons.length`: a message that hasn't been tried yet has no
  // reason line at all, so that comparison calls every healthy active queue a
  // sample.
  const sampled = trailer !== undefined && !lines.some((l) => /^-+\s*Queue ID/i.test(l.trim()));

  // One entry can wrap its reason across lines; Postfix indents the continuation,
  // and the closing paren is the terminator. Join before classifying, or a long
  // refusal is truncated exactly where the status code isn't.
  const reasons: string[] = [];
  let open: string | null = null;
  for (const line of lines) {
    const text = line.trim();
    if (open !== null) {
      open += ` ${text.replace(/\)$/, "")}`;
      if (text.endsWith(")")) {
        reasons.push(open);
        open = null;
      }
      continue;
    }
    if (!text.startsWith("(")) continue;
    const body = text.slice(1);
    if (text.endsWith(")")) reasons.push(body.slice(0, -1));
    else open = body;
  }
  if (open !== null) reasons.push(open);

  const tally = new Map<string, number>();
  for (const reason of reasons) {
    const key = clamp(reason.replace(/\s+/g, " ").trim());
    if (!key) continue;
    tally.set(key, (tally.get(key) ?? 0) + 1);
  }
  const deferrals: MailDeferral[] = [...tally.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_DEFERRALS)
    .map(([reason, count]) => ({ kind: classifyReason(reason), count, reason }));

  return { queued, sampled, deferrals };
}

/**
 * The verdict.
 *
 * `fail` is reserved for "this box is misconfigured and every relayed message is
 * dying of it" — an auth failure with a relay on can only be OUR credentials,
 * because the relay is the only host we authenticate to. TLS and network failures
 * are fatal in the same way only when they name the smarthost: a direct box gets
 * both from individual destinations all day, and a queue with a few of those in it
 * is a normal queue, not an outage.
 *
 * Everything else that is stuck is `warn`. Mail sitting in the queue always
 * deserves the operator's eyes, but "deferred" is also how a healthy MTA handles a
 * receiver's greylist for four minutes, and red-flagging that trains people to
 * ignore the banner.
 */
export function gradeDelivery(
  queue: MailQueueReading,
  relay: OutboundRelay | undefined,
): MailDeliveryStatus {
  if (queue.deferrals.length === 0) return queue.queued > 0 ? "warn" : "ok";
  if (relay?.enabled) {
    const host = relay.host?.toLowerCase();
    const fatal = queue.deferrals.some(
      (d) =>
        d.kind === "auth" ||
        ((d.kind === "tls" || d.kind === "network") &&
          !!host &&
          d.reason.toLowerCase().includes(host)),
    );
    if (fatal) return "fail";
  }
  return "warn";
}

function clamp(text: string): string {
  return text.length > MAX_REASON_LEN ? `${text.slice(0, MAX_REASON_LEN - 1)}…` : text;
}

function firstLine(text: string): string {
  const line = text
    .split("\n")
    .map((l) => l.trim())
    .find(Boolean);
  if (!line) return "probe returned no output";
  return clamp(line);
}
