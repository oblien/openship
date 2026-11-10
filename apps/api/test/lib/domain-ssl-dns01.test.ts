import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Domain } from "@repo/db";
import type { SslProvider } from "@repo/adapters";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const h = vi.hoisted(() => ({
  certificateManagement: undefined as "provider" | undefined,
  domains: new Map<string, Record<string, unknown>>(),
  updateSsl: vi.fn(),
  recordSslFailure: vi.fn(),
  markCredentialInvalid: vi.fn(async () => {}),
  markVerifiedActive: vi.fn(),
  disposePlatform: vi.fn(),
  provisionCert: vi.fn(async (domain: string, _opts?: unknown) => ({
    domain,
    expiresAt: "2030-01-01T00:00:00.000Z",
    issuer: "Let's Encrypt",
    verified: true,
    reason: "issued" as const,
  })),
  renewCert: vi.fn(async (domain: string, _opts?: unknown) => ({
    domain,
    expiresAt: "2030-01-01T00:00:00.000Z",
    issuer: "Let's Encrypt",
    verified: true,
    reason: "renewed" as const,
  })),
  verifyCert: vi.fn(async (domain: string) => ({
    domain,
    expiresAt: "2030-01-01T00:00:00.000Z",
    issuer: "Let's Encrypt",
    verified: true,
  })),
  dnsManagerResult: {
    status: "matched" as const,
    manager: {
      credentialId: "cred_1",
      provider: {
        name: "cloudflare" as const,
        descriptor: { name: "cloudflare" as const, displayName: "Cloudflare", description: "" },
      },
      zone: { id: "zone_123", name: "example.com", status: "active" },
      credentials: { apiToken: "test-token" },
    },
  },
}));

vi.mock("@repo/db", () => ({
  repos: {
    domain: {
      findByHostname: vi.fn(async (hostname: string) => h.domains.get(hostname) ?? null),
      updateSsl: h.updateSsl,
      recordSslFailure: h.recordSslFailure,
      markVerifiedActive: h.markVerifiedActive,
    },
    project: {
      findById: vi.fn(async (id: string) => ({
        id,
        organizationId: "org_1",
        activeDeploymentId: "dep_1",
      })),
    },
    deployment: {
      listPendingRoleHandovers: vi.fn(async () => []),
      findById: vi.fn(async (id: string) => ({
        id,
        projectId: "prj_1",
        organizationId: "org_1",
        meta: {},
      })),
    },
    server: { findLocal: vi.fn(async () => null) },
  },
}));
vi.mock("../../src/lib/controller-helpers", () => ({
  platform: () => ({ target: "selfhosted", runtime: {} }),
}));

vi.mock("@repo/platform/engine/lib/provision-lock", () => ({
  createProvisionLock: () => ({ run: <T>(fn: () => Promise<T>) => fn() }),
}));

vi.mock("@repo/platform/engine/lib/deployment-runtime", () => ({
  disposePlatform: h.disposePlatform,
  resolveDeploymentPlatform: vi.fn(async () => ({
    platform: {
      ssl: {
        get certificateManagement() { return h.certificateManagement; },
        provisionCert: h.provisionCert,
        renewCert: h.renewCert,
        verifyCert: h.verifyCert,
      },
    },
  })),
}));

vi.mock("@repo/platform/engine/modules/dns/dns-credential.service", () => ({
  resolveDnsManager: vi.fn(async () => h.dnsManagerResult),
  markCredentialInvalid: h.markCredentialInvalid,
}));

import {
  manageDomainSsl,
  provisionDomainCertForVerify,
  createDnsHookScripts,
} from "@repo/platform/engine/lib/domain-ssl";
import { createTrackedSslProvider } from "@repo/platform/engine/lib/routing-domains";

function domain(hostname: string, extra: Record<string, unknown> = {}) {
  h.domains.set(hostname, {
    id: `dom_${hostname}`,
    hostname,
    projectId: "prj_1",
    organizationId: "org_1",
    verified: true,
    status: "active",
    sslStatus: "none",
    sslChallenge: "http-01",
    ...extra,
  });
}

describe("DNS-01 ACME challenge support in domain-ssl", () => {
  beforeEach(() => {
    h.certificateManagement = undefined;
    h.domains.clear();
    h.updateSsl.mockClear();
    h.recordSslFailure.mockClear();
    h.markVerifiedActive.mockClear();
    h.disposePlatform.mockClear();
    h.provisionCert.mockClear();
    h.renewCert.mockClear();
    h.verifyCert.mockReset().mockResolvedValue({
      domain: "app.example.com",
      expiresAt: "",
      issuer: "Let's Encrypt",
      verified: false,
    });
    h.dnsManagerResult = {
      status: "matched",
      manager: {
        credentialId: "cred_1",
        provider: {
          name: "cloudflare",
          descriptor: { name: "cloudflare", displayName: "Cloudflare", description: "" },
        },
        zone: { id: "zone_123", name: "example.com", status: "active" },
        credentials: { apiToken: "test-token" },
      },
    };
  });

  it("passes challenge: 'dns-01' and generated hooks to provisionCert when sslChallenge is dns-01", async () => {
    domain("app.example.com", { sslChallenge: "dns-01" });

    const result = await manageDomainSsl("app.example.com", { action: "provision" });

    expect(result.verified).toBe(true);
    expect(h.provisionCert).toHaveBeenCalledTimes(1);
    const [calledHost, calledOpts] = h.provisionCert.mock.calls[0] as [
      string,
      { challenge?: string; dnsAuthHookScript?: string; dnsCleanupHookScript?: string },
    ];
    expect(calledHost).toBe("app.example.com");
    expect(calledOpts.challenge).toBe("dns-01");
    expect(calledOpts.dnsAuthHookScript).toContain("cloudflare.com/client/v4");
    expect(calledOpts.dnsCleanupHookScript).toContain("DELETE");
  });

  it.each(["provision", "renew"] as const)("lets Cloud manage %s without resolving local DNS credentials", async (action) => {
    h.certificateManagement = "provider";
    h.dnsManagerResult = { status: "none" } as unknown as typeof h.dnsManagerResult;
    domain("app.example.com", { sslChallenge: "dns-01", sslDnsMode: "manual" });
    const result = await manageDomainSsl("app.example.com", { action, challenge: "dns-01" });
    expect(result.verified).toBe(true);
    const calls = action === "provision" ? h.provisionCert.mock.calls : h.renewCert.mock.calls;
    expect(calls).toHaveLength(1);
    expect(calls[0]?.[1] ?? {}).not.toHaveProperty("dnsAuthHookScript");
    expect(calls[0]?.[1] ?? {}).not.toHaveProperty("challenge");
  });

  it("preserves provider-managed certificates through the deployment wrapper", async () => {
    const host = "app.example.com";
    domain(host, { verified: false, sslChallenge: "dns-01" });
    h.dnsManagerResult = { status: "none" } as unknown as typeof h.dnsManagerResult;
    const selected: SslProvider = {
      certificateManagement: "provider",
      provisionCert: h.provisionCert, verifyCert: h.verifyCert,
      renewCert: h.renewCert, installCert: vi.fn(),
    };
    const tracked = createTrackedSslProvider(selected, new Map([[host, h.domains.get(host) as unknown as Domain]]));
    expect(tracked.certificateManagement).toBe("provider");
    expect(await tracked.provisionCert(host)).toMatchObject({ verified: true });
    expect(h.provisionCert).toHaveBeenCalledExactlyOnceWith(host);
    expect(h.markVerifiedActive).toHaveBeenCalledWith(`dom_${host}`, expect.objectContaining({ sslStatus: "active" }));
  });

  it("the generated ACME shell hook sends quoted TXT content as valid JSON", () => {
    const dir = mkdtempSync(join(tmpdir(), "openship-dns-hook-"));
    try {
      const hooks = createDnsHookScripts(h.dnsManagerResult.manager as never);
      const auth = join(dir, "auth.sh");
      const payload = join(dir, "payload.json");
      writeFileSync(auth, hooks.authHookScript);
      writeFileSync(join(dir, "curl"), `#!/usr/bin/env python3
import json, os, sys
if '--data' in sys.argv:
    value = sys.argv[sys.argv.index('--data') + 1]
    json.loads(value)
    open(os.environ['CAPTURE_PAYLOAD'], 'w').write(value)
    print('{"success":true,"result":{"id":"record_123"}}')
else:
    print(json.dumps({'Answer': [{'type':16, 'data': '"test_validation"'}]}))
`, { mode: 0o700 });
      execFileSync("/bin/sh", [auth], { timeout: 5000, env: {
        ...process.env, PATH: `${dir}:/usr/bin:/bin`, CAPTURE_PAYLOAD: payload,
        CERTBOT_DOMAIN: "app.example.com", CERTBOT_VALIDATION: "test_validation",
        OPENSHIP_DNS_RECORD_FILE: join(dir, "record-id"),
      } });
      expect(JSON.parse(readFileSync(payload, "utf8"))).toMatchObject({
        type: "TXT", name: "_acme-challenge.app.example.com", content: '"test_validation"',
      });
      expect(readFileSync(join(dir, "record-id"), "utf8").trim()).toBe("record_123");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  const compactRecord =
    '{"domain_record":{"id":28448433,"type":"TXT","name":"x","data":"y","ttl":30}}';
  // How a pretty-printing proxy or a future API change could return the same record.
  const multilineRecord = `{
  "domain_record": {
    "id": 28448433,
    "type": "TXT",
    "name": "x",
    "data": "y",
    "ttl": 30
  }
}`;

  it.each([
    ["app.example.com", "_acme-challenge.app", "compact", true, compactRecord],
    ["*.example.com", "_acme-challenge", "compact", true, compactRecord],
    ["app.example.com", "_acme-challenge.app", "multiline", true, multilineRecord],
    ["app.example.com", "_acme-challenge.app", "multiline", false, multilineRecord],
    ["app.example.com", "_acme-challenge.app", "compact", false, compactRecord],
  ])(
    "the DigitalOcean hook writes %s's challenge as %s and cleans up its %s record (python3: %s)",
    (certbotDomain, name, _format, pythonWorks, response) => {
      const dir = mkdtempSync(join(tmpdir(), "openship-do-hook-"));
      try {
        const hooks = createDnsHookScripts({
          credentialId: "cred_do",
          provider: {
            name: "digitalocean",
            descriptor: { name: "digitalocean", displayName: "DigitalOcean", description: "" },
          },
          zone: { id: "example.com", name: "example.com", status: "active" },
          credentials: { apiToken: "dop_v1_abc123" },
        } as never);
        const auth = join(dir, "auth.sh");
        const cleanup = join(dir, "cleanup.sh");
        const payload = join(dir, "payload.json");
        const calls = join(dir, "curl-calls");
        const responseFile = join(dir, "response.json");
        writeFileSync(auth, hooks.authHookScript);
        writeFileSync(cleanup, hooks.cleanupHookScript);
        writeFileSync(responseFile, response);
        // A POSIX curl stand-in, so the python3 stub below can shadow the real one.
        writeFileSync(
          join(dir, "curl"),
          `#!/bin/sh
printf '%s\\n' "$*" >> "$CURL_CALLS"
prev=""
for arg in "$@"; do
  if [ "$prev" = "--data" ]; then
    printf '%s' "$arg" > "$CAPTURE_PAYLOAD"
    cat "$RESPONSE_FILE"
    exit 0
  fi
  prev="$arg"
done
case "$*" in *DELETE*) exit 0 ;; esac
printf '%s' '{"Answer":[{"type":16,"data":"\\"test_validation\\""}]}'
`,
          { mode: 0o700 },
        );
        if (!pythonWorks)
          writeFileSync(join(dir, "python3"), "#!/bin/sh\nexit 127\n", { mode: 0o700 });
        const env = {
          ...process.env,
          PATH: `${dir}:/usr/bin:/bin`,
          CAPTURE_PAYLOAD: payload,
          CURL_CALLS: calls,
          RESPONSE_FILE: responseFile,
          CERTBOT_DOMAIN: certbotDomain,
          CERTBOT_VALIDATION: "test_validation",
          OPENSHIP_DNS_RECORD_FILE: join(dir, "record-id"),
        };
        execFileSync("/bin/sh", [auth], { timeout: 5000, env });
        expect(JSON.parse(readFileSync(payload, "utf8"))).toEqual({
          type: "TXT",
          name,
          data: "test_validation",
          ttl: 30,
        });
        expect(readFileSync(join(dir, "record-id"), "utf8").trim()).toBe("28448433");

        execFileSync("/bin/sh", [cleanup], { timeout: 5000, env });
        const deletes = readFileSync(calls, "utf8")
          .split("\n")
          .filter((line) => line.includes("DELETE"));
        expect(deletes).toHaveLength(1);
        expect(deletes[0]).toContain(
          "https://api.digitalocean.com/v2/domains/example.com/records/28448433",
        );
        expect(existsSync(join(dir, "record-id"))).toBe(false);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it("fails without saving an id when DigitalOcean answers with an error body", () => {
    const dir = mkdtempSync(join(tmpdir(), "openship-do-hook-"));
    try {
      const hooks = createDnsHookScripts({
        credentialId: "cred_do",
        provider: {
          name: "digitalocean",
          descriptor: { name: "digitalocean", displayName: "DigitalOcean", description: "" },
        },
        zone: { id: "example.com", name: "example.com", status: "active" },
        credentials: { apiToken: "dop_v1_abc123" },
      } as never);
      const auth = join(dir, "auth.sh");
      writeFileSync(auth, hooks.authHookScript);
      writeFileSync(
        join(dir, "curl"),
        `#!/bin/sh\nprintf '%s' '{"id": "unauthorized", "message": "Unable to authenticate you."}'\n`,
        { mode: 0o700 },
      );
      expect(() =>
        execFileSync("/bin/sh", [auth], {
          timeout: 5000,
          stdio: "pipe",
          env: {
            ...process.env,
            PATH: `${dir}:/usr/bin:/bin`,
            CERTBOT_DOMAIN: "app.example.com",
            CERTBOT_VALIDATION: "test_validation",
            OPENSHIP_DNS_RECORD_FILE: join(dir, "record-id"),
          },
        }),
      ).toThrow();
      expect(existsSync(join(dir, "record-id"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses a DigitalOcean zone that is not a plain domain name", () => {
    expect(() =>
      createDnsHookScripts({
        credentialId: "cred_do",
        provider: {
          name: "digitalocean",
          descriptor: { name: "digitalocean", displayName: "DigitalOcean", description: "" },
        },
        zone: { id: "example.com$(id)", name: "example.com", status: "active" },
        credentials: { apiToken: "dop_v1_abc123" },
      } as never),
    ).toThrow("invalid zone identifier");
  });

  it("reuses a valid wildcard certificate without requiring DNS credentials for a new order", async () => {
    h.dnsManagerResult = { status: "none" } as unknown as typeof h.dnsManagerResult;
    domain("*.example.com", { sslChallenge: "dns-01" });
    h.verifyCert.mockResolvedValueOnce({
      domain: "*.example.com",
      expiresAt: "2030-01-01T00:00:00.000Z",
      issuer: "Let's Encrypt",
      verified: true,
    });
    const result = await manageDomainSsl("*.example.com", { action: "provision" });
    expect(result).toMatchObject({ verified: true, expiresAt: "2030-01-01T00:00:00.000Z" });
    expect(h.provisionCert).not.toHaveBeenCalled();
    expect(h.updateSsl).toHaveBeenCalledWith(
      "dom_*.example.com",
      expect.objectContaining({ sslStatus: "active" }),
    );
  });

  it("automatically uses DNS-01 challenge for wildcard domains", async () => {
    domain("*.example.com", { sslChallenge: "http-01" }); // Even if marked http-01, wildcard enforces dns-01

    const result = await manageDomainSsl("*.example.com", { action: "provision" });

    expect(result.verified).toBe(true);
    expect(h.provisionCert).toHaveBeenCalledTimes(1);
    const [, calledOpts] = h.provisionCert.mock.calls[0] as [
      string,
      { challenge?: string; dnsAuthHookScript?: string },
    ];
    expect(calledOpts.challenge).toBe("dns-01");
    expect(calledOpts.dnsAuthHookScript).toBeDefined();
  });

  it("does not issue or renew a manual TXT certificate through the connected provider", async () => {
    domain("*.example.com", { sslChallenge: "dns-01", sslDnsMode: "manual" });
    await expect(manageDomainSsl("*.example.com", { action: "provision" })).rejects.toThrow(/manual TXT/);
    await expect(manageDomainSsl("*.example.com", { action: "renew" })).rejects.toThrow(/manual TXT/);
    expect(h.provisionCert).not.toHaveBeenCalled();
    expect(h.renewCert).not.toHaveBeenCalled();
  });

  it("reuses an existing manual TXT certificate without touching its provider", async () => {
    domain("*.example.com", { sslChallenge: "dns-01", sslDnsMode: "manual" });
    h.verifyCert.mockResolvedValue({ domain: "*.example.com", expiresAt: "2030-01-01T00:00:00.000Z", issuer: "Let's Encrypt", verified: true });
    expect(await manageDomainSsl("*.example.com", { action: "provision" })).toMatchObject({ verified: true });
    expect(h.provisionCert).not.toHaveBeenCalled();
  });

  it("provisionDomainCertForVerify generates DNS hooks and passes dns-01 for unverified wildcard domain", async () => {
    domain("*.example.com", { verified: false, sslChallenge: "dns-01" });

    const result = await provisionDomainCertForVerify("*.example.com", { force: true });

    expect(result.verified).toBe(true);
    expect(h.provisionCert).toHaveBeenCalledTimes(1);
    const [, calledOpts] = h.provisionCert.mock.calls[0] as [
      string,
      { challenge?: string; dnsAuthHookScript?: string },
    ];
    expect(calledOpts.challenge).toBe("dns-01");
    expect(calledOpts.dnsAuthHookScript).toBeDefined();
  });

  it("fails with an actionable message when DNS-01 is needed but no DNS provider is connected", async () => {
    h.dnsManagerResult = { status: "none" } as unknown as typeof h.dnsManagerResult;
    domain("*.example.com", { sslChallenge: "dns-01" });

    await expect(manageDomainSsl("*.example.com", { action: "provision" })).rejects.toThrow(
      /connected DNS provider.*Settings → Credentials.*Manual TXT/,
    );
    expect(h.provisionCert).not.toHaveBeenCalled();
    expect(h.recordSslFailure).toHaveBeenCalledWith(
      "dom_*.example.com",
      expect.stringMatching(/connected DNS provider.*Manual TXT/),
      "operation",
    );
  });

  it("fails when DNS provider credential was rejected", async () => {
    h.dnsManagerResult = {
      status: "unauthorized",
      credentialId: "cred_1",
      provider: "cloudflare",
      reason: "Invalid token",
    } as unknown as typeof h.dnsManagerResult;
    domain("app.example.com", { sslChallenge: "dns-01" });

    await expect(manageDomainSsl("app.example.com", { action: "provision" })).rejects.toThrow(
      /DNS provider credential rejected: Invalid token/,
    );
    // Marked like every other rejection, so the dashboard shows it needs reconnecting.
    expect(h.markCredentialInvalid).toHaveBeenCalledWith(expect.any(String), "cred_1");
    expect(h.provisionCert).not.toHaveBeenCalled();
    expect(h.recordSslFailure).toHaveBeenCalledWith(
      "dom_app.example.com",
      expect.stringContaining("DNS provider credential rejected: Invalid token"),
      "operation",
    );
  });

  it("uses caller-supplied dnsAuthHook and dnsCleanupHook without querying provider", async () => {
    domain("app.example.com", { sslChallenge: "dns-01" });

    await manageDomainSsl("app.example.com", {
      action: "provision",
      dnsAuthHook: "/custom/auth.sh",
      dnsCleanupHook: "/custom/cleanup.sh",
    });

    expect(h.provisionCert).toHaveBeenCalledTimes(1);
    const [, calledOpts] = h.provisionCert.mock.calls[0] as [
      string,
      { challenge?: string; dnsAuthHook?: string; dnsCleanupHook?: string },
    ];
    expect(calledOpts.challenge).toBe("dns-01");
    expect(calledOpts.dnsAuthHook).toBe("/custom/auth.sh");
    expect(calledOpts.dnsCleanupHook).toBe("/custom/cleanup.sh");
  });

  it("builds hooks that validate provider success and wait for public DNS", () => {
    const hooks = createDnsHookScripts({
      credentialId: "cred_1",
      provider: {
        name: "cloudflare",
        descriptor: { name: "cloudflare", displayName: "Cloudflare", description: "" },
      },
      zone: { id: "zone_cf_123", name: "test.com", status: "active" },
      credentials: { apiToken: "secret_cf_token" },
    });

    expect(hooks.authHookScript).toContain("zone_cf_123");
    expect(hooks.authHookScript).toContain("secret_cf_token");
    expect(hooks.authHookScript).toContain('"success":true');
    expect(hooks.authHookScript).toContain("cloudflare-dns.com/dns-query");
    expect(hooks.authHookScript).toContain("OPENSHIP_DNS_RECORD_FILE");
    expect(hooks.cleanupHookScript).toContain("zone_cf_123");
    expect(hooks.cleanupHookScript).toContain("secret_cf_token");
  });

  it("passes fresh generated hooks to DNS-01 renewal", async () => {
    domain("app.example.com", { sslChallenge: "dns-01" });
    await manageDomainSsl("app.example.com", { action: "renew" });
    const [, calledOpts] = h.renewCert.mock.calls[0] as [
      string,
      { challenge?: string; dnsAuthHookScript?: string; dnsCleanupHookScript?: string },
    ];
    expect(calledOpts.challenge).toBe("dns-01");
    expect(calledOpts.dnsAuthHookScript).toContain("cloudflare.com/client/v4");
    expect(calledOpts.dnsCleanupHookScript).toContain("DELETE");
  });

  it("issues a first wildcard deployment on its selected server with the shared DNS hooks", async () => {
    const host = "*.example.com";
    domain(host, { verified: false, sslChallenge: "dns-01" });
    const selected: SslProvider = {
      provisionCert: vi.fn(async () => ({ domain: host, verified: true, expiresAt: "2030-01-01T00:00:00.000Z", issuer: "Let's Encrypt" })),
      verifyCert: vi.fn(async () => ({ domain: host, verified: false, expiresAt: "", issuer: "", reason: "missing" })),
      renewCert: vi.fn(), installCert: vi.fn(),
    };
    const rows = new Map([[host, h.domains.get(host) as unknown as Domain]]);
    const tracked = createTrackedSslProvider(selected, rows, undefined, "new-server");

    expect(await tracked.provisionCert(host)).toMatchObject({ verified: true });
    expect(selected.provisionCert).toHaveBeenCalledExactlyOnceWith(host, expect.objectContaining({
      challenge: "dns-01", dnsAuthHookScript: expect.stringContaining("zone_123"),
      dnsCleanupHookScript: expect.stringContaining("DELETE"),
    }));
    expect(h.provisionCert).not.toHaveBeenCalled(); // The previous serving target is never used.
    expect(h.markVerifiedActive).toHaveBeenCalledWith(`dom_${host}`, expect.objectContaining({ sslStatus: "active" }));
  });

  it.each([false, true])("keeps manual DNS ownership during deployment (certificate present: %s)", async (present) => {
    const host = "*.example.com";
    domain(host, { sslChallenge: "dns-01", sslDnsMode: "manual" });
    const selected: SslProvider = {
      provisionCert: vi.fn(), renewCert: vi.fn(), installCert: vi.fn(),
      verifyCert: vi.fn(async () => ({ domain: host, verified: present, expiresAt: present ? "2030-01-01T00:00:00.000Z" : "", issuer: "Let's Encrypt", reason: present ? undefined : "missing" })),
    };
    const rows = new Map([[host, h.domains.get(host) as unknown as Domain]]);
    const result = await createTrackedSslProvider(selected, rows).provisionCert(host);
    expect(result.verified).toBe(present);
    expect(selected.provisionCert).not.toHaveBeenCalled();
    expect(h.provisionCert).not.toHaveBeenCalled();
    if (present) expect(h.recordSslFailure).not.toHaveBeenCalled();
    else expect(h.recordSslFailure).toHaveBeenCalledWith(`dom_${host}`, expect.stringContaining("manual TXT"), "invalid");
  });

  it("does not report deployment HTTPS ready when activation fails with a valid certificate on disk", async () => {
    const host = "*.example.com";
    domain(host, { sslChallenge: "dns-01", sslDnsMode: "manual" });
    const selected: SslProvider = {
      provisionCert: vi.fn(), renewCert: vi.fn(), installCert: vi.fn(),
      verifyCert: vi.fn(async () => ({ domain: host, verified: true, expiresAt: "2030-01-01T00:00:00.000Z", issuer: "Let's Encrypt" })),
      activateCert: vi.fn().mockRejectedValue(new Error("Edge reload failed")),
    };
    const rows = new Map([[host, h.domains.get(host) as unknown as Domain]]);
    const result = await createTrackedSslProvider(selected, rows).provisionCert(host);
    expect(result.verified).toBe(false);
    expect(selected.provisionCert).not.toHaveBeenCalled();
    expect(h.updateSsl).not.toHaveBeenCalled();
    expect(h.recordSslFailure).toHaveBeenCalledWith(`dom_${host}`, "Edge reload failed", "unknown");
  });
});

// The application seams moved with the shared engine.
vi.mock("@repo/platform/engine/lib/platform-config", () => ({
  platform: () => ({ target: "selfhosted", runtime: {} }),
}));

vi.mock("@repo/platform/engine/lib/resource-access", () => ({
  platform: () => ({ target: "selfhosted", runtime: {} }),
}));
