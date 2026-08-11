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

const state = {
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

vi.mock("../../../src/lib/ssh-manager", () => ({
  sshManager: {
    withExecutor: async (_serverId: string, fn: (exec: unknown) => unknown) => fn({}),
  },
}));

vi.mock("../../../src/modules/mail/mail-state", () => ({
  readState: async () => state,
}));

import { scanDns } from "../../../src/modules/mail/admin/dns-scan.service";

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
