import { describe, expect, test, vi, beforeEach } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Repo root, found by marker so moving this file cannot silently no-op a check. */
function repoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 12; i++) {
    if (existsSync(join(dir, "apps", "email", "engine"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error("repo root not found - fix the marker walk in this test");
}

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
  relaySpfInclude,
  withSpfInclude,
  withoutSpfInclude,
} from "./outbound-relay.service";

type Flavor = "container" | "host";

/**
 * Where the SASL map lives on each topology — the contract `mailConfigFile`
 * encodes. Spelled out literally (not imported) because `write` names a path with
 * LIVE relay credentials under it on every containerized box: if that constant
 * moves, this test should fail and make someone decide, not follow along.
 */
const SASL_MAP: Record<Flavor, { write: string; engine: string }> = {
  container: {
    write: "/var/lib/openship/mail/config/postfix/sasl_passwd",
    engine: "/etc/postfix/sasl_passwd",
  },
  host: { write: "/etc/postfix/sasl_passwd", engine: "/etc/postfix/sasl_passwd" },
};

/** Same pair for the per-nexthop TLS policy map (selected scope only). */
const TLS_MAP: Record<Flavor, { write: string; engine: string }> = {
  container: {
    write: "/var/lib/openship/mail/config/postfix/openship_tls_policy",
    engine: "/etc/postfix/openship_tls_policy",
  },
  host: { write: "/etc/postfix/openship_tls_policy", engine: "/etc/postfix/openship_tls_policy" },
};

const HOST_UNITS_ACTIVE = [
  "## postfix",
  "LoadState=loaded",
  "ActiveState=active",
  "## dovecot",
  "LoadState=loaded",
  "ActiveState=active",
].join("\n");

/**
 * Fake executor that ALSO answers the mail-topology probe, so these tests drive the
 * real `detectMailEngine` → flavor → command-shape path instead of stubbing it:
 *   - `container` → the engine container inspects as running,
 *   - `host`      → no container, legacy systemd postfix + dovecot both active.
 *
 * Probe commands are answered but kept out of `execCalls`, which therefore holds
 * only the commands the SERVICE issued.
 */
function makeExec(flavor: Flavor | "none" = "container") {
  const execCalls: string[] = [];
  const writes: { path: string; content: string }[] = [];
  const exec = {
    exec: async (cmd: string) => {
      if (cmd.includes("docker inspect")) {
        return flavor === "container" ? "true\topenship/mail:test" : "";
      }
      if (cmd.includes("systemctl show")) {
        return flavor === "host" ? HOST_UNITS_ACTIVE : "";
      }
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

  for (const flavor of ["container", "host"] as Flavor[]) {
    test(`[${flavor}] writes creds via SFTP writeFile, NEVER through a shell command`, async () => {
      const { exec, execCalls, writes } = makeExec(flavor);
      await configureOutboundRelay(exec, base);

      expect(writes[0].path).toBe(SASL_MAP[flavor].write);
      expect(writes[0].content).toContain("[email-smtp.us-east-1.amazonaws.com]:587 AKIASMTPUSER:s3cr3tPass");

      // SECURITY INVARIANT: no shell command may contain the password or username.
      for (const cmd of execCalls) {
        expect(cmd).not.toContain("s3cr3tPass");
        expect(cmd).not.toContain("AKIASMTPUSER");
      }
    });

    test(`[${flavor}] emits postmap + postconf relay directives + reload`, async () => {
      const { exec, execCalls } = makeExec(flavor);
      await configureOutboundRelay(exec, base);
      const joined = execCalls.join("\n");
      // Postfix reads (and postmap must hash) the path the ENGINE sees.
      expect(joined).toContain(`postmap ${SASL_MAP[flavor].engine}`);
      expect(joined).toContain("postconf -e");
      expect(joined).toContain("relayhost=[email-smtp.us-east-1.amazonaws.com]:587");
      expect(joined).toContain("smtp_sasl_auth_enable=yes");
      expect(joined).toContain(`smtp_sasl_password_maps=hash:${SASL_MAP[flavor].engine}`);
      expect(joined).toMatch(/reload postfix|postfix reload/);
      // chmod targets the path we WROTE (the host side of the bind mount).
      expect(joined).toContain(`chmod 600 ${SASL_MAP[flavor].write}`);
    });

    test(`[${flavor}] runs Postfix commands where that flavor's Postfix lives`, async () => {
      const { exec, execCalls } = makeExec(flavor);
      await configureOutboundRelay(exec, base);
      const postfixCmds = execCalls.filter((c) => /postmap|postconf|postfix reload/.test(c));
      expect(postfixCmds.length).toBeGreaterThan(0);
      for (const cmd of postfixCmds) {
        if (flavor === "container") expect(cmd).toContain("docker exec openship-mail ");
        // A legacy box has no engine container — a stray `docker exec` there is the
        // exact bug this split exists to prevent.
        else expect(cmd).not.toContain("docker exec");
      }
    });
  }

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
  test.each(["container", "host"] as Flavor[])(
    "[%s] removes directives + sasl files, clears state + reverts DNS",
    async (flavor) => {
    fakeState = {
      serverId: "srv1",
      domain: "example.com",
      outboundRelay: { enabled: true, provider: "ses", host: "email-smtp.us-east-1.amazonaws.com", port: 587 },
      dnsRecords: {
        spf: { type: "TXT", name: "example.com", value: "v=spf1 mx include:amazonses.com -all" },
        extraRecords: [{ type: "CNAME", name: "abc._domainkey.example.com", value: "abc.dkim.amazonses.com" }],
      },
    };
    const { exec, execCalls } = makeExec(flavor);
    await disableOutboundRelay(exec);
    const joined = execCalls.join("\n");
    expect(joined).toContain("postconf -X relayhost");
    expect(joined).toContain(`rm -f ${SASL_MAP[flavor].write}`);
    expect(joined).toMatch(/reload postfix|postfix reload/);
    expect((fakeState as { outboundRelay?: unknown }).outboundRelay).toBeUndefined();
    const dns = (fakeState as { dnsRecords: { spf: { value: string }; extraRecords?: unknown } }).dnsRecords;
    expect(dns.spf.value).not.toContain("amazonses.com");
    expect(dns.extraRecords).toBeUndefined();
    },
  );

  test("refuses when the box has no mail engine at all", async () => {
    // Neither a container nor host units → a typed 409, not a shell error. Nothing
    // may be executed: rm -f'ing a path on a box with no mail is not a no-op.
    const { exec, execCalls } = makeExec("none");
    await expect(disableOutboundRelay(exec)).rejects.toThrow(/no mail engine/i);
    expect(execCalls).toEqual([]);
  });
});

describe("SPF include helpers", () => {
  test("withSpfInclude inserts before the all qualifier + is idempotent", () => {
    expect(withSpfInclude("v=spf1 mx -all", "include:amazonses.com")).toBe("v=spf1 mx include:amazonses.com -all");
    expect(withSpfInclude("v=spf1 mx ip4:1.2.3.4 ~all", "include:sendgrid.net")).toBe(
      "v=spf1 mx ip4:1.2.3.4 include:sendgrid.net ~all",
    );
    expect(withSpfInclude("v=spf1 mx include:amazonses.com -all", "include:amazonses.com")).toBe(
      "v=spf1 mx include:amazonses.com -all",
    );
  });

  test("withSpfInclude is a no-op when the provider publishes no token", () => {
    // Resend/OCI have no shared include — a guessed token would go green in the
    // DNS check against a mechanism the provider never honors.
    expect(withSpfInclude("v=spf1 mx -all", undefined)).toBe("v=spf1 mx -all");
    expect(withSpfInclude("v=spf1 mx -all", "  ")).toBe("v=spf1 mx -all");
  });

  test("withoutSpfInclude always strips the legacy SES token, plus any extras", () => {
    expect(withoutSpfInclude("v=spf1 mx include:amazonses.com -all")).toBe("v=spf1 mx -all");
    expect(withoutSpfInclude("v=spf1 mx -all")).toBe("v=spf1 mx -all");
    // Provider switch: the previous include is passed in as stale and goes too.
    expect(withoutSpfInclude("v=spf1 mx include:sendgrid.net -all", "include:sendgrid.net")).toBe("v=spf1 mx -all");
    expect(
      withoutSpfInclude("v=spf1 mx include:amazonses.com include:spf.mtasv.net -all", "include:spf.mtasv.net"),
    ).toBe("v=spf1 mx -all");
  });

  test("relaySpfInclude prefers the operator's token over the registry's", () => {
    expect(relaySpfInclude({ provider: "ses" })).toBe("include:amazonses.com");
    expect(relaySpfInclude({ provider: "sendgrid" })).toBe("include:sendgrid.net");
    // No registry token for a plain SMTP relay — nothing to publish unless told.
    expect(relaySpfInclude({ provider: "custom" })).toBeUndefined();
    expect(relaySpfInclude({ provider: "custom", spfInclude: "include:relay.acme.net" })).toBe(
      "include:relay.acme.net",
    );
    expect(relaySpfInclude({ provider: "ses", spfInclude: "include:mine.example" })).toBe("include:mine.example");
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

/**
 * The `contact@example.com` case: the mailbox is hosted (IMAP) HERE, only its
 * sending goes through the operator's own SMTP provider. Everything else on the
 * same domain — and every other domain — must keep delivering direct-to-MX.
 */
describe("per-address relaying (split auth)", () => {
  const custom = {
    provider: "custom" as const,
    host: "relay.acme.net",
    port: 587,
    username: "smtp-user",
    password: "p",
  };

  test("routes ONE address without relaying the rest of its domain", async () => {
    const { exec, execCalls } = makeExec();
    await configureOutboundRelay(exec, {
      ...custom,
      scope: "selected",
      addresses: ["Contact@example.com"],
      spfInclude: "include:relay.acme.net",
    });

    // No global relayhost — the other mailboxes on example.com still go direct.
    expect(execCalls.join("\n")).toContain("postconf -X relayhost");
    expect(execCalls.join("\n")).not.toContain("relayhost=[relay.acme.net]");

    const inserts = pg.sqlCalls.filter((s) => /INSERT INTO sender_relayhost/i.test(s));
    expect(inserts.length).toBe(1);
    expect(inserts[0]).toContain("'contact@example.com'"); // case-folded map key
    expect(inserts[0]).not.toContain("'@example.com'"); // the domain did NOT opt in
    expect(inserts[0]).toContain("'[relay.acme.net]:587'");

    // The domain still has to authorize the provider or its mail fails SPF.
    const dns = (fakeState as { dnsRecords: { spf: { value: string } } }).dnsRecords;
    expect(dns.spf.value).toBe("v=spf1 mx include:relay.acme.net -all");
  });

  test("an address and its whole domain can coexist (most-specific wins in the map)", async () => {
    const { exec } = makeExec();
    await configureOutboundRelay(exec, {
      ...custom,
      scope: "selected",
      domains: ["example.com"],
      addresses: ["contact@example.com"],
    });
    const accounts = pg.sqlCalls
      .filter((s) => /INSERT INTO sender_relayhost/i.test(s))
      .map((s) => s.match(/VALUES \('([^']+)'/)?.[1]);
    expect(accounts).toEqual(["contact@example.com", "@example.com"]);
  });

  test("persists the addresses so the UI round-trips what Postfix matches", async () => {
    const { exec } = makeExec();
    await configureOutboundRelay(exec, { ...custom, scope: "selected", addresses: ["Contact@Example.com"] });
    const relay = (fakeState as { outboundRelay: Record<string, unknown> }).outboundRelay;
    expect(relay.addresses).toEqual(["contact@example.com"]);
    expect(relay.domains).toEqual([]);
    expect(relay.provider).toBe("custom");
    expect(relay.host).toBe("relay.acme.net");
  });

  test("rejects a selected-scope relay with nothing selected, and a malformed address", async () => {
    await expect(configureOutboundRelay(makeExec().exec, { ...custom, scope: "selected" })).rejects.toThrow(
      /at least one domain or sender address/i,
    );
    await expect(
      configureOutboundRelay(makeExec().exec, { ...custom, scope: "selected", addresses: ["Contact <c@x.com>"] }),
    ).rejects.toThrow(/Invalid relay sender address/i);
  });
});

/**
 * The bug this pair exists to prevent: relay-grade TLS applied GLOBALLY while a
 * direct-to-MX path is still alive. `encrypt` defers mail to any MX without
 * STARTTLS, and `wrappermode` speaks implicit TLS to every port-25 MX — so in
 * "selected" scope both must be scoped to the relay nexthop instead.
 */
describe("relay TLS is scoped to the hop, not the server", () => {
  const base = { provider: "ses" as const, region: "us-east-1", port: 587, username: "u", password: "p" };

  for (const flavor of ["container", "host"] as Flavor[]) {
    test(`[${flavor}] scope=selected keeps global TLS opportunistic + pins the nexthop`, async () => {
      const { exec, execCalls, writes } = makeExec(flavor);
      await configureOutboundRelay(exec, { ...base, scope: "selected", domains: ["example.com"] });
      const joined = execCalls.join("\n");

      expect(joined).toContain("smtp_tls_security_level=may");
      expect(joined).not.toContain("smtp_tls_security_level=encrypt");
      expect(joined).not.toContain("smtp_tls_wrappermode=yes");
      // A box that previously relayed everything via :465 has the flag set.
      expect(joined).toContain("postconf -X smtp_tls_wrappermode");

      const policy = writes.find((w) => w.path === TLS_MAP[flavor].write);
      expect(policy?.content).toBe("[email-smtp.us-east-1.amazonaws.com]:587 encrypt\n");
      expect(joined).toContain(`postmap ${TLS_MAP[flavor].engine}`);
      expect(joined).toContain(`smtp_tls_policy_maps=hash:${TLS_MAP[flavor].engine}`);
    });

    test(`[${flavor}] scope=all goes global and removes the per-nexthop policy`, async () => {
      const { exec, execCalls, writes } = makeExec(flavor);
      await configureOutboundRelay(exec, { ...base, scope: "all" });
      const joined = execCalls.join("\n");

      expect(joined).toContain("smtp_tls_security_level=encrypt");
      expect(joined).not.toContain("smtp_tls_policy_maps=hash:");
      // Stale if we came from "selected" — pins TLS for a hop that's now global.
      expect(joined).toContain("postconf -X smtp_tls_policy_maps");
      expect(joined).toContain(`rm -f ${TLS_MAP[flavor].write}`);
      expect(writes.some((w) => w.path === TLS_MAP[flavor].write)).toBe(false);
    });
  }

  /**
   * GH-392: a global `smtp_tls_security_level=encrypt` also governs the
   * Postfix→Amavis content-filter hop, because `smtp-amavis` is an smtp CLIENT
   * service. Amavisd's :10024 offers no STARTTLS, so saving a relay with the
   * DEFAULT scope took INBOUND mail down entirely — every message deferring with
   * "TLS is required, but was not offered". The exemption has to be applied in
   * both scopes: "selected" leaves the global at `may` today, but an operator may
   * have hardened it by hand, and a box built before the master.cf fix carries
   * its own copy on the /etc/postfix bind mount.
   */
  for (const scope of ["all", "selected"] as const) {
    test(`[${scope}] exempts the amavis content filter from the global TLS level`, async () => {
      const { exec, execCalls } = makeExec();
      await configureOutboundRelay(exec, {
        ...base,
        scope,
        ...(scope === "selected" ? { domains: ["example.com"] } : {}),
      });
      expect(execCalls.join("\n")).toContain(
        "postconf -P 'smtp-amavis/unix/smtp_tls_security_level=none'",
      );
    });
  }

  test("the amavis exemption is pinned at the transport for new installs", async () => {
    // The runtime repair above only reaches boxes where a relay is saved. New
    // installs must be correct from the first boot, so the override lives in the
    // transport definition too - and this asserts it sits inside the
    // `smtp-amavis` entry, not merely somewhere in the file (the two pre-existing
    // `=none` lines belong to the reinject smtpd services).
    const masterCf = readFileSync(
      join(repoRoot(), "apps/email/engine/samples/postfix/master.cf"),
      "utf-8",
    );
    const entry = masterCf.slice(
      masterCf.indexOf("smtp-amavis unix"),
      masterCf.indexOf("# smtp port used by Amavisd"),
    );
    expect(entry).toContain("-o smtp_tls_security_level=none");
  });

  test("merges into an operator's existing policy map instead of clobbering it", async () => {
    const { exec, execCalls } = makeExec();
    // Pretend the operator already pins a destination of their own.
    const inner = exec as unknown as { exec: (cmd: string) => Promise<string> };
    const real = inner.exec;
    inner.exec = async (cmd: string) => {
      const out = await real(cmd);
      return cmd.includes("postconf -h smtp_tls_policy_maps") ? "hash:/etc/postfix/operator_tls" : out;
    };
    await configureOutboundRelay(exec, { ...base, scope: "selected", domains: ["example.com"] });
    expect(execCalls.join("\n")).toContain(
      "smtp_tls_policy_maps=hash:/etc/postfix/operator_tls hash:/etc/postfix/openship_tls_policy",
    );
  });

  test("keeps their entry when the relay is disabled", async () => {
    fakeState = { serverId: "srv1", domain: "example.com", dnsRecords: {} };
    const { exec, execCalls } = makeExec();
    const inner = exec as unknown as { exec: (cmd: string) => Promise<string> };
    const real = inner.exec;
    inner.exec = async (cmd: string) => {
      const out = await real(cmd);
      return cmd.includes("postconf -h smtp_tls_policy_maps")
        ? "hash:/etc/postfix/operator_tls hash:/etc/postfix/openship_tls_policy"
        : out;
    };
    await disableOutboundRelay(exec);
    const joined = execCalls.join("\n");
    expect(joined).toContain("smtp_tls_policy_maps=hash:/etc/postfix/operator_tls");
    expect(joined).not.toContain("postconf -X smtp_tls_policy_maps");
  });

  test("rejects implicit-TLS :465 in selected scope (it can't be scoped)", async () => {
    await expect(
      configureOutboundRelay(makeExec().exec, { ...base, port: 465, scope: "selected", domains: ["example.com"] }),
    ).rejects.toThrow(/465/);
    // …but it's fine when everything relays: there's no direct path left to break.
    const { exec, execCalls } = makeExec();
    await configureOutboundRelay(exec, { ...base, port: 465, scope: "all" });
    expect(execCalls.join("\n")).toContain("smtp_tls_wrappermode=yes");
  });
});

/**
 * Switching provider is the case where leftovers are silent AND total: a
 * `sender_relayhost` row pointing at the old host defers that sender's mail
 * forever (the SASL map only ever holds one relay's credentials), and a stale SPF
 * include keeps authorizing a provider we no longer send through.
 */
describe("switching provider leaves nothing behind", () => {
  beforeEach(() => {
    fakeState = {
      serverId: "srv1",
      domain: "example.com",
      outboundRelay: {
        enabled: true,
        provider: "sendgrid",
        host: "smtp.sendgrid.net",
        port: 587,
        username: "apikey",
        passwordEncrypted: "enc(old)",
        scope: "selected",
        domains: ["example.com"],
      },
      dnsRecords: {
        spf: { type: "TXT", name: "example.com", value: "v=spf1 mx include:sendgrid.net -all" },
      },
    };
  });

  test("deletes rows pointing at the previous nexthop", async () => {
    const { exec } = makeExec();
    await configureOutboundRelay(exec, {
      provider: "postmark",
      port: 587,
      username: "token",
      password: "p",
      scope: "selected",
      domains: ["example.com"],
    });
    const deletes = pg.sqlCalls.filter((s) => /DELETE FROM sender_relayhost/i.test(s));
    expect(deletes.join("\n")).toContain("'[smtp.sendgrid.net]:587'");
    expect(deletes.join("\n")).toContain("'[smtp.postmarkapp.com]:587'");
  });

  test("swaps the SPF include rather than stacking a second one", async () => {
    const { exec } = makeExec();
    await configureOutboundRelay(exec, {
      provider: "postmark",
      port: 587,
      username: "token",
      password: "p",
      scope: "selected",
      domains: ["example.com"],
    });
    const spf = (fakeState as { dnsRecords: { spf: { value: string } } }).dnsRecords.spf.value;
    expect(spf).toBe("v=spf1 mx include:spf.mtasv.net -all");
  });

  test("a provider with no known include leaves SPF clean (no guessed token)", async () => {
    const { exec } = makeExec();
    await configureOutboundRelay(exec, {
      provider: "resend",
      port: 587,
      username: "resend",
      password: "p",
      scope: "all",
    });
    const spf = (fakeState as { dnsRecords: { spf: { value: string } } }).dnsRecords.spf.value;
    expect(spf).toBe("v=spf1 mx -all");
  });

  test("going global drops the previous provider's per-sender rows", async () => {
    const { exec } = makeExec();
    await configureOutboundRelay(exec, { provider: "ses", region: "eu-west-1", port: 587, username: "u", password: "p", scope: "all" });
    const deletes = pg.sqlCalls.filter((s) => /DELETE FROM sender_relayhost/i.test(s));
    expect(deletes.join("\n")).toContain("'[smtp.sendgrid.net]:587'");
    expect(pg.sqlCalls.some((s) => /INSERT INTO sender_relayhost/i.test(s))).toBe(false);
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
