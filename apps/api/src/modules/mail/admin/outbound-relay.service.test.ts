import { describe, expect, test, vi, beforeEach } from "vitest";

// Stub the state I/O (readState/mutateState) so the test isolates the service's
// command construction + DNS patching from the on-VPS JSON plumbing. The
// mutator is applied to an in-memory fake so we can assert the persisted shape.
let fakeState: Record<string, unknown>;
vi.mock("../mail-state", () => ({
  readState: vi.fn(async () => fakeState),
  mutateState: vi.fn(
    async (_exec: unknown, _serverId: string, mutator: (s: Record<string, unknown>) => Record<string, unknown>) => {
      fakeState = mutator(fakeState);
      return fakeState;
    },
  ),
}));
// Deterministic, env-free encryption stub.
vi.mock("../../../lib/encryption", () => ({
  encrypt: (s: string) => `enc(${s})`,
  decrypt: (s: string) => s.replace(/^enc\(|\)$/g, ""),
}));
// Mock psql-runner: (a) its real transitive imports (ssh-manager/env) throw in
// tests, (b) capturing the SQL lets us assert sender_relayhost routing directly.
const pg = vi.hoisted(() => ({ sqlCalls: [] as string[] }));
vi.mock("./psql-runner", () => ({
  execute: async (_exec: unknown, sql: string) => {
    pg.sqlCalls.push(sql);
    return "";
  },
  q: (v: string) => `'${v.replace(/'/g, "''")}'`,
}));

import {
  configureOutboundRelay,
  disableOutboundRelay,
  applyRelayToState,
  withSesInclude,
  withoutSesInclude,
} from "./outbound-relay.service";

function makeExec() {
  const execCalls: string[] = [];
  const writes: { path: string; content: string }[] = [];
  const exec = {
    exec: async (cmd: string) => {
      execCalls.push(cmd);
      return "";
    },
    writeFile: async (path: string, content: string) => {
      writes.push({ path, content });
    },
  };
  return { exec: exec as never, execCalls, writes };
}

beforeEach(() => {
  pg.sqlCalls.length = 0;
  fakeState = {
    serverId: "srv1",
    domain: "example.com",
    dnsRecords: { spf: { type: "TXT", name: "example.com", value: "v=spf1 mx -all" } },
  };
});

describe("configureOutboundRelay", () => {
  const base = { provider: "ses" as const, region: "us-east-1", port: 587, username: "AKIASMTPUSER", password: "s3cr3tPass" };

  test("writes creds via SFTP writeFile, NEVER through a shell command", async () => {
    const { exec, execCalls, writes } = makeExec();
    await configureOutboundRelay(exec, base);

    expect(writes[0].path).toBe("/etc/postfix/sasl_passwd");
    expect(writes[0].content).toContain("[email-smtp.us-east-1.amazonaws.com]:587 AKIASMTPUSER:s3cr3tPass");

    // SECURITY INVARIANT: no shell command may contain the password or username.
    for (const cmd of execCalls) {
      expect(cmd).not.toContain("s3cr3tPass");
      expect(cmd).not.toContain("AKIASMTPUSER");
    }
  });

  test("emits postmap + postconf relay directives + reload", async () => {
    const { exec, execCalls } = makeExec();
    await configureOutboundRelay(exec, base);
    const joined = execCalls.join("\n");
    expect(joined).toContain("postmap /etc/postfix/sasl_passwd");
    expect(joined).toContain("postconf -e");
    expect(joined).toContain("relayhost=[email-smtp.us-east-1.amazonaws.com]:587");
    expect(joined).toContain("smtp_sasl_auth_enable=yes");
    expect(joined).toContain("smtp_sasl_password_maps=hash:/etc/postfix/sasl_passwd");
    expect(joined).toMatch(/reload postfix|postfix reload/);
  });

  test("persists an ENCRYPTED password + patches SPF include", async () => {
    const { exec } = makeExec();
    await configureOutboundRelay(exec, base);
    const relay = (fakeState as { outboundRelay: Record<string, unknown> }).outboundRelay;
    expect(relay.enabled).toBe(true);
    expect(relay.passwordEncrypted).toBe("enc(s3cr3tPass)");
    expect(relay).not.toHaveProperty("password"); // plaintext never persisted
    const dns = (fakeState as { dnsRecords: { spf: { value: string } } }).dnsRecords;
    expect(dns.spf.value).toContain("include:amazonses.com");
  });

  test("adds SES DKIM CNAMEs + MAIL FROM records when provided", async () => {
    const { exec } = makeExec();
    await configureOutboundRelay(exec, {
      ...base,
      mailFromDomain: "bounce.example.com",
      sesDkim: [{ name: "abc._domainkey.example.com", value: "abc.dkim.amazonses.com" }],
    });
    const extras = (fakeState as { dnsRecords: { extraRecords: { type: string; name: string }[] } }).dnsRecords.extraRecords;
    expect(extras).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "CNAME", name: "abc._domainkey.example.com" }),
        expect.objectContaining({ type: "MX", name: "bounce.example.com" }),
        expect.objectContaining({ type: "TXT", name: "bounce.example.com" }),
      ]),
    );
  });

  test("derives the SES host from the region", async () => {
    const { exec, writes } = makeExec();
    await configureOutboundRelay(exec, { ...base, region: "eu-west-1" });
    expect(writes[0].content).toContain("[email-smtp.eu-west-1.amazonaws.com]:587");
  });

  test("rejects bad port / colon-in-username / newline-in-password / missing region", async () => {
    await expect(configureOutboundRelay(makeExec().exec, { ...base, port: 0 })).rejects.toThrow();
    await expect(configureOutboundRelay(makeExec().exec, { ...base, username: "bad:user" })).rejects.toThrow();
    await expect(configureOutboundRelay(makeExec().exec, { ...base, password: "line1\nline2" })).rejects.toThrow();
    await expect(
      configureOutboundRelay(makeExec().exec, { provider: "ses", port: 587, username: "u", password: "p" }),
    ).rejects.toThrow();
  });
});

describe("disableOutboundRelay", () => {
  test("removes directives + sasl files, clears state + reverts DNS", async () => {
    fakeState = {
      serverId: "srv1",
      domain: "example.com",
      outboundRelay: { enabled: true, provider: "ses", host: "email-smtp.us-east-1.amazonaws.com", port: 587 },
      dnsRecords: {
        spf: { type: "TXT", name: "example.com", value: "v=spf1 mx include:amazonses.com -all" },
        extraRecords: [{ type: "CNAME", name: "abc._domainkey.example.com", value: "abc.dkim.amazonses.com" }],
      },
    };
    const { exec, execCalls } = makeExec();
    await disableOutboundRelay(exec);
    const joined = execCalls.join("\n");
    expect(joined).toContain("postconf -X relayhost");
    expect(joined).toContain("rm -f /etc/postfix/sasl_passwd");
    expect(joined).toMatch(/reload postfix|postfix reload/);
    expect((fakeState as { outboundRelay?: unknown }).outboundRelay).toBeUndefined();
    const dns = (fakeState as { dnsRecords: { spf: { value: string }; extraRecords?: unknown } }).dnsRecords;
    expect(dns.spf.value).not.toContain("amazonses.com");
    expect(dns.extraRecords).toBeUndefined();
  });
});

describe("SPF include helpers", () => {
  test("withSesInclude inserts before the all qualifier + is idempotent", () => {
    expect(withSesInclude("v=spf1 mx -all")).toBe("v=spf1 mx include:amazonses.com -all");
    expect(withSesInclude("v=spf1 mx ip4:1.2.3.4 ~all")).toBe("v=spf1 mx ip4:1.2.3.4 include:amazonses.com ~all");
    expect(withSesInclude("v=spf1 mx include:amazonses.com -all")).toBe("v=spf1 mx include:amazonses.com -all");
  });
  test("withoutSesInclude strips the token", () => {
    expect(withoutSesInclude("v=spf1 mx include:amazonses.com -all")).toBe("v=spf1 mx -all");
    expect(withoutSesInclude("v=spf1 mx -all")).toBe("v=spf1 mx -all");
  });
});

describe("per-domain routing (enterprise)", () => {
  const base = { provider: "ses" as const, region: "us-east-1", port: 587, username: "u", password: "p" };

  test("scope=all sets a global relayhost and writes no sender rows", async () => {
    const { exec, execCalls } = makeExec();
    await configureOutboundRelay(exec, { ...base, scope: "all" });
    expect(execCalls.join("\n")).toContain("relayhost=[email-smtp.us-east-1.amazonaws.com]:587");
    // Only a DELETE (clearing stale rows) — never an INSERT — in "all" mode.
    expect(pg.sqlCalls.some((s) => /INSERT INTO sender_relayhost/i.test(s))).toBe(false);
  });

  test("scope=selected clears the global relayhost + routes chosen domains via sender_relayhost", async () => {
    // Two domains on the server; only x.com should relay.
    fakeState = {
      serverId: "srv1",
      domain: "x.com",
      dnsRecords: { spf: { type: "TXT", name: "x.com", value: "v=spf1 mx -all" } },
      additionalDomains: {
        "y.com": { records: { spf: { type: "TXT", name: "y.com", value: "v=spf1 mx -all" }, mx: {}, dmarc: {} }, acknowledgedAt: null, createdAt: "" },
      },
    };
    const { exec, execCalls } = makeExec();
    await configureOutboundRelay(exec, { ...base, scope: "selected", domains: ["x.com"] });

    // Global relayhost cleared, not set.
    expect(execCalls.join("\n")).toContain("postconf -X relayhost");
    expect(execCalls.join("\n")).not.toContain("relayhost=[email-smtp");
    // Per-sender row for @x.com → the SES nexthop.
    const inserts = pg.sqlCalls.filter((s) => /INSERT INTO sender_relayhost/i.test(s));
    expect(inserts.length).toBe(1);
    expect(inserts[0]).toContain("'@x.com'");
    expect(inserts[0]).toContain("'[email-smtp.us-east-1.amazonaws.com]:587'");

    // DNS fan-out: x.com gets the SES include; y.com stays clean.
    const s = fakeState as {
      dnsRecords: { spf: { value: string } };
      additionalDomains: Record<string, { records: { spf: { value: string } } }>;
    };
    expect(s.dnsRecords.spf.value).toContain("include:amazonses.com");
    expect(s.additionalDomains["y.com"].records.spf.value).not.toContain("amazonses.com");
  });

  test("per-domain SES identity records land on that domain only", async () => {
    fakeState = {
      serverId: "srv1",
      domain: "x.com",
      dnsRecords: { spf: { type: "TXT", name: "x.com", value: "v=spf1 mx -all" } },
      additionalDomains: {
        "y.com": { records: { spf: { type: "TXT", name: "y.com", value: "v=spf1 mx -all" }, mx: {}, dmarc: {} }, acknowledgedAt: null, createdAt: "" },
      },
    };
    const { exec } = makeExec();
    await configureOutboundRelay(exec, {
      ...base,
      scope: "selected",
      domains: ["x.com", "y.com"],
      identities: {
        "y.com": { sesDkim: [{ name: "yk._domainkey.y.com", value: "yk.dkim.amazonses.com" }] },
      },
    });
    const s = fakeState as { additionalDomains: Record<string, { records: { extraRecords?: { name: string }[] } }> };
    expect(s.additionalDomains["y.com"].records.extraRecords).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "yk._domainkey.y.com" })]),
    );
  });

  test("disable removes the sender rows and reverts DNS on every domain", async () => {
    fakeState = {
      serverId: "srv1",
      domain: "x.com",
      outboundRelay: { enabled: true, provider: "ses", host: "email-smtp.us-east-1.amazonaws.com", port: 587 },
      dnsRecords: { spf: { type: "TXT", name: "x.com", value: "v=spf1 mx include:amazonses.com -all" } },
      additionalDomains: {
        "y.com": { records: { spf: { type: "TXT", name: "y.com", value: "v=spf1 mx include:amazonses.com -all" }, extraRecords: [{ type: "CNAME", name: "yk._domainkey.y.com", value: "x" }], mx: {}, dmarc: {} }, acknowledgedAt: null, createdAt: "" },
      },
    };
    const { exec } = makeExec();
    await disableOutboundRelay(exec);
    expect(pg.sqlCalls.some((s) => /DELETE FROM sender_relayhost/i.test(s))).toBe(true);
    const s = fakeState as {
      additionalDomains: Record<string, { records: { spf: { value: string }; extraRecords?: unknown } }>;
    };
    expect(s.additionalDomains["y.com"].records.spf.value).not.toContain("amazonses.com");
    expect(s.additionalDomains["y.com"].records.extraRecords).toBeUndefined();
  });
});

// The core of the "SES DNS survives a DKIM re-run / re-install" fix: the DKIM
// step rebuilds dnsRecords SELF-HOST-ONLY, and applyRelayToState must re-lay the
// stored relay's SES send-hop records back on. Pure function → no exec/state I/O.
describe("applyRelayToState (SES-DNS survival)", () => {
  const relay = {
    enabled: true,
    provider: "ses" as const,
    region: "us-east-1",
    host: "email-smtp.us-east-1.amazonaws.com",
    port: 587,
    username: "u",
    passwordEncrypted: "enc(p)",
    scope: "all" as const,
    mailFromDomain: "bounce.example.com",
    sesDkim: [{ name: "abc._domainkey.example.com", value: "abc.dkim.amazonses.com" }],
    updatedAt: "",
  };

  test("re-lays the SES include + extras onto a freshly-rebuilt (self-host-only) record set", () => {
    // Exactly what stepDkimKeys writes: SPF without the include, no extraRecords.
    const rebuilt = {
      serverId: "srv1",
      domain: "example.com",
      dnsRecords: { spf: { type: "TXT", name: "example.com", value: "v=spf1 mx -all" } },
    };
    const { dnsRecords } = applyRelayToState(rebuilt as never, relay as never);
    const dns = dnsRecords as unknown as { spf: { value: string }; extraRecords: { name: string }[] };
    expect(dns.spf.value).toContain("include:amazonses.com");
    expect(dns.extraRecords).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "abc._domainkey.example.com" })]),
    );
  });

  test("is idempotent — re-applying does not double the include", () => {
    const st = {
      serverId: "srv1",
      domain: "example.com",
      dnsRecords: { spf: { type: "TXT", name: "example.com", value: "v=spf1 mx -all" } },
    };
    const once = applyRelayToState(st as never, relay as never);
    const twice = applyRelayToState({ ...st, ...once } as never, relay as never);
    const v = (twice.dnsRecords as unknown as { spf: { value: string } }).spf.value;
    expect(v.match(/include:amazonses\.com/g)?.length).toBe(1);
  });

  test("scope=all fans the include across additional domains", () => {
    const st = {
      serverId: "srv1",
      domain: "x.com",
      dnsRecords: { spf: { type: "TXT", name: "x.com", value: "v=spf1 mx -all" } },
      additionalDomains: {
        "y.com": { records: { spf: { type: "TXT", name: "y.com", value: "v=spf1 mx -all" } }, acknowledgedAt: null, createdAt: "" },
      },
    };
    const out = applyRelayToState(st as never, { ...relay, sesDkim: undefined, mailFromDomain: undefined } as never);
    const add = out.additionalDomains as unknown as Record<string, { records: { spf: { value: string } } }>;
    expect(add["y.com"].records.spf.value).toContain("include:amazonses.com");
  });

  test("scope=selected touches only the selected domains", () => {
    const st = {
      serverId: "srv1",
      domain: "x.com",
      dnsRecords: { spf: { type: "TXT", name: "x.com", value: "v=spf1 mx -all" } },
      additionalDomains: {
        "y.com": { records: { spf: { type: "TXT", name: "y.com", value: "v=spf1 mx -all" } }, acknowledgedAt: null, createdAt: "" },
      },
    };
    const out = applyRelayToState(
      st as never,
      { ...relay, scope: "selected", domains: ["x.com"], sesDkim: undefined, mailFromDomain: undefined } as never,
    );
    const dns = out.dnsRecords as unknown as { spf: { value: string } };
    const add = out.additionalDomains as unknown as Record<string, { records: { spf: { value: string } } }>;
    expect(dns.spf.value).toContain("include:amazonses.com");
    expect(add["y.com"].records.spf.value).not.toContain("amazonses.com");
  });
});
