import { describe, expect, it } from "vitest";
import {
  collectorAddress,
  collectorFolderPath,
  collectorMailbox,
  generateToken,
  tokenFromBcc,
} from "../../../src/modules/mail/inbound/capture";

/**
 * The pure half of arming. Two of these are load-bearing beyond tidiness:
 *
 *   - token CASE. The Dovecot LDA pipe runs `flags=DRh`, whose `h` folds the DOMAIN to
 *     lowercase but NOT the `-m ${extension}`, while the userdb query LOWER()s the whole
 *     home path. A mixed-case token names a folder the computed path cannot find.
 *   - FOREIGN BCC detection. `recipient_bcc_domain` has one slot per domain, shared with
 *     operator archiving and compliance copies. Misreading somebody else's value as ours
 *     means overwriting it and silently switching their archiving off.
 */

describe("token round trip", () => {
  it("builds the collector address and reads the token back out", () => {
    const addr = collectorAddress("Acme.COM", "abc123");
    expect(addr).toBe("openship-hook+abc123@acme.com");
    expect(tokenFromBcc(addr)).toBe("abc123");
  });

  it("names one collector mailbox per domain, lowercased", () => {
    expect(collectorMailbox("Acme.COM")).toBe("openship-hook@acme.com");
  });

  it("generates lowercase [a-z0-9] tokens with real entropy", () => {
    for (let i = 0; i < 40; i++) {
      const t = generateToken();
      // Anything outside this class would name a folder we cannot find again.
      expect(t).toMatch(/^[a-z0-9]+$/);
      expect(t.length).toBeGreaterThanOrEqual(16);
    }
    // Not a constant.
    expect(new Set([generateToken(), generateToken(), generateToken()]).size).toBe(3);
  });
});

describe("tokenFromBcc — foreign values are never ours", () => {
  it("rejects an operator's own BCC", () => {
    // The case that must never be overwritten: archiving, compliance, iRedAdmin-Pro.
    expect(tokenFromBcc("archive@acme.com")).toBeNull();
    expect(tokenFromBcc("compliance+legal@acme.com")).toBeNull();
    expect(tokenFromBcc("openship@acme.com")).toBeNull();
  });

  it("rejects a near-miss that only looks like ours", () => {
    // A prefix match without the delimiter is a DIFFERENT mailbox.
    expect(tokenFromBcc("openship-hooks+abc@acme.com")).toBeNull();
    expect(tokenFromBcc("openship-hook@acme.com")).toBeNull();
    // Empty extension carries no folder, so it is not a usable token.
    expect(tokenFromBcc("openship-hook+@acme.com")).toBeNull();
  });

  it("rejects a token with characters the LDA would not fold", () => {
    expect(tokenFromBcc("openship-hook+ABC123@acme.com")).toBeNull();
    expect(tokenFromBcc("openship-hook+abc.123@acme.com")).toBeNull();
    expect(tokenFromBcc("openship-hook+abc-123@acme.com")).toBeNull();
  });

  it("handles absent values", () => {
    expect(tokenFromBcc(null)).toBeNull();
    expect(tokenFromBcc(undefined)).toBeNull();
    expect(tokenFromBcc("")).toBeNull();
  });
});

describe("collectorFolderPath — Maildir++ layout", () => {
  it("puts the token folder dot-prefixed under Maildir/", () => {
    // mail_location = maildir:%Lh/Maildir/, home from the userdb query, and Maildir++
    // stores a top-level folder as a dot-prefixed directory beside cur/new/tmp.
    expect(collectorFolderPath("/var/vmail/vmail1/acme.com/o/op/openship-hook-20260101000000/", "tok")).toBe(
      "/var/vmail/vmail1/acme.com/o/op/openship-hook-20260101000000/Maildir/.tok",
    );
  });

  it("tolerates a home with or without its trailing slash", () => {
    const withSlash = collectorFolderPath("/var/vmail/vmail1/a/", "t");
    const without = collectorFolderPath("/var/vmail/vmail1/a", "t");
    expect(withSlash).toBe(without);
    expect(without).toBe("/var/vmail/vmail1/a/Maildir/.t");
  });
});
