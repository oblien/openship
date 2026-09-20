import { describe, expect, it } from "vitest";

import en from "@/i18n/locales/en/emailsAdmin.json";
import type {
  DnsCheck,
  MailComponentHealth,
  MailDeliveryHealth,
  MailPortReachability,
} from "@/lib/api";

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
    severity: "required",
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

function reachability(overrides: Partial<MailPortReachability> = {}): MailPortReachability {
  return {
    hostname: "mail.example.com",
    address: "203.0.113.10",
    checkedAt: 0,
    status: "ok",
    ports: [],
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

  it("goes red when the daemons listen but a public mail port is blocked", () => {
    const s = summarizeHealth(
      NINE_UP,
      [dns("pass")],
      delivery(),
      h,
      reachability({ status: "fail" }),
    );

    expect(s?.banner).toContain("danger");
    expect(s?.sub).toContain(h.summary.partReachability);
  });

  it("does not grade an unavailable external probe as an outage", () => {
    const s = summarizeHealth(
      NINE_UP,
      [dns("pass")],
      delivery(),
      h,
      reachability({ status: "unknown", detail: "No public DNS result" }),
    );

    expect(s?.label).toBe(h.summary.allGoodLabel);
  });

  it("warns instead of declaring mail healthy when inbound SMTP is unverified", () => {
    const s = summarizeHealth(
      NINE_UP,
      [dns("pass")],
      delivery(),
      h,
      reachability({
        status: "unknown",
        ports: [
          {
            key: "smtp",
            port: 25,
            label: "SMTP inbound",
            status: "blocked",
            listening: true,
            exposed: true,
            reachable: false,
            failure: "timeout",
          },
        ],
      }),
    );

    expect(s?.banner).toContain("warning");
    expect(s?.label).toBe(h.summary.almostLabel);
    expect(s?.sub).toBe(h.reachability.unknownHint);
  });

  /**
   * The #565 defect: a dead ClamAV painted the same red "Issues need attention"
   * banner as a dead Postfix, so the one signal that means "stop what you are doing"
   * fired for a box that was still delivering mail.
   */
  it("is amber, not red, when only an advisory daemon is down", () => {
    const s = summarizeHealth(
      [
        daemon({ key: "clamav", label: "ClamAV", severity: "advisory", status: "failed", subState: "fatal" }),
        ...NINE_UP,
      ],
      [dns("pass")],
      delivery(),
      h,
    );

    expect(s?.banner).toContain("warning");
    expect(s?.label).toBe(h.summary.degradedLabel);
    expect(s?.sub).toContain("ClamAV");
    /**
     * GH-565: this used to assert the copy said mail would "queue", which was the
     * opposite of what the engine does. `apps/email/engine/samples/amavisd/amavisd.conf`
     * sets neither `$virus_scanners_failure_is_fatal` nor `$final_unchecked_destiny`, and
     * `$undecipherable_subject_tag` is `undef` - so a message no scanner could examine is
     * DELIVERED, unlabelled. The old assertion made a passing test guard a false promise,
     * which is worse than no test: an operator reading "may queue" waits for mail to flow
     * again instead of learning that unscanned mail is already reaching inboxes.
     *
     * If you want the queue behaviour, it is one line in amavisd.conf - see the opt-in
     * documented there - and this assertion should flip back at the same time.
     */
    expect(s?.sub).toMatch(/WITHOUT virus scanning/i);
    expect(s?.sub).not.toContain("queue");
  });

  it("says signatures, not scanning, when only freshclam is down", () => {
    const s = summarizeHealth(
      [
        daemon({ key: "freshclam", label: "ClamAV updates", severity: "advisory", status: "inactive" }),
        ...NINE_UP,
      ],
      [dns("pass")],
      delivery(),
      h,
    );

    expect(s?.banner).toContain("warning");
    expect(s?.sub).toContain("signatures");
    expect(s?.sub).not.toContain("queue");
  });

  it("still names an advisory daemon when something required is also down", () => {
    const s = summarizeHealth(
      [
        daemon({ key: "dovecot", label: "Dovecot", status: "failed" }),
        daemon({ key: "clamav", label: "ClamAV", severity: "advisory", status: "failed" }),
        ...NINE_UP,
      ],
      [dns("pass")],
      delivery(),
      h,
    );

    expect(s?.banner).toContain("danger");
    expect(s?.sub).toContain("Dovecot");
    expect(s?.sub).toContain("ClamAV");
  });

  /**
   * GH-240 FP1: `spamd` is reported for completeness, but amavis scores spam through its
   * own in-process Mail::SpamAssassin integration and nothing on this stack speaks to the
   * daemon - so its state says nothing about whether spam filtering works. It used to be
   * graded `advisory`, which put a permanent amber banner on every host that simply does
   * not run it. An amber that is always wrong teaches operators to ignore the banner.
   */
  it("stays green when only an informational daemon is down", () => {
    const s = summarizeHealth(
      [
        daemon({ key: "spamassassin", label: "SpamAssassin", severity: "informational", status: "failed" }),
        ...NINE_UP,
      ],
      [dns("pass")],
      delivery(),
      h,
    );

    expect(s?.label).toBe(h.summary.allGoodLabel);
    expect(s?.sub ?? "").not.toContain("SpamAssassin");
  });

  it("stays green when an informational daemon is missing entirely", () => {
    // The common shape on a legacy host: the unit was never installed.
    const s = summarizeHealth(
      [
        daemon({ key: "spamassassin", label: "SpamAssassin", severity: "informational", status: "missing" }),
        ...NINE_UP,
      ],
      [dns("pass")],
      delivery(),
      h,
    );

    expect(s?.label).toBe(h.summary.allGoodLabel);
  });

  it("is not green while an advisory daemon is down", () => {
    const s = summarizeHealth(
      [daemon({ key: "fail2ban", label: "fail2ban", severity: "advisory", status: "inactive" }), ...NINE_UP],
      [dns("pass")],
      delivery(),
      h,
    );

    expect(s?.label).not.toBe(h.summary.allGoodLabel);
    expect(s?.sub).toBe("fail2ban not running");
  });

  /**
   * A row an older API didn't stamp with `severity` must fail SAFE to required —
   * landing in neither bucket would leave the amber branch with a heading and no
   * sentence, which this file's whole priority contract forbids.
   */
  it("treats a row with no severity marker as required", () => {
    const unstamped = { ...daemon({ label: "Postfix", status: "failed" }) } as MailComponentHealth;
    delete (unstamped as { severity?: unknown }).severity;

    const s = summarizeHealth([unstamped, ...NINE_UP], [dns("pass")], delivery(), h);

    expect(s?.banner).toContain("danger");
    expect(s?.sub).toContain("Postfix");
  });
});
