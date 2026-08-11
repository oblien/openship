import { describe, expect, it, vi } from "vitest";

import {
  checkMailDelivery,
  describePath,
  gradeDelivery,
  parseMailQueue,
  type MailQueueReading,
} from "../../../src/modules/mail/mail-delivery.service";
import { mailQueueProbeCommand } from "../../../src/modules/mail/mail-engine";
import type { CommandExecutor } from "@repo/adapters";
import type { OutboundRelay } from "../../../src/modules/mail/mail-state";

/**
 * The blind spot this closes: nine green daemons, green DNS, and a Test-tab email
 * that reports success, on a box where not one message has left in three days
 * because the relay's SASL password is wrong. Our Postfix accepts and queues the
 * test message — the relay hop happens after the `250 OK` — so the queue is the
 * only place the truth is written down.
 *
 * Two properties are pinned here, and both are about not lying:
 *   1. `queued` is postqueue's OWN total, never a count of the lines we read, so
 *      the number an operator acts on survives the `tail` window.
 *   2. A probe we couldn't run reports `unknown` with its reason — never `ok`
 *      (silently healthy) and never `fail` (a fault we didn't observe).
 */

// ─── Fixtures ────────────────────────────────────────────────────────────────

const HEADER = "-Queue ID-  --Size-- ----Arrival Time---- -Sender/Recipient-------";

/** `postqueue -p` for one deferred message, in Postfix's exact layout. */
function queueOutput(
  entries: { id?: string; reason: string; rcpt?: string }[],
  opts: { total?: number; header?: boolean } = {},
): string {
  const lines = opts.header === false ? [] : [HEADER];
  for (const [i, e] of entries.entries()) {
    lines.push(
      `${e.id ?? `A1B2C3D4E${i}`}*     1234 Fri Aug  8 02:0${i}:00  sender@example.com`,
      `(${e.reason})`,
      `                                         ${e.rcpt ?? "rcpt@example.org"}`,
      "",
    );
  }
  lines.push(`-- ${entries.length * 2} Kbytes in ${opts.total ?? entries.length} Requests.`);
  return lines.join("\n");
}

const AUTH_REFUSAL =
  "host email-smtp.us-east-1.amazonaws.com[203.0.113.9] said: 535 Authentication Credentials Invalid (in reply to AUTH LOGIN command)";
const GREYLIST_REFUSAL =
  "host mx.receiver.example[198.51.100.4] said: 450 4.2.0 Greylisted, try again later (in reply to end of DATA command)";

const RELAY: OutboundRelay = {
  enabled: true,
  provider: "ses",
  region: "us-east-1",
  host: "email-smtp.us-east-1.amazonaws.com",
  port: 587,
  username: "AKIAEXAMPLE",
  passwordEncrypted: "enc:…",
  scope: "all",
  updatedAt: new Date(0).toISOString(),
};

const reading = (over: Partial<MailQueueReading> = {}): MailQueueReading => ({
  queued: 0,
  sampled: false,
  deferrals: [],
  ...over,
});

// ─── parseMailQueue ──────────────────────────────────────────────────────────

describe("parseMailQueue", () => {
  it("reads an empty queue as a conclusion, not a failed probe", () => {
    expect(parseMailQueue("Mail queue is empty\n")).toEqual({
      queued: 0,
      sampled: false,
      deferrals: [],
    });
  });

  it("takes the depth from postqueue's own total", () => {
    const parsed = parseMailQueue(queueOutput([{ reason: GREYLIST_REFUSAL }]));

    expect(parsed?.queued).toBe(1);
    expect(parsed?.deferrals[0]?.reason).toContain("450 4.2.0 Greylisted");
  });

  /**
   * The whole reason `queued` comes from the trailer: `tail -n 400` can cut the
   * listing anywhere, and a depth derived from the lines we happened to read would
   * under-report a backlog by however much we truncated.
   */
  it("trusts the trailer's total over the entries it could actually see", () => {
    const parsed = parseMailQueue(queueOutput([{ reason: AUTH_REFUSAL }], { total: 4127 }));

    expect(parsed?.queued).toBe(4127);
    expect(parsed?.deferrals).toHaveLength(1);
  });

  // The header is printed first and the total last; we read the tail. So a total
  // with no header above it is proof the window truncated.
  it("flags the reasons as a sample when the window cut the header off", () => {
    const full = parseMailQueue(queueOutput([{ reason: AUTH_REFUSAL }], { total: 4127 }));
    const cut = parseMailQueue(
      queueOutput([{ reason: AUTH_REFUSAL }], { total: 4127, header: false }),
    );

    expect(full?.sampled).toBe(false);
    expect(cut?.sampled).toBe(true);
  });

  it("does not call a queue of untried messages a sample", () => {
    // 3 queued, none deferred yet — no reason lines at all, header intact.
    const parsed = parseMailQueue(`${HEADER}\nA1B2C3D4E5     10 Fri Aug  8 02:00:00  s@example.com
                                         r@example.org

-- 6 Kbytes in 3 Requests.`);

    expect(parsed).toEqual({ queued: 3, sampled: false, deferrals: [] });
  });

  it("collapses one cause across many messages into a single counted row", () => {
    const parsed = parseMailQueue(
      queueOutput([
        { reason: AUTH_REFUSAL, rcpt: "a@example.org" },
        { reason: AUTH_REFUSAL, rcpt: "b@example.org" },
        { reason: GREYLIST_REFUSAL, rcpt: "c@example.org" },
      ]),
    );

    expect(parsed?.queued).toBe(3);
    expect(parsed?.deferrals).toHaveLength(2);
    // Most frequent first: the outage, not the one-off.
    expect(parsed?.deferrals[0]).toMatchObject({ kind: "auth", count: 2 });
    expect(parsed?.deferrals[1]).toMatchObject({ count: 1 });
  });

  it("caps the reasons it reports", () => {
    const parsed = parseMailQueue(
      queueOutput(
        Array.from({ length: 6 }, (_, i) => ({ reason: `host mx${i}.example said: 451 try later` })),
      ),
    );

    expect(parsed?.queued).toBe(6);
    expect(parsed?.deferrals).toHaveLength(3);
  });

  /**
   * Postfix wraps a long refusal onto a continuation line. Classifying each half
   * separately loses the status code, which is exactly the part that decides the
   * remedy.
   */
  it("rejoins a reason Postfix wrapped across lines", () => {
    const parsed = parseMailQueue(
      [
        HEADER,
        "A1B2C3D4E5*     1234 Fri Aug  8 02:00:00  sender@example.com",
        "(host email-smtp.us-east-1.amazonaws.com[203.0.113.9] refused to talk to me:",
        "535 Authentication Credentials Invalid)",
        "                                         rcpt@example.org",
        "",
        "-- 2 Kbytes in 1 Requests.",
      ].join("\n"),
    );

    expect(parsed?.deferrals[0]?.kind).toBe("auth");
    expect(parsed?.deferrals[0]?.reason).toContain("535 Authentication Credentials Invalid");
  });

  it("caps a pathological reason instead of shipping it whole", () => {
    const parsed = parseMailQueue(queueOutput([{ reason: "x".repeat(900) }]));

    expect(parsed?.deferrals[0]?.reason.length).toBeLessThanOrEqual(240);
    expect(parsed?.deferrals[0]?.reason.endsWith("…")).toBe(true);
  });

  /**
   * This is the distinction the whole design rests on: output that isn't a queue
   * listing must NOT parse as an empty queue, or a box we can't read renders as a
   * box with nothing stuck.
   */
  it.each([
    ["a stopped engine", "Error response from daemon: Container openship-mail is not running"],
    ["a missing binary", "bash: line 1: postqueue: command not found"],
    ["a permission denial", "postqueue: fatal: Queue report unavailable - mail system is down"],
    ["silence", ""],
  ])("refuses to read %s as a queue", (_label, raw) => {
    expect(parseMailQueue(raw)).toBeNull();
  });
});

// ─── Classification ──────────────────────────────────────────────────────────

describe("parseMailQueue — failure classification", () => {
  const kindOf = (reason: string) => parseMailQueue(queueOutput([{ reason }]))?.deferrals[0]?.kind;

  it.each([
    ["535 auth refusal", AUTH_REFUSAL, "auth"],
    ["530 auth required", "host smtp.example.net said: 530 5.7.0 Authentication required", "auth"],
    ["SASL failure", "SASL authentication failed; server said: 454 Temporary failure", "auth"],
    [
      "TLS policy mismatch",
      "host smtp.example.net[203.0.113.9]: TLS is required, but our TLS engine is unavailable",
      "tls",
    ],
    ["expired certificate", "certificate verification failed for smtp.example.net", "tls"],
    ["blocked egress", "connect to smtp.example.net[203.0.113.9]:587: Connection timed out", "network"],
    ["greylisting", GREYLIST_REFUSAL, "rejected"],
    ["rate limiting", "host mx.example said: 421 4.7.0 too many messages from this sender", "rejected"],
    ["something new", "delivery temporarily suspended by local policy", "other"],
  ])("classifies %s as %s", (_label, reason, kind) => {
    expect(kindOf(reason)).toBe(kind);
  });
});

// ─── gradeDelivery ───────────────────────────────────────────────────────────

describe("gradeDelivery", () => {
  it("is ok on an empty queue", () => {
    expect(gradeDelivery(reading(), undefined)).toBe("ok");
    expect(gradeDelivery(reading(), RELAY)).toBe("ok");
  });

  it("warns on a backlog with no reason yet — mail is moving late, not failing", () => {
    expect(gradeDelivery(reading({ queued: 7 }), undefined)).toBe("warn");
  });

  /**
   * The relay is the ONLY host we authenticate to, so an auth refusal on a relayed
   * box is our own credentials and it kills every relayed message. That is the one
   * queue state that earns red.
   */
  it("fails a relayed box on an auth refusal", () => {
    const stuck = reading({
      queued: 12,
      deferrals: [{ kind: "auth", count: 12, reason: AUTH_REFUSAL }],
    });

    expect(gradeDelivery(stuck, RELAY)).toBe("fail");
    // Same refusal without a relay is one destination's opinion, not a config fault.
    expect(gradeDelivery(stuck, undefined)).toBe("warn");
  });

  it("fails a relayed box when TLS or the network breaks AT the smarthost", () => {
    const atRelay = reading({
      queued: 3,
      deferrals: [
        {
          kind: "network",
          count: 3,
          reason: "connect to email-smtp.us-east-1.amazonaws.com[203.0.113.9]:587: Connection timed out",
        },
      ],
    });

    expect(gradeDelivery(atRelay, RELAY)).toBe("fail");
  });

  // A relayed box still talks straight to receivers for the senders outside its
  // scope, and every MTA collects the odd unreachable destination. Red there would
  // train the operator to ignore the banner.
  it("only warns when the failing host is not the smarthost", () => {
    const elsewhere = reading({
      queued: 2,
      deferrals: [
        {
          kind: "network",
          count: 2,
          reason: "connect to mx.someone-else.example[198.51.100.9]:25: Connection refused",
        },
      ],
    });

    expect(gradeDelivery(elsewhere, RELAY)).toBe("warn");
  });

  it("only warns on a greylist, relayed or not", () => {
    const grey = reading({
      queued: 1,
      deferrals: [{ kind: "rejected", count: 1, reason: GREYLIST_REFUSAL }],
    });

    expect(gradeDelivery(grey, RELAY)).toBe("warn");
    expect(gradeDelivery(grey, undefined)).toBe("warn");
  });

  it("ignores a relay row that is switched off", () => {
    const stuck = reading({
      queued: 5,
      deferrals: [{ kind: "auth", count: 5, reason: AUTH_REFUSAL }],
    });

    expect(gradeDelivery(stuck, { ...RELAY, enabled: false })).toBe("warn");
  });
});

// ─── describePath ────────────────────────────────────────────────────────────

describe("describePath", () => {
  it("reports direct-to-MX when there is no relay", () => {
    expect(describePath(undefined)).toEqual({ mode: "direct" });
    expect(describePath({ ...RELAY, enabled: false })).toEqual({ mode: "direct" });
  });

  it("names the smarthost and its scope", () => {
    expect(describePath(RELAY)).toEqual({
      mode: "relay",
      relayHost: "email-smtp.us-east-1.amazonaws.com:587",
      relayScope: "all",
      relayDomains: undefined,
    });
  });

  /**
   * Under `selected` the domain list is the operator's answer to "why is this
   * message still going direct?", and it has to be the SAME list the DNS scan and
   * the published SPF used — hence `relayedDomainsFor`, including the domain of a
   * relayed single address.
   */
  it("lists the relayed domains under selected scope, address domains included", () => {
    const path = describePath({
      ...RELAY,
      scope: "selected",
      domains: ["Example.COM"],
      addresses: ["Contact@Other.com"],
    });

    expect(path.relayScope).toBe("selected");
    expect(path.relayDomains).toEqual(["example.com", "other.com"]);
  });
});

// ─── checkMailDelivery ───────────────────────────────────────────────────────

/**
 * A fake box. `detectMailEngine`'s probe is the only command with
 * `{{.Config.Image}}` in it, and `readState`'s is the only `cat`; everything else
 * is the queue read.
 */
function box(opts: {
  queue?: string | Error;
  relay?: OutboundRelay;
  detect?: string;
}): CommandExecutor & { exec: ReturnType<typeof vi.fn> } {
  const state = JSON.stringify({
    version: 1,
    serverId: "srv_1",
    domain: "example.com",
    startedAt: new Date(0).toISOString(),
    completedSteps: {},
    ...(opts.relay ? { outboundRelay: opts.relay } : {}),
  });
  return {
    exec: vi.fn(async (cmd: string) => {
      if (cmd.includes("{{.Config.Image}}")) return opts.detect ?? "true\topenship/mail:latest";
      if (cmd.startsWith("cat ")) return state;
      const queue = opts.queue ?? "Mail queue is empty";
      if (queue instanceof Error) throw queue;
      return queue;
    }),
  } as unknown as CommandExecutor & { exec: ReturnType<typeof vi.fn> };
}

describe("checkMailDelivery", () => {
  it("reports a healthy direct sender", async () => {
    const health = await checkMailDelivery(box({}));

    expect(health).toMatchObject({ status: "ok", mode: "direct", queued: 0, deferrals: [] });
    expect(health.detail).toBeUndefined();
  });

  it("reads the send hop from the state file and grades the queue against it", async () => {
    const exec = box({ relay: RELAY, queue: queueOutput([{ reason: AUTH_REFUSAL }], { total: 91 }) });

    const health = await checkMailDelivery(exec);

    expect(health.status).toBe("fail");
    expect(health.mode).toBe("relay");
    expect(health.relayHost).toBe("email-smtp.us-east-1.amazonaws.com:587");
    expect(health.queued).toBe(91);
    expect(health.deferrals[0]?.kind).toBe("auth");
  });

  it("probes the queue through the engine, once", async () => {
    const exec = box({});

    await checkMailDelivery(exec);

    const probes = exec.exec.mock.calls
      .map(([cmd]) => cmd as string)
      .filter((cmd) => cmd.includes("postqueue"));
    expect(probes).toEqual([mailQueueProbeCommand("container")]);
    expect(probes[0]).toContain("docker exec openship-mail");
  });

  it("probes a legacy host engine without docker", async () => {
    // No container, but systemd knows the units → flavor host.
    const exec = {
      exec: vi.fn(async (cmd: string) => {
        if (cmd.includes("{{.Config.Image}}")) return "";
        if (cmd.includes("systemctl show")) return "## postfix\nLoadState=loaded\nActiveState=active";
        if (cmd.startsWith("cat ")) return "";
        return "Mail queue is empty";
      }),
    } as unknown as CommandExecutor;

    const health = await checkMailDelivery(exec);

    expect(health.status).toBe("ok");
    expect(vi.mocked((exec as { exec: ReturnType<typeof vi.fn> }).exec).mock.calls
      .map(([cmd]) => cmd as string)
      .find((cmd) => cmd.includes("postqueue"))).not.toContain("docker exec");
  });

  // Every `unknown` below must carry a reason: without one the row is unactionable
  // and the operator's only recourse is to SSH in and run the probe by hand.
  it("reports unknown on a box with no mail engine", async () => {
    const health = await checkMailDelivery(box({ detect: "" }));

    expect(health).toMatchObject({ status: "unknown", queued: 0, deferrals: [] });
    expect(health.detail).toContain("No mail engine");
  });

  it("reports unknown, and says so, when the engine container is stopped", async () => {
    const health = await checkMailDelivery(box({ detect: "false\topenship/mail:latest" }));

    expect(health.status).toBe("unknown");
    expect(health.detail).toContain("isn't running");
  });

  it("reports unknown with the shell's own words when the probe throws", async () => {
    const health = await checkMailDelivery(
      box({ queue: new Error("Command timed out after 30000ms: docker exec openship-mail …") }),
    );

    expect(health.status).toBe("unknown");
    expect(health.detail).toContain("timed out after 30000ms");
  });

  it("reports unknown, not ok, when the probe answers with something that isn't a queue", async () => {
    const health = await checkMailDelivery(box({ queue: "bash: postqueue: command not found" }));

    expect(health.status).toBe("unknown");
    expect(health.detail).toContain("command not found");
  });

  /**
   * The send path is what the operator is looking at while the queue read fails, so
   * losing it to the same error would hide the most useful half of the panel.
   */
  it("still reports the send path when the queue can't be read", async () => {
    const health = await checkMailDelivery(
      box({ relay: RELAY, queue: new Error("ssh channel closed") }),
    );

    expect(health.status).toBe("unknown");
    expect(health.mode).toBe("relay");
    expect(health.relayHost).toBe("email-smtp.us-east-1.amazonaws.com:587");
  });

  it("falls back to direct when the state file is unreadable", async () => {
    const exec = {
      exec: vi.fn(async (cmd: string) => {
        if (cmd.includes("{{.Config.Image}}")) return "true\topenship/mail:latest";
        if (cmd.startsWith("cat ")) throw new Error("permission denied");
        return "Mail queue is empty";
      }),
    } as unknown as CommandExecutor;

    const health = await checkMailDelivery(exec);

    expect(health.mode).toBe("direct");
    expect(health.status).toBe("ok");
  });
});
