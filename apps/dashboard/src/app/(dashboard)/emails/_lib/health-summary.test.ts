import { describe, expect, it } from "vitest";

import en from "@/i18n/locales/en/emailsAdmin.json";
import type { DnsCheck, MailComponentHealth, MailDeliveryHealth } from "@/lib/api";

import { summarizeHealth } from "./health-summary";

/**
 * The banner is the only part of the Health tab most operators read, so the thing
 * worth pinning is its priority order — and specifically that outbound delivery,
 * the newest of the three readings, can't be drowned out by the other two or
 * shout over them.
 *
 * Two failure modes this guards:
 *   1. A box whose relay credentials are wrong reads as healthy. Every daemon is
 *      up and every DNS record passes, because nothing about that setup is wrong
 *      except the password — so if delivery doesn't reach the banner, the banner
 *      is green while no mail has left in a week.
 *   2. A queue we couldn't read reads as broken. `unknown` is "we didn't look",
 *      and an SSH hiccup must not paint the banner red.
 */

const h = en.health;

function daemon(overrides: Partial<MailComponentHealth> = {}): MailComponentHealth {
  return {
    key: "postfix",
    label: "Postfix",
    description: "SMTP server",
    unit: "postfix",
    status: "active",
    ...overrides,
  };
}

function dns(status: DnsCheck["status"]): DnsCheck {
  return {
    key: "spf",
    label: "SPF",
    description: "Sender policy",
    queriedName: "example.com",
    recordType: "TXT",
    status,
    expected: "v=spf1 …",
    actual: "",
    message: "…",
  };
}

function delivery(overrides: Partial<MailDeliveryHealth> = {}): MailDeliveryHealth {
  return {
    status: "ok",
    mode: "direct",
    queued: 0,
    sampled: false,
    deferrals: [],
    ...overrides,
  };
}

const NINE_UP = Array.from({ length: 9 }, (_, i) => daemon({ key: `d${i}` }));

describe("summarizeHealth", () => {
  it("reports nothing before any reading lands", () => {
    expect(summarizeHealth(null, null, null, h)).toBeNull();
  });

  it("is green when all three readings are clean", () => {
    const s = summarizeHealth(NINE_UP, [dns("pass")], delivery(), h);

    expect(s?.label).toBe(h.summary.allGoodLabel);
    expect(s?.banner).toContain("success");
  });

  /** The whole reason this reading exists. */
  it("goes red when mail is not leaving a box whose daemons and DNS are perfect", () => {
    const s = summarizeHealth(
      NINE_UP,
      [dns("pass")],
      delivery({
        status: "fail",
        mode: "relay",
        relayHost: "email-smtp.us-east-1.amazonaws.com:587",
        queued: 42,
        deferrals: [{ kind: "auth", count: 42, reason: "535 Authentication Credentials Invalid" }],
      }),
      h,
    );

    expect(s?.banner).toContain("danger");
    expect(s?.label).toBe(h.summary.issuesLabel);
    expect(s?.sub).toBe(h.summary.partDelivery);
  });

  it("names delivery beside the other faults rather than replacing them", () => {
    const s = summarizeHealth(
      [daemon({ label: "Dovecot", status: "failed" }), ...NINE_UP],
      [dns("fail")],
      delivery({ status: "fail", queued: 3, deferrals: [{ kind: "network", count: 3, reason: "Connection timed out" }] }),
      h,
    );

    expect(s?.sub).toContain("Dovecot");
    expect(s?.sub).toContain(h.summary.partDelivery);
    expect(s?.sub.endsWith(h.summary.partDelivery)).toBe(true);
  });

  it("is amber, not red, for mail merely waiting in the queue", () => {
    const s = summarizeHealth(
      NINE_UP,
      [dns("pass")],
      delivery({ status: "warn", queued: 4, deferrals: [{ kind: "rejected", count: 4, reason: "450 4.2.0 Greylisted" }] }),
      h,
    );

    expect(s?.banner).toContain("warning");
    expect(s?.label).toBe(h.summary.almostLabel);
    expect(s?.sub).toBe("4 messages are waiting to go out - see Outbound delivery below.");
  });

  it("uses the singular sentence for one queued message", () => {
    const s = summarizeHealth(NINE_UP, [dns("pass")], delivery({ status: "warn", queued: 1 }), h);

    expect(s?.sub).toBe("1 message is waiting to go out - see Outbound delivery below.");
  });

  /**
   * The DNS-only wording predates this reading and is what operators are used to
   * seeing; adding delivery must not reword it.
   */
  it("leaves the DNS-only warning sentence untouched", () => {
    const s = summarizeHealth(NINE_UP, [dns("warn"), dns("warn")], delivery(), h);

    expect(s?.sub).toBe("2 optional DNS records could be improved - see DNS scan below.");
  });

  it("joins a DNS warning and a queue backlog into one sentence", () => {
    const s = summarizeHealth(NINE_UP, [dns("warn")], delivery({ status: "warn", queued: 2 }), h);

    expect(s?.sub).toBe(
      "1 optional DNS record could be improved - see DNS scan below. · 2 messages are waiting to go out - see Outbound delivery below.",
    );
  });

  it("keeps the queue note visible beside daemons this host doesn't ship", () => {
    const s = summarizeHealth(
      [daemon({ label: "ClamAV", status: "missing" }), ...NINE_UP],
      [dns("pass")],
      delivery({ status: "warn", queued: 7 }),
      h,
    );

    expect(s?.label).toContain("ClamAV");
    expect(s?.sub).toContain("7 messages are waiting to go out");
  });

  it("stays green when the queue could not be read", () => {
    const s = summarizeHealth(
      NINE_UP,
      [dns("pass")],
      delivery({ status: "unknown", detail: "The mail engine isn't running." }),
      h,
    );

    expect(s?.label).toBe(h.summary.allGoodLabel);
    expect(s?.sub).not.toContain("waiting");
  });

  it("summarizes delivery alone before the daemon and DNS readings arrive", () => {
    const s = summarizeHealth(null, null, delivery({ status: "fail" }), h);

    expect(s?.banner).toContain("danger");
    expect(s?.sub).toBe(h.summary.partDelivery);
  });
});
