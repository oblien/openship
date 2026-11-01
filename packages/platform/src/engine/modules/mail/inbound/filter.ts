/**
 * Deciding whether a captured message should fire a notification — pure, no I/O.
 *
 * Everything here runs on the HEADER BLOCK of a BCC copy sitting in the collector
 * folder. Keeping it pure is deliberate: this is where the feature is dangerous (a loop
 * that mails itself, a rule that leaks every message on the server, an alert per spam),
 * and none of those failure modes should need a mail server to test.
 *
 * WHAT WE CAN AND CANNOT KNOW. `enable_original_recipient = no` in the shipped main.cf
 * ("Avoid duplicate recipient messages"), so the BCC copy carries NO `X-Original-To` and
 * its envelope recipient is the collector, not the mailbox the mail was for. The only
 * evidence of the original recipient is the `To`/`Cc` header. That is authoritative for
 * ordinary mail and WRONG for anything Bcc'd or alias-expanded — so a `mailbox`-scope
 * rule can miss a message that genuinely arrived at its target. A `domain`-scope rule has
 * no such gap, because the capture itself is domain-keyed. This is a property of Postfix's
 * config, not something the control plane can fix; it is called out in the UI copy.
 */

import type { MailInboundRule } from "@repo/db";

/** The subset of headers any decision here is allowed to depend on. */
export interface ParsedHeaders {
  /** `From:` — display form, e.g. `Alice <alice@example.com>`. */
  from?: string;
  /** Lowercased bare address out of `From:`, e.g. `alice@example.com`. */
  fromAddress?: string;
  /** `To:` and `Cc:` joined — the only evidence of the original recipient. */
  recipients: string[];
  subject?: string;
  /** `Return-Path:` — the ENVELOPE sender. `<>` means this is a bounce. */
  returnPath?: string;
  messageId?: string;
  /** amavis writes these when SpamAssassin crosses the tag level. */
  spamFlagYes: boolean;
  spamScore?: number;
  autoSubmitted?: string;
  precedence?: string;
  listId?: string;
}

/** Why a message was dropped before any rule was consulted. */
export type DropReason =
  | "bounce"
  | "auto-submitted"
  | "bulk-precedence"
  | "mailing-list"
  | "openship-sender"
  | "spam-flagged";

export interface FilterDecision {
  drop: boolean;
  reason?: DropReason;
}

/**
 * Unfold and split an RFC 5322 header block.
 *
 * Continuation lines begin with space or tab and belong to the previous field, which
 * matters immediately: long `Subject:` and `To:` values are folded in practice, and a
 * naive line split would truncate a subject mid-word and lose half a recipient list.
 * Field names are case-insensitive; the FIRST occurrence wins, because a second
 * `From:` is either malformed or an attempt to confuse a reader downstream.
 */
export function parseHeaderBlock(raw: string): ParsedHeaders {
  const fields = new Map<string, string>();
  let currentName: string | null = null;
  let currentValue = "";

  const flush = () => {
    if (currentName && !fields.has(currentName)) {
      fields.set(currentName, currentValue.trim());
    }
    currentName = null;
    currentValue = "";
  };

  // Normalize CRLF first so a Windows-authored fixture and a real message agree.
  for (const line of raw.replace(/\r\n/g, "\n").split("\n")) {
    // A blank line ends the header block; a body must never reach a rule decision.
    if (line === "") break;
    if (/^[ \t]/.test(line)) {
      if (currentName) currentValue += " " + line.trim();
      continue;
    }
    const sep = line.indexOf(":");
    if (sep <= 0) continue;
    flush();
    currentName = line.slice(0, sep).trim().toLowerCase();
    currentValue = line.slice(sep + 1);
  }
  flush();

  const to = fields.get("to");
  const cc = fields.get("cc");
  const recipients = [to, cc]
    .filter((v): v is string => Boolean(v))
    .flatMap((v) => v.split(","))
    .map((v) => bareAddress(v))
    .filter((v): v is string => Boolean(v));

  const scoreRaw = fields.get("x-spam-score");
  const score = scoreRaw === undefined ? undefined : Number.parseFloat(scoreRaw);

  return {
    from: fields.get("from"),
    fromAddress: bareAddress(fields.get("from")),
    recipients,
    subject: fields.get("subject"),
    returnPath: fields.get("return-path"),
    messageId: fields.get("message-id"),
    // amavis writes `X-Spam-Flag: YES`; anything else (absent, NO) is not a positive.
    spamFlagYes: (fields.get("x-spam-flag") ?? "").trim().toUpperCase() === "YES",
    spamScore: score !== undefined && Number.isFinite(score) ? score : undefined,
    autoSubmitted: fields.get("auto-submitted"),
    precedence: fields.get("precedence"),
    listId: fields.get("list-id"),
  };
}

/** `Alice <a@b.com>` / `a@b.com` / `<a@b.com>` → `a@b.com`, lowercased. */
export function bareAddress(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const angled = value.match(/<([^>]*)>/);
  const candidate = (angled ? angled[1] : value).trim().toLowerCase();
  // An empty `<>` is a real and meaningful value (a bounce), so it is preserved rather
  // than being normalized away to undefined.
  if (candidate === "") return "";
  return candidate.includes("@") ? candidate : undefined;
}

/**
 * The guards that run BEFORE any rule, in the order a mail incident actually happens.
 *
 * A notification about mail is itself mail. If any of these is missing, a single
 * notification delivered to an address on the watched engine re-captures itself and the
 * loop only stops when someone notices — so these are not tuning knobs.
 *
 * `openshipSenders` are the addresses this instance sends its own mail FROM (the platform
 * mailbox, and whatever Settings→Email is configured with). They are passed in rather
 * than derived so this stays pure.
 */
export function loopGuard(
  h: ParsedHeaders,
  opts: { openshipSenders?: readonly string[] } = {},
): FilterDecision {
  // A null envelope sender is a BOUNCE. Notifying on bounces is how a bounce storm
  // becomes an alert storm, and the reply-to-a-bounce case is a classic mail loop.
  if (h.returnPath !== undefined && bareAddress(h.returnPath) === "") {
    return { drop: true, reason: "bounce" };
  }
  // RFC 3834: anything not `no` is machine-generated, which includes our own alerts if a
  // channel ever mails one back.
  const auto = (h.autoSubmitted ?? "").trim().toLowerCase();
  if (auto && auto !== "no") return { drop: true, reason: "auto-submitted" };

  const precedence = (h.precedence ?? "").trim().toLowerCase();
  if (precedence === "bulk" || precedence === "junk") {
    return { drop: true, reason: "bulk-precedence" };
  }
  // `List-Id` marks list traffic, which is the highest-volume way to flood a channel.
  if (h.listId) return { drop: true, reason: "mailing-list" };

  const senders = opts.openshipSenders ?? [];
  if (h.fromAddress && senders.some((s) => s.toLowerCase() === h.fromAddress)) {
    return { drop: true, reason: "openship-sender" };
  }
  return { drop: false };
}

/**
 * The spam gate, which exists because nothing upstream provides one.
 *
 * The shipped amavis policy sets `spam_lover='Y'` AND `bad_header_lover='Y'` on the
 * catch-all `@.` policy with empty quarantine targets, so the global
 * `$final_spam_destiny = D_DISCARD` never applies to any recipient: spam IS delivered,
 * and therefore IS captured. Bad-header mail is delivered too and carries no
 * `X-Spam-Flag` at all, which is why the score is checked independently of the flag.
 *
 * With no `maxSpamScore` set on the rule, a positive `X-Spam-Flag` alone is enough to
 * drop — the conservative default, since the alternative is paging on spam.
 */
export function spamGate(h: ParsedHeaders, maxSpamScore: number | null): FilterDecision {
  if (maxSpamScore === null || maxSpamScore === undefined) {
    return h.spamFlagYes ? { drop: true, reason: "spam-flagged" } : { drop: false };
  }
  if (h.spamScore !== undefined && h.spamScore > maxSpamScore) {
    return { drop: true, reason: "spam-flagged" };
  }
  return { drop: false };
}

/**
 * Does this rule want this message?
 *
 * `capturedDomain` is the domain whose BCC row produced the copy — structural and
 * trustworthy, unlike the recipient headers.
 *
 * FAIL CLOSED is the whole point of the target checks. There is no CHECK constraint
 * tying `scope` to `target` (this schema has none anywhere), so a `mailbox` or `domain`
 * rule with a null target is representable — and if it were treated as "no constraint"
 * it would silently become "every message on the server", i.e. an operator who mistyped
 * a rule quietly forwards a whole domain's mail metadata to Slack. It matches nothing.
 */
export function matchesRule(
  rule: Pick<
    MailInboundRule,
    "scope" | "target" | "fromPattern" | "subjectPattern" | "enabled" | "pausedReason"
  >,
  h: ParsedHeaders,
  capturedDomain: string,
): boolean {
  if (!rule.enabled || rule.pausedReason) return false;

  const target = rule.target?.trim().toLowerCase() ?? "";

  switch (rule.scope) {
    case "all":
      break;
    case "domain":
      if (!target) return false;
      if (target !== capturedDomain.toLowerCase()) return false;
      break;
    case "mailbox": {
      if (!target) return false;
      // The To/Cc caveat in this file's header applies here: a Bcc'd or alias-expanded
      // message cannot be attributed to a mailbox from headers alone.
      if (!h.recipients.some((r) => r === target)) return false;
      break;
    }
    default:
      // An unknown scope is a rule this build does not understand. Matching nothing is
      // the only safe reading — the alternative is matching everything.
      return false;
  }

  if (rule.fromPattern && !matchesPattern(rule.fromPattern, h.from ?? h.fromAddress)) {
    return false;
  }
  if (rule.subjectPattern && !matchesPattern(rule.subjectPattern, h.subject)) {
    return false;
  }
  return true;
}

/**
 * Operator-facing matching: case-insensitive substring, with `*` as a wildcard.
 *
 * Deliberately NOT a regular expression. These patterns come from a text box, they run
 * once per delivered message, and an operator pasting `.*(a+)+$` would hand us a
 * catastrophic-backtracking stall on the mail path. Every metacharacter is escaped and
 * only `*` is given meaning.
 */
export function matchesPattern(pattern: string, value: string | undefined): boolean {
  if (!value) return false;
  const trimmed = pattern.trim();
  if (!trimmed) return true;
  const escaped = trimmed.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\\\*/g, ".*");
  return new RegExp(escaped, "i").test(value);
}
