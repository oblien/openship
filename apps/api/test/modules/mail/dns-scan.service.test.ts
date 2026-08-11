import "./_setup-env";
import { beforeEach, describe, expect, test, vi } from "vitest";

const dns = vi.hoisted(() => {
  const fns = {
    resolve4: vi.fn(),
    resolve6: vi.fn(),
    resolveCname: vi.fn(),
    resolveMx: vi.fn(),
    resolveTxt: vi.fn(),
    reverse: vi.fn(),
    setServers: vi.fn(),
  };
  // The scan queries PUBLIC resolvers explicitly rather than the system stub
  // (which honours the mail host's own /etc/hosts). The class hands back the
  // same spies so every existing expectation still applies.
  class Resolver {
    setServers = fns.setServers;
    resolve4 = fns.resolve4;
    resolve6 = fns.resolve6;
    resolveCname = fns.resolveCname;
    resolveMx = fns.resolveMx;
    resolveTxt = fns.resolveTxt;
    reverse = fns.reverse;
  }
  return { ...fns, Resolver };
});

vi.mock("node:dns/promises", () => dns);

const BASE_STATE = {
  version: 1,
  serverId: "srv_test",
  domain: "example.com",
  startedAt: new Date(0).toISOString(),
  updatedAt: new Date(0).toISOString(),
  finishedAt: null,
  completedSteps: {},
  secrets: {},
  dnsAcknowledged: true,
  ptrAcknowledged: true,
  resumeStep: null,
  errorMessage: null,
  dnsRecords: {
    spf: {
      type: "TXT",
      name: "example.com",
      value: "v=spf1 mx -all",
      required: true,
    },
    dmarc: {
      type: "TXT",
      name: "_dmarc.example.com",
      value: "v=DMARC1; p=reject",
      required: true,
    },
    dkim: {
      type: "TXT",
      name: "dkim._domainkey.example.com",
      // Long enough to be chunked in DNS, like a real 2048-bit key.
      value: `v=DKIM1;p=${"A".repeat(300)}`,
      required: true,
    },
  },
};

/**
 * What `readState` hands back. Mutable so the relay suites can scan a box whose
 * send hop is a provider — reset to the direct-send fixture before every test, so
 * a relay case can't leak into the checks that assume direct delivery.
 */
let state: Record<string, unknown> = BASE_STATE;

vi.mock("../../../src/lib/ssh-manager", () => ({
  sshManager: {
    withExecutor: async (_serverId: string, fn: (exec: unknown) => unknown) => fn({}),
  },
}));

vi.mock("../../../src/modules/mail/mail-state", () => ({
  readState: async () => state,
}));

import { scanDns } from "../../../src/modules/mail/admin/dns-scan.service";

beforeEach(() => {
  state = BASE_STATE;
});

describe("scanDns SPF checks", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Name-aware default so the DMARC check (now part of the fixture state)
    // sees a valid record; individual tests override with their own TXT sets.
    dns.resolveTxt.mockImplementation(async (name: string) =>
      name === "_dmarc.example.com" ? [["v=DMARC1; p=reject"]] : [["v=spf1 mx -all"]],
    );
  });

  test("fails when no SPF record exists", async () => {
    dns.resolveTxt.mockResolvedValue([["google-site-verification=abc"]]);

    const result = await scanDns("srv_test");

    expect(result.checks).toContainEqual(
      expect.objectContaining({
        key: "spf",
        status: "fail",
      }),
    );
  });

  test("passes when the single SPF record authorizes mx", async () => {
    dns.resolveTxt.mockResolvedValue([["v=spf1 mx -all"]]);

    const result = await scanDns("srv_test");

    expect(result.checks).toContainEqual(
      expect.objectContaining({
        key: "spf",
        status: "pass",
      }),
    );
  });

  test("warns when the single SPF record does not authorize mx", async () => {
    dns.resolveTxt.mockResolvedValue([["v=spf1 include:example.net -all"]]);

    const result = await scanDns("srv_test");

    expect(result.checks).toContainEqual(
      expect.objectContaining({
        key: "spf",
        status: "warn",
      }),
    );
  });

  test("fails when a domain publishes multiple SPF records", async () => {
    dns.resolveTxt.mockResolvedValue([["v=spf1 mx -all"], ["v=spf1 include:example.net -all"]]);

    const result = await scanDns("srv_test");

    expect(result.checks).toContainEqual(
      expect.objectContaining({
        key: "spf",
        status: "fail",
      }),
    );
    expect(result.checks.find((c) => c.key === "spf")?.message).toMatch(/multiple SPF records/i);
  });

  test("fails when duplicate SPF records differ only by casing", async () => {
    dns.resolveTxt.mockResolvedValue([
      ["V=SPF1 mx -all"],
      ["v=spf1 include:example.net -all"],
      ["v=spf1 ip4:203.0.113.10 -all"],
    ]);

    const result = await scanDns("srv_test");

    expect(result.checks).toContainEqual(
      expect.objectContaining({
        key: "spf",
        status: "fail",
      }),
    );
    expect(result.checks.find((c) => c.key === "spf")?.message).toMatch(/multiple SPF records/i);
  });
});

describe("scanDns DMARC checks", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dns.resolveTxt.mockImplementation(async (name: string) =>
      name === "_dmarc.example.com"
        ? [["google-site-verification=abc"], ["v=DMARC1; p=reject"]]
        : [["v=spf1 mx -all"]],
    );
  });

  test("passes when exactly one DMARC policy record is published among other TXT records", async () => {
    const result = await scanDns("srv_test");

    expect(result.checks).toContainEqual(
      expect.objectContaining({
        key: "dmarc",
        status: "pass",
      }),
    );
  });

  test("fails when multiple DMARC policy records are published", async () => {
    dns.resolveTxt.mockImplementation(async (name: string) =>
      name === "_dmarc.example.com"
        ? [["v=DMARC1; p=reject"], ["V=DMARC1; p=none"]]
        : [["v=spf1 mx -all"]],
    );

    const result = await scanDns("srv_test");
    const dmarc = result.checks.find((check) => check.key === "dmarc");

    expect(dmarc).toEqual(
      expect.objectContaining({
        status: "fail",
        actual: "v=DMARC1; p=reject | V=DMARC1; p=none",
      }),
    );
    expect(dmarc?.message).toMatch(/multiple DMARC records/i);
  });

  test("fails when a second policy record uses permitted whitespace around =", async () => {
    dns.resolveTxt.mockImplementation(async (name: string) =>
      name === "_dmarc.example.com"
        ? [["v=DMARC1; p=reject"], ["v = DMARC1; p=none"]]
        : [["v=spf1 mx -all"]],
    );

    const result = await scanDns("srv_test");
    const dmarc = result.checks.find((check) => check.key === "dmarc");

    expect(dmarc?.status).toBe("fail");
    expect(dmarc?.actual).toBe("v=DMARC1; p=reject | v = DMARC1; p=none");
  });

  test("passes when a second TXT record uses a lowercase dmarc1 version value", async () => {
    dns.resolveTxt.mockImplementation(async (name: string) =>
      name === "_dmarc.example.com"
        ? [["v=DMARC1; p=reject"], ["v=dmarc1; p=none"]]
        : [["v=spf1 mx -all"]],
    );

    const result = await scanDns("srv_test");
    const dmarc = result.checks.find((check) => check.key === "dmarc");

    expect(dmarc).toEqual(
      expect.objectContaining({
        status: "pass",
        actual: "v=DMARC1; p=reject",
      }),
    );
  });

  test("passes when lookalike records do not terminate the version tag", async () => {
    dns.resolveTxt.mockImplementation(async (name: string) =>
      name === "_dmarc.example.com"
        ? [["v=DMARC1; p=reject"], ["v=DMARC10; p=none"], ["v=DMARC1-legacy; p=none"]]
        : [["v=spf1 mx -all"]],
    );

    const result = await scanDns("srv_test");
    const dmarc = result.checks.find((check) => check.key === "dmarc");

    expect(dmarc?.status).toBe("pass");
    expect(dmarc?.actual).toBe("v=DMARC1; p=reject");
  });
});

describe("DKIM key comparison", () => {
  const expected = `v=DKIM1;p=${"A".repeat(300)}`;
  const dkimOf = async () =>
    (await scanDns("srv_test")).checks.find((c) => c.key === "dkim");

  beforeEach(() => {
    dns.resolve4.mockRejectedValue(Object.assign(new Error("x"), { code: "ENOTFOUND" }));
    dns.resolve6.mockRejectedValue(Object.assign(new Error("x"), { code: "ENOTFOUND" }));
    dns.resolveMx.mockRejectedValue(Object.assign(new Error("x"), { code: "ENOTFOUND" }));
    dns.reverse.mockRejectedValue(Object.assign(new Error("x"), { code: "ENOTFOUND" }));
  });

  test("matches a key returned as one record split into DNS strings", async () => {
    // Node's normal shape: one record, two 255-byte strings.
    dns.resolveTxt.mockResolvedValue([[expected.slice(0, 255), expected.slice(255)]]);
    expect((await dkimOf())?.status).toBe("pass");
  });

  test("matches a key the resolver splits across separate records", async () => {
    // Docker's embedded DNS shape — the case that produced a false mismatch
    // against a byte-identical published key.
    dns.resolveTxt.mockResolvedValue([[expected.slice(0, 255)], [expected.slice(255)]]);
    expect((await dkimOf())?.status).toBe("pass");
  });

  test("still flags a genuinely different key", async () => {
    dns.resolveTxt.mockResolvedValue([[`v=DKIM1;p=${"B".repeat(300)}`]]);
    expect((await dkimOf())?.status).toBe("warn");
  });
});

// ─── Outbound relay (split delivery) ────────────────────────────────────────

/**
 * The scan half of the relay feature. `applyRelayToState` decides which records we
 * RECOMMEND (covered by outbound-relay.service.test.ts); these cover whether the
 * scan can tell that the operator published them — the send hop is the half a
 * direct-send install never exercises, and every check below reads the provider
 * out of the expected value rather than naming SES, so a registry addition needs
 * no scanner change.
 */
const DKIM_CNAME = { name: "abc._domainkey.example.com", value: "abc.dkim.amazonses.com" };
const MAIL_FROM = "bounce.example.com";
const SES_MX = "feedback-smtp.us-east-1.amazonaws.com";

/** BASE_STATE with sending moved to a provider — the shape applyRelayToState writes. */
const RELAY_STATE = {
  ...BASE_STATE,
  outboundRelay: {
    enabled: true,
    provider: "ses",
    region: "us-east-1",
    host: "email-smtp.us-east-1.amazonaws.com",
    port: 587,
    username: "AKIAEXAMPLE",
    passwordEncrypted: "…",
    scope: "all",
    updatedAt: new Date(0).toISOString(),
  },
  dnsRecords: {
    ...BASE_STATE.dnsRecords,
    spf: { ...BASE_STATE.dnsRecords.spf, value: "v=spf1 mx include:amazonses.com -all" },
    extraRecords: [
      { type: "CNAME", name: DKIM_CNAME.name, value: DKIM_CNAME.value, required: true },
      { type: "MX", name: MAIL_FROM, value: SES_MX, priority: 10, required: false },
      { type: "TXT", name: MAIL_FROM, value: "v=spf1 include:amazonses.com ~all", required: false },
    ],
  },
};

const nx = () => Object.assign(new Error("nx"), { code: "ENOTFOUND" });

/** Name-keyed TXT zone; an unlisted name is NXDOMAIN, like a real resolver. */
function publishTxt(zone: Record<string, string[]>) {
  dns.resolveTxt.mockImplementation(async (name: string) => {
    const records = zone[name];
    if (!records) throw nx();
    return records.map((r) => [r]);
  });
}

const RELAY_ZONE: Record<string, string[]> = {
  "example.com": ["v=spf1 mx include:amazonses.com -all"],
  "_dmarc.example.com": ["v=DMARC1; p=reject"],
  "dkim._domainkey.example.com": [`v=DKIM1;p=${"A".repeat(300)}`],
  [MAIL_FROM]: ["v=spf1 include:amazonses.com ~all"],
};

/** The one check of a given record type — extras are keyed by array index. */
const checkFor = (checks: Awaited<ReturnType<typeof scanDns>>["checks"], type: string, name: string) =>
  checks.find((c) => c.recordType === type && c.queriedName === name);

describe("scanDns — outbound relay send-hop", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state = RELAY_STATE;
    publishTxt(RELAY_ZONE);
    dns.resolveCname.mockResolvedValue([DKIM_CNAME.value]);
    dns.resolveMx.mockResolvedValue([{ exchange: SES_MX, priority: 10 }]);
    dns.resolve4.mockRejectedValue(nx());
    dns.resolve6.mockRejectedValue(nx());
    dns.reverse.mockRejectedValue(nx());
  });

  test("FAILS SPF when the provider's include isn't published", async () => {
    // Every relayed message fails SPF in this state — that is not a warning.
    publishTxt({ ...RELAY_ZONE, "example.com": ["v=spf1 mx -all"] });

    const spf = (await scanDns("srv_test")).checks.find((c) => c.key === "spf");

    expect(spf?.status).toBe("fail");
    expect(spf?.message).toContain("include:amazonses.com");
  });

  test("warns when the include is published but `mx` was dropped", async () => {
    // A relay include does not retire `mx`: whatever the relay isn't scoped to
    // still leaves this server directly, and `mx` is what authorises it.
    publishTxt({ ...RELAY_ZONE, "example.com": ["v=spf1 include:amazonses.com -all"] });

    const spf = (await scanDns("srv_test")).checks.find((c) => c.key === "spf");

    expect(spf?.status).toBe("warn");
    expect(spf?.message).toMatch(/directly/i);
  });

  test("passes SPF when both this server and the relay are authorised", async () => {
    const spf = (await scanDns("srv_test")).checks.find((c) => c.key === "spf");

    expect(spf?.status).toBe("pass");
    expect(spf?.message).toContain("include:amazonses.com");
  });

  test("verifies the provider's DKIM CNAME", async () => {
    const cname = checkFor((await scanDns("srv_test")).checks, "CNAME", DKIM_CNAME.name);

    expect(cname?.status).toBe("pass");
    expect(dns.resolveCname).toHaveBeenCalledWith(DKIM_CNAME.name);
  });

  test("warns when the DKIM CNAME points at a different target", async () => {
    dns.resolveCname.mockResolvedValue(["someone-elses.dkim.amazonses.com"]);

    const cname = checkFor((await scanDns("srv_test")).checks, "CNAME", DKIM_CNAME.name);

    expect(cname?.status).toBe("warn");
  });

  test("fails when a required DKIM CNAME isn't published at all", async () => {
    dns.resolveCname.mockRejectedValue(nx());

    const cname = checkFor((await scanDns("srv_test")).checks, "CNAME", DKIM_CNAME.name);

    expect(cname?.status).toBe("fail");
  });

  test("only warns for MAIL FROM records — they're recommended, not required", async () => {
    dns.resolveMx.mockRejectedValue(nx());
    publishTxt({ ...RELAY_ZONE, [MAIL_FROM]: undefined as unknown as string[] });

    const { checks } = await scanDns("srv_test");

    expect(checkFor(checks, "MX", MAIL_FROM)?.status).toBe("warn");
    expect(checkFor(checks, "TXT", MAIL_FROM)?.status).toBe("warn");
  });

  test("accepts a MAIL FROM SPF whose mechanisms were reordered", async () => {
    publishTxt({ ...RELAY_ZONE, [MAIL_FROM]: ["v=spf1 a include:amazonses.com ~all"] });

    expect(checkFor((await scanDns("srv_test")).checks, "TXT", MAIL_FROM)?.status).toBe("pass");
  });

  test("FAILS a relayed domain whose SPF only authorises this server", async () => {
    // Resend / Oracle / custom smarthosts have no include we can derive, so we
    // publish none — and `mx` doesn't cover the host that connects to the receiver.
    // Without this the scan reports "all good" on mail that fails SPF every time.
    state = {
      ...RELAY_STATE,
      outboundRelay: { ...RELAY_STATE.outboundRelay, provider: "resend", region: undefined },
      dnsRecords: { ...BASE_STATE.dnsRecords },
    };
    publishTxt({ ...RELAY_ZONE, "example.com": ["v=spf1 mx -all"] });

    const spf = (await scanDns("srv_test")).checks.find((c) => c.key === "spf");

    expect(spf?.status).toBe("fail");
    expect(spf?.message).toMatch(/relayed message fails SPF/i);
  });

  test("stays quiet when the operator authorised the relay their own way", async () => {
    // A hand-added ip4: for the smarthost is a valid authorisation we can't verify -
    // better silent than a warning the operator has no way to clear.
    state = {
      ...RELAY_STATE,
      outboundRelay: { ...RELAY_STATE.outboundRelay, provider: "custom", region: undefined },
      dnsRecords: { ...BASE_STATE.dnsRecords },
    };
    publishTxt({ ...RELAY_ZONE, "example.com": ["v=spf1 mx ip4:198.51.100.7 -all"] });

    expect((await scanDns("srv_test")).checks.find((c) => c.key === "spf")?.status).toBe("pass");
  });

  test("doesn't fail an include-less domain the relay doesn't route", async () => {
    // scope=selected covering only other.com: example.com still sends direct, so
    // `mx` is the whole correct answer for it.
    state = {
      ...RELAY_STATE,
      outboundRelay: {
        ...RELAY_STATE.outboundRelay,
        provider: "custom",
        region: undefined,
        scope: "selected",
        domains: ["other.com"],
      },
      dnsRecords: { ...BASE_STATE.dnsRecords },
    };
    publishTxt({ ...RELAY_ZONE, "example.com": ["v=spf1 mx -all"] });

    expect((await scanDns("srv_test")).checks.find((c) => c.key === "spf")?.status).toBe("pass");
  });

  test("fails an include-less domain relayed for a SINGLE address", async () => {
    // SPF is published per domain, so relaying one mailbox needs the whole domain's
    // record to authorise the provider — relayedDomainsFor() is what knows that.
    state = {
      ...RELAY_STATE,
      outboundRelay: {
        ...RELAY_STATE.outboundRelay,
        provider: "custom",
        region: undefined,
        scope: "selected",
        addresses: ["contact@example.com"],
      },
      dnsRecords: { ...BASE_STATE.dnsRecords },
    };
    publishTxt({ ...RELAY_ZONE, "example.com": ["v=spf1 mx -all"] });

    expect((await scanDns("srv_test")).checks.find((c) => c.key === "spf")?.status).toBe("fail");
  });

  test("verifies an ADDITIONAL domain's own provider identity", async () => {
    // Providers verify each domain separately, so every relayed domain carries its
    // own CNAMEs — scanning only the primary would miss them.
    const other = "other.com";
    state = {
      ...RELAY_STATE,
      additionalDomains: {
        [other]: {
          acknowledgedAt: new Date(0).toISOString(),
          createdAt: new Date(0).toISOString(),
          records: {
            mx: { type: "MX", name: other, priority: 10, value: "mail.example.com", required: true },
            spf: { type: "TXT", name: other, value: "v=spf1 mx include:amazonses.com -all", required: true },
            dmarc: { type: "TXT", name: `_dmarc.${other}`, value: "v=DMARC1; p=quarantine", required: true },
            extraRecords: [
              { type: "CNAME", name: `xyz._domainkey.${other}`, value: "xyz.dkim.amazonses.com", required: true },
            ],
          },
        },
      },
    };
    publishTxt({
      [other]: ["v=spf1 mx include:amazonses.com -all"],
      [`_dmarc.${other}`]: ["v=DMARC1; p=quarantine"],
    });
    dns.resolveCname.mockResolvedValue(["xyz.dkim.amazonses.com"]);
    dns.resolveMx.mockResolvedValue([{ exchange: "mail.example.com", priority: 10 }]);

    const { checks } = await scanDns("srv_test", other);

    expect(checkFor(checks, "CNAME", `xyz._domainkey.${other}`)?.status).toBe("pass");
    expect(checks.find((c) => c.key === "spf")?.status).toBe("pass");
  });
});

describe("scanDns PTR under a relay", () => {
  const withA = (base: Record<string, unknown>) => ({
    ...base,
    dnsRecords: {
      ...(base.dnsRecords as Record<string, unknown>),
      a: { type: "A", name: "mail.example.com", value: "203.0.113.10", required: true },
    },
  });

  beforeEach(() => {
    vi.clearAllMocks();
    publishTxt(RELAY_ZONE);
    dns.resolveCname.mockResolvedValue([DKIM_CNAME.value]);
    dns.resolveMx.mockResolvedValue([{ exchange: SES_MX, priority: 10 }]);
    dns.resolve4.mockResolvedValue(["203.0.113.10"]);
    dns.resolve6.mockRejectedValue(nx());
    dns.reverse.mockRejectedValue(nx());
  });

  test("fails a missing PTR on a direct-sending box", async () => {
    state = withA(BASE_STATE);

    expect((await scanDns("srv_test")).checks.find((c) => c.key === "ptr")?.status).toBe("fail");
  });

  test("only warns when ALL outbound goes through the relay", async () => {
    // The blocklisted-IP / blocked-:25 box is exactly why the relay exists —
    // receivers never see a connection from this IP, so its PTR can't cost a
    // delivery and a red row would bury the rows that do matter.
    state = withA(RELAY_STATE);

    const ptr = (await scanDns("srv_test")).checks.find((c) => c.key === "ptr");

    expect(ptr?.status).toBe("warn");
    expect(ptr?.message).toMatch(/relay/i);
  });

  test("still fails when only SELECTED senders relay — direct delivery is alive", async () => {
    state = withA({
      ...RELAY_STATE,
      outboundRelay: { ...RELAY_STATE.outboundRelay, scope: "selected", domains: ["example.com"] },
    });

    expect((await scanDns("srv_test")).checks.find((c) => c.key === "ptr")?.status).toBe("fail");
  });
});

describe("resolver selection", () => {
  test("scans public resolvers, not the host's stub", async () => {
    // The mail host's /etc/hosts carries `127.0.1.1 mail.<domain>` (written by
    // the hostname step), which the system stub would synthesize into an A
    // record and report as a mismatch on correct DNS.
    //
    // setServers runs once at module load, so re-import on a fresh registry
    // rather than depending on a spy the other suites' clearAllMocks wiped.
    vi.resetModules();
    dns.setServers.mockClear();
    await import("../../../src/modules/mail/admin/dns-scan.service");

    expect(dns.setServers).toHaveBeenCalledWith(expect.arrayContaining(["1.1.1.1"]));
  });
});
