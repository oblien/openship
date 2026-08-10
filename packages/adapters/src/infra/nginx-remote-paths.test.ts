/**
 * Regression: every path NginxProvider hands to the edge is a path on the EDGE
 * HOST (Linux), so it must be POSIX no matter what OS the control plane runs.
 *
 * `node:path` is mocked here so its DEFAULT named exports behave like win32 —
 * exactly what a Windows control plane gets — while `posix` stays real. Anything
 * joined with the platform default therefore shows up with backslashes and fails
 * these assertions, which is precisely how a Windows install lost TLS:
 *
 *   - certbot issued a real certificate to /etc/letsencrypt/live/<domain>/, the
 *     post-issue read looked at `\etc\letsencrypt\live\<domain>` and found
 *     nothing, so provisionCert threw. The domain row stayed
 *     sslStatus=provisioning / sslExpiresAt=null, which the renewal sweep skips
 *     — the cert quietly expired 90 days later.
 *   - the vhost was written to the SSH session's home directory as a file
 *     literally named `\var\lib\openship\edge\sites-enabled\<site>.conf`, so
 *     nginx never saw it and the site didn't serve.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { describe, expect, test, vi } from "vitest";

vi.mock("node:path", async () => {
  const actual = await vi.importActual<typeof import("node:path")>("node:path");
  // Spreading win32 makes `join`/`dirname`/`sep` win32; `posix` (carried by the
  // spread, restated for clarity) stays genuine.
  return { ...actual.win32, win32: actual.win32, posix: actual.posix, default: actual.win32 };
});

const { NginxProvider } = await import("./nginx");
const { OPENRESTY_DEFAULT_PATHS } = await import("./openresty-lua");
type CommandExecutor = import("../types").CommandExecutor;

const DOMAIN = "app.example.com";
const SITES = "/var/lib/openship/edge/sites-enabled";
const LIVE = `/etc/letsencrypt/live/${DOMAIN}`;
const PATHS = { ...OPENRESTY_DEFAULT_PATHS, sitesDir: SITES };

/**
 * A self-signed pair for DOMAIN. Deliberately NOT ../system/proxy/test-certs —
 * that helper joins its temp paths with node:path, which this file has mocked to
 * win32, so it would build an unopenable `\var\folders\…` path on the test host.
 * String concatenation sidesteps the mock entirely.
 */
function mintCert(): { certPem: string; keyPem: string } {
  const dir = mkdtempSync(`${tmpdir()}/openship-nginx-remote-paths-`);
  try {
    execFileSync(
      "openssl",
      [
        "req", "-x509", "-newkey", "rsa:2048", "-nodes",
        "-keyout", `${dir}/key.pem`,
        "-out", `${dir}/cert.pem`,
        "-days", "30",
        "-subj", `/O=Let's Encrypt/CN=${DOMAIN}`,
        "-addext", `subjectAltName=DNS:${DOMAIN}`,
      ],
      { stdio: "pipe" },
    );
    return {
      certPem: readFileSync(`${dir}/cert.pem`, "utf8"),
      keyPem: readFileSync(`${dir}/key.pem`, "utf8"),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * In-memory edge. `exists`/`readFile` answer ONLY for the exact keys written, so a
 * backslash-joined lookup misses the same way it misses on a real Linux box.
 * Detection commands throw so reload() keeps the configured sitesDir.
 */
function setup(opts: { certOnDisk?: boolean; certbotOutput?: string } = {}) {
  const files = new Map<string, string>();
  const writes: string[] = [];

  if (opts.certOnDisk) {
    const { certPem, keyPem } = mintCert();
    files.set(`${LIVE}/fullchain.pem`, certPem);
    files.set(`${LIVE}/privkey.pem`, keyPem);
  }

  const executor = {
    exec: async (command: string) => {
      if (/\s-V\b|command -v|which\s/.test(command)) throw new Error("no openresty in test");
      if (command.startsWith("certbot ")) return opts.certbotOutput ?? "Successfully received certificate.";
      const mv = command.match(/^mv '([^']+)' '([^']+)'$/);
      if (mv) {
        const c = files.get(mv[1]);
        if (c !== undefined) { files.set(mv[2], c); files.delete(mv[1]); }
      }
      return "";
    },
    writeFile: async (p: string, c: string) => { writes.push(p); files.set(p, c); },
    readFile: async (p: string) => {
      const c = files.get(p);
      if (c === undefined) throw new Error(`ENOENT ${p}`);
      return c;
    },
    exists: async (p: string) => files.has(p),
    mkdir: async () => {},
    rm: async (p: string) => { files.delete(p); },
  } as unknown as CommandExecutor;

  return {
    nginx: new NginxProvider({ paths: PATHS, executor }),
    files,
    writes,
    conf: () => files.get(`${SITES}/app-example-com.conf`),
  };
}

describe("edge paths are POSIX on a Windows control plane", () => {
  test("the vhost lands in sites-enabled, not in the SSH home dir", async () => {
    const { nginx, conf, writes } = setup();

    await nginx.registerRoute({ domain: DOMAIN, targetUrl: "http://127.0.0.1:3009", tls: false });

    expect(conf()).toContain(`server_name ${DOMAIN};`);
    expect(writes.some((p) => p.includes("\\"))).toBe(false);
  });

  test("provisionCert finds the certificate certbot actually wrote", async () => {
    const { nginx } = setup({ certOnDisk: true });
    await nginx.registerRoute({ domain: DOMAIN, targetUrl: "http://127.0.0.1:3009", tls: false });

    // The reported failure: this threw "no readable certificate is at
    // \etc\letsencrypt\live\app.example.com" while the cert sat at the POSIX path.
    const result = await nginx.provisionCert(DOMAIN, { force: true });

    expect(result.verified).toBe(true);
    expect(result.expiresAt).not.toBe("");
  });

  test("ssl_certificate directives are POSIX so openresty -t can load them", async () => {
    const { nginx, conf } = setup({ certOnDisk: true });

    await nginx.registerRoute({ domain: DOMAIN, targetUrl: "http://127.0.0.1:3009", tls: true });

    expect(conf()).toContain(`ssl_certificate ${LIVE}/fullchain.pem;`);
    expect(conf()).toContain(`ssl_certificate_key ${LIVE}/privkey.pem;`);
    expect(conf()).not.toContain("\\etc");
  });

  test("verifyCert reads the POSIX live dir", async () => {
    const { nginx } = setup({ certOnDisk: true });
    await expect(nginx.verifyCert(DOMAIN)).resolves.toMatchObject({ verified: true });
  });
});

describe("a zero-exit certbot run is judged by disk, not by its stdout", () => {
  // certbot's own footer, verbatim — this is what the Windows bug surfaced to the
  // operator as `lastVerifyError` for a certificate that had been issued fine.
  const CLEAN_RUN =
    "Successfully received certificate.\n" +
    `Certificate is saved at: ${LIVE}/fullchain.pem\n` +
    "We were unable to subscribe you to the EFF mailing list.\n" +
    "If you like Certbot, please consider supporting our work by:\n" +
    " * Donating to ISRG / Let's Encrypt: https://letsencrypt.org/donate";

  test("the donation footer is never reported as the cause", async () => {
    // No cert on disk → provisionCert must still fail, but for the real reason.
    const { nginx } = setup({ certbotOutput: CLEAN_RUN });

    await expect(nginx.provisionCert(DOMAIN, { force: true })).rejects.toThrow(
      /no certificate is at \/etc\/letsencrypt\/live\/app\.example\.com/,
    );
    await expect(nginx.provisionCert(DOMAIN, { force: true })).rejects.not.toThrow(
      /^\s*\* Donating to ISRG/,
    );
  });

  test("certbot's output is still attached as evidence", async () => {
    const { nginx } = setup({ certbotOutput: CLEAN_RUN });
    await expect(nginx.provisionCert(DOMAIN, { force: true })).rejects.toThrow(/certbot said:/);
  });
});
