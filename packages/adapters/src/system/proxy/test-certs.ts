/**
 * Self-signed cert fixtures for the cert-adoption tests.
 *
 * Generated with `openssl` at test time rather than checked in as PEM literals,
 * because a committed cert expires and would turn these into a time bomb that
 * fails months later for a reason unrelated to the code. Generation is cached
 * per (names, issuer, days) for the process, so a suite asking for the same cert
 * repeatedly pays for it once.
 *
 * Test-only — nothing in src imports this.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface TestCert {
  certPem: string;
  keyPem: string;
}

const cache = new Map<string, TestCert>();

/**
 * A self-signed cert covering `names` (SANs). `issuerCN` lets a test mint one that
 * LOOKS like it came from a public ACME CA ("R11" with O=Let's Encrypt) so the
 * renewable classification can be exercised — self-signed material is fine here
 * because nothing validates the chain, only the issuer string.
 *
 * To test EXPIRY, mint a short-lived cert (`days: 1`) and move the clock past it
 * with `vi.setSystemTime` — don't try a negative `-days`, which LibreSSL silently
 * ignores (it yields a still-valid cert and the test passes for the wrong reason).
 */
export function makeTestCert(
  names: string[],
  opts: { issuerCN?: string; issuerO?: string; days?: number } = {},
): TestCert {
  const key = JSON.stringify([names, opts]);
  const hit = cache.get(key);
  if (hit) return hit;

  const dir = mkdtempSync(join(tmpdir(), "openship-cert-"));
  try {
    const subjectParts = [opts.issuerO ? `/O=${opts.issuerO}` : "", `/CN=${opts.issuerCN ?? names[0]}`];
    execFileSync(
      "openssl",
      [
        "req", "-x509", "-newkey", "rsa:2048",
        "-keyout", join(dir, "key.pem"),
        "-out", join(dir, "cert.pem"),
        "-days", String(opts.days ?? 30),
        "-nodes",
        "-subj", subjectParts.join(""),
        "-addext", `subjectAltName=${names.map((n) => `DNS:${n}`).join(",")}`,
      ],
      { stdio: "pipe" },
    );
    const cert: TestCert = {
      certPem: readFileSync(join(dir, "cert.pem"), "utf8"),
      keyPem: readFileSync(join(dir, "key.pem"), "utf8"),
    };
    cache.set(key, cert);
    return cert;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** A cert whose SANs carry no name matching what the caller will ask for. */
export function otherHostCert(): TestCert {
  return makeTestCert(["somewhere-else.example"]);
}
