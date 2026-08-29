import { describe, expect, it } from "vitest";
import {
  bareAddress,
  loopGuard,
  matchesPattern,
  matchesRule,
  parseHeaderBlock,
  spamGate,
} from "../../../src/modules/mail/inbound/filter";
import type { MailInboundRule } from "@repo/db";

/**
 * The decisions that make inbound-mail notifications safe rather than an incident.
 *
 * Three failure modes are covered deliberately, because each is silent in production:
 *   - a loop (a notification about mail is itself mail),
 *   - a rule that quietly widens to every message on the server,
 *   - an alert per spam, because nothing upstream filters spam for us.
 */

const HEADERS = [
  "Return-Path: <alice@example.com>",
  "From: Alice Example <Alice@Example.com>",
  "To: support@acme.com, ops@acme.com",
  "Subject: Invoice 42 is overdue",
  "Message-Id: <abc@example.com>",
  "",
  "body must never be parsed",
].join("\n");

function rule(over: Partial<MailInboundRule> = {}): MailInboundRule {
  return {
    scope: "domain",
    target: "acme.com",
    fromPattern: null,
    subjectPattern: null,
    enabled: true,
    pausedReason: null,
    ...over,
  } as MailInboundRule;
}

describe("parseHeaderBlock", () => {
  it("parses the fields a decision is allowed to use, and stops at the body", () => {
    const h = parseHeaderBlock(HEADERS);
    expect(h.fromAddress).toBe("alice@example.com");
    expect(h.recipients).toEqual(["support@acme.com", "ops@acme.com"]);
    expect(h.subject).toBe("Invoice 42 is overdue");
    expect(h.messageId).toBe("<abc@example.com>");
    // A blank line ends the block; body content must not become a "header".
    expect(JSON.stringify(h)).not.toContain("body must never");
  });

  it("unfolds continuation lines instead of truncating them", () => {
    // Long To/Subject values ARE folded in real mail. A naive line split loses half the
    // recipient list, which would make a mailbox-scope rule miss its own target.
    const h = parseHeaderBlock(
      ["Subject: a very long subject", "\tthat continues here", "To: one@acme.com,", " two@acme.com", ""].join("\n"),
    );
    expect(h.subject).toBe("a very long subject that continues here");
    expect(h.recipients).toEqual(["one@acme.com", "two@acme.com"]);
  });

  it("is case-insensitive on names and keeps the FIRST occurrence", () => {
    const h = parseHeaderBlock(["FROM: first@a.com", "From: second@b.com", ""].join("\n"));
    expect(h.fromAddress).toBe("first@a.com");
  });

  it("handles CRLF, so a real message and a fixture agree", () => {
    const h = parseHeaderBlock("Subject: hi\r\nTo: a@b.com\r\n\r\nbody");
    expect(h.subject).toBe("hi");
    expect(h.recipients).toEqual(["a@b.com"]);
  });

  it("reads X-Spam-Flag and a float score, ignoring a malformed score", () => {
    expect(parseHeaderBlock("X-Spam-Flag: YES\n").spamFlagYes).toBe(true);
    expect(parseHeaderBlock("X-Spam-Flag: no\n").spamFlagYes).toBe(false);
    expect(parseHeaderBlock("X-Spam-Score: 7.4\n").spamScore).toBe(7.4);
    expect(parseHeaderBlock("X-Spam-Score: not-a-number\n").spamScore).toBeUndefined();
  });
});

describe("bareAddress", () => {
  it("preserves the empty angle pair, because <> IS the bounce signal", () => {
    expect(bareAddress("<>")).toBe("");
    expect(bareAddress("Alice <a@b.com>")).toBe("a@b.com");
    expect(bareAddress("A@B.COM")).toBe("a@b.com");
    expect(bareAddress("not-an-address")).toBeUndefined();
    expect(bareAddress(undefined)).toBeUndefined();
  });
});

describe("loopGuard — the four guards", () => {
  it("drops a bounce (null envelope sender)", () => {
    const h = parseHeaderBlock("Return-Path: <>\nFrom: mailer@x.com\n");
    expect(loopGuard(h)).toEqual({ drop: true, reason: "bounce" });
  });

  it("drops anything Auto-Submitted other than 'no'", () => {
    expect(loopGuard(parseHeaderBlock("Auto-Submitted: auto-generated\n")).drop).toBe(true);
    expect(loopGuard(parseHeaderBlock("Auto-Submitted: auto-replied\n")).drop).toBe(true);
    expect(loopGuard(parseHeaderBlock("Auto-Submitted: no\n")).drop).toBe(false);
  });

  it("drops bulk/junk precedence and list traffic", () => {
    expect(loopGuard(parseHeaderBlock("Precedence: bulk\n")).reason).toBe("bulk-precedence");
    expect(loopGuard(parseHeaderBlock("Precedence: junk\n")).reason).toBe("bulk-precedence");
    expect(loopGuard(parseHeaderBlock("List-Id: <l.example.com>\n")).reason).toBe("mailing-list");
  });

  it("drops our OWN outbound sender — the direct self-feeding loop", () => {
    // A notification delivered to an address inside a watched domain would otherwise be
    // captured and emit again, forever.
    const h = parseHeaderBlock("From: Openship <noreply@acme.com>\n");
    expect(loopGuard(h, { openshipSenders: ["NoReply@acme.com"] })).toEqual({
      drop: true,
      reason: "openship-sender",
    });
  });

  it("lets ordinary human mail through", () => {
    expect(loopGuard(parseHeaderBlock(HEADERS))).toEqual({ drop: false });
  });
});

describe("spamGate", () => {
  it("drops flagged spam when no threshold is set (the conservative default)", () => {
    expect(spamGate(parseHeaderBlock("X-Spam-Flag: YES\n"), null).reason).toBe("spam-flagged");
    expect(spamGate(parseHeaderBlock("Subject: hi\n"), null).drop).toBe(false);
  });

  it("honours an explicit threshold on the score", () => {
    const spammy = parseHeaderBlock("X-Spam-Flag: YES\nX-Spam-Score: 9.1\n");
    expect(spamGate(spammy, 10).drop).toBe(false); // operator asked for a loose gate
    expect(spamGate(spammy, 5).drop).toBe(true);
  });

  it("catches bad-header mail, which is delivered with NO X-Spam-Flag at all", () => {
    // bad_header_lover='Y' in the shipped policy, and bad-header mail is not flagged —
    // so the score has to be checked independently of the flag.
    const badHeader = parseHeaderBlock("X-Spam-Score: 8.0\n");
    expect(badHeader.spamFlagYes).toBe(false);
    expect(spamGate(badHeader, 6.9).drop).toBe(true);
  });
});

describe("matchesRule — fail closed", () => {
  const h = parseHeaderBlock(HEADERS);

  it("matches a domain rule against the CAPTURED domain, not a header", () => {
    expect(matchesRule(rule({ scope: "domain", target: "acme.com" }), h, "acme.com")).toBe(true);
    expect(matchesRule(rule({ scope: "domain", target: "acme.com" }), h, "other.com")).toBe(false);
  });

  it("matches a mailbox rule on To/Cc", () => {
    expect(matchesRule(rule({ scope: "mailbox", target: "support@acme.com" }), h, "acme.com")).toBe(true);
    expect(matchesRule(rule({ scope: "mailbox", target: "nobody@acme.com" }), h, "acme.com")).toBe(false);
  });

  it("matches EVERYTHING captured for scope=all", () => {
    expect(matchesRule(rule({ scope: "all", target: null }), h, "anything.com")).toBe(true);
  });

  // The reason there is no CHECK constraint and this logic exists instead.
  it("matches NOTHING when a mailbox/domain rule has no target", () => {
    expect(matchesRule(rule({ scope: "mailbox", target: null }), h, "acme.com")).toBe(false);
    expect(matchesRule(rule({ scope: "domain", target: null }), h, "acme.com")).toBe(false);
    expect(matchesRule(rule({ scope: "domain", target: "   " }), h, "acme.com")).toBe(false);
  });

  it("matches nothing for a scope this build does not understand", () => {
    expect(matchesRule(rule({ scope: "everything", target: null }), h, "acme.com")).toBe(false);
  });

  it("respects enabled and pausedReason", () => {
    expect(matchesRule(rule({ enabled: false }), h, "acme.com")).toBe(false);
    expect(matchesRule(rule({ pausedReason: "rate limit" }), h, "acme.com")).toBe(false);
  });

  it("applies from and subject filters on top of scope", () => {
    expect(matchesRule(rule({ fromPattern: "alice@" }), h, "acme.com")).toBe(true);
    expect(matchesRule(rule({ fromPattern: "bob@" }), h, "acme.com")).toBe(false);
    expect(matchesRule(rule({ subjectPattern: "overdue" }), h, "acme.com")).toBe(true);
    expect(matchesRule(rule({ subjectPattern: "refund" }), h, "acme.com")).toBe(false);
  });
});

describe("matchesPattern", () => {
  it("is case-insensitive substring with * as the only wildcard", () => {
    expect(matchesPattern("INVOICE", "Invoice 42")).toBe(true);
    expect(matchesPattern("inv*42", "Invoice 42")).toBe(true);
    expect(matchesPattern("*@acme.com", "bob@acme.com")).toBe(true);
  });

  it("treats regex metacharacters literally, so an operator cannot inject one", () => {
    // A pasted `.*` must not match everything, and a pasted `(a+)+$` must not stall the
    // mail path with catastrophic backtracking.
    expect(matchesPattern(".*", "anything")).toBe(false);
    expect(matchesPattern("a.c", "abc")).toBe(false);
    expect(matchesPattern("a.c", "a.c")).toBe(true);
    expect(matchesPattern("price?", "price?")).toBe(true);
    expect(() => matchesPattern("(a+)+$", "aaaaaaaaaaaaaaaaaaaaaaaaaaa!")).not.toThrow();
  });

  it("an empty pattern is 'no filter', and a missing value never matches", () => {
    expect(matchesPattern("  ", "anything")).toBe(true);
    expect(matchesPattern("x", undefined)).toBe(false);
  });
});
