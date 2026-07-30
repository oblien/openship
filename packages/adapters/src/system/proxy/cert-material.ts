/**
 * Certificate material — the ONE place a cert the box already serves is read,
 * validated, and classified before Openship adopts it.
 *
 * Five call sites used to answer "is there a cert / where is it / what is it"
 * with three different rule sets: the takeover's own reader (isSafePath + cat),
 * cert reuse in domain.service (readEdgeFile, no path gate), the migrate wizard's
 * paths-present predicate, and the CLI's collectCertPems. They could disagree
 * about the same box, and none of them checked the two things that actually
 * matter — that the cert COVERS the hostname, and that it hasn't expired. A
 * mismatched cert would install and the row would go `sslStatus: active`, so a
 * browser saw a name mismatch on a domain Openship reported as healthy.
 *
 * `validateCertFor` is that check, and it fails CLOSED: anything it can't vouch
 * for returns a reason instead of a cert, and the caller falls through to ACME.
 * A domain that stays pending is recoverable; a wrong cert served under a green
 * padlock is not.
 */

import { X509Certificate, createPrivateKey } from "node:crypto";
import { safeErrorMessage } from "@repo/core";
import type { CommandExecutor, ManualCert } from "../../types";
import { readMaybeInContainer } from "../edge-container-executor";

/**
 * A cert we're prepared to adopt: the PEMs plus everything the callers used to
 * recompute for themselves (or skip).
 */
export interface AdoptedCert extends ManualCert {
  /** Where it came from, for logs and operator-facing warnings. */
  source: string;
  /** notAfter, ISO. */
  expiresAt: string;
  /** Issuer CN (falling back to O, then the raw issuer line). */
  issuer: string;
  /** The names the leaf actually covers (SANs, or the subject CN if it has no SANs). */
  covers: string[];
  /**
   * Issued by a public ACME CA, so certbot can reissue it on this box.
   *
   * This drives whether the adopted row stays in the renewal batch. Adopting
   * used to always set `manualSsl`, which `tlsIssuedElsewhere` reads as "not ours
   * to reissue" and the SSL scheduler filters out — so an adopted 90-day Let's
   * Encrypt cert was never renewed and the domain went dark on day 90. A private
   * or origin CA (Cloudflare Origin CA, internal PKI) genuinely ISN'T ours to
   * reissue, and for those `manualSsl` is still correct.
   */
  renewable: boolean;
}

/** Why a candidate was rejected — surfaced to the operator, never swallowed. */
export type CertRejection = { cert: null; reason: string };
export type CertCandidate = { cert: AdoptedCert; reason?: undefined } | CertRejection;

/**
 * Public ACME CAs whose certs certbot can re-issue for on this host. Matched
 * case-insensitively against the issuer CN/O, so both "R11"-style leaf issuers
 * (whose O is "Let's Encrypt") and the CA's own name hit.
 */
const ACME_ISSUERS = [
  "let's encrypt",
  "lets encrypt",
  "letsencrypt",
  "zerossl",
  "google trust services",
  "buypass",
  "actalis",
  "ssl.com",
];

/** Issuer CN, else O, else the raw issuer line — whatever identifies the CA. */
function issuerLabel(x509: X509Certificate): string {
  const fields = new Map<string, string>();
  for (const line of x509.issuer.split("\n")) {
    const eq = line.indexOf("=");
    if (eq > 0) fields.set(line.slice(0, eq).trim().toUpperCase(), line.slice(eq + 1).trim());
  }
  return fields.get("CN") ?? fields.get("O") ?? x509.issuer.replace(/\n/g, ", ");
}

/** Does the issuer look like a public ACME CA we can renew through certbot? */
function isAcmeIssuer(x509: X509Certificate): boolean {
  const haystack = `${x509.issuer}`.toLowerCase();
  return ACME_ISSUERS.some((ca) => haystack.includes(ca));
}

/** DNS names the leaf carries: SANs when present, else the subject CN. */
function certNames(x509: X509Certificate): string[] {
  const names: string[] = [];
  for (const entry of (x509.subjectAltName ?? "").split(",")) {
    const [kind, ...rest] = entry.trim().split(":");
    if (kind?.toUpperCase() === "DNS" && rest.length) names.push(rest.join(":").trim().toLowerCase());
  }
  if (names.length === 0) {
    const cn = x509.subject.split("\n").find((l) => l.trim().toUpperCase().startsWith("CN="));
    if (cn) names.push(cn.slice(cn.indexOf("=") + 1).trim().toLowerCase());
  }
  return names;
}

/**
 * Does `host` match one of the cert's names? Node's `checkHost` is the canonical
 * answer, but it only consults SANs — a legacy CN-only cert (still common on
 * hand-rolled nginx boxes) makes it return undefined even though every client
 * accepts it. So fall back to matching the parsed names ourselves, including one
 * level of wildcard (`*.example.com` covers `a.example.com`, not `a.b.example.com`
 * and not the apex — same rule as RFC 6125).
 */
function coversHost(x509: X509Certificate, host: string): boolean {
  const target = host.toLowerCase();
  if (x509.checkHost(target)) return true;
  return certNames(x509).some((name) => {
    if (name === target) return true;
    if (!name.startsWith("*.")) return false;
    const suffix = name.slice(1); // "*.example.com" → ".example.com"
    return target.endsWith(suffix) && !target.slice(0, -suffix.length).includes(".");
  });
}

/**
 * Validate a PEM pair for `host` and classify it. Returns a rejection (never
 * throws) when the pair doesn't parse, the key doesn't match the cert, the cert
 * doesn't cover the hostname, or it has already expired.
 *
 * The key-match check is what keeps a broken pair off disk: OpenResty refuses to
 * reload with a cert its key doesn't open, which would take the whole edge down —
 * not just the one domain.
 */
export function validateCertFor(host: string, pems: ManualCert, source: string): CertCandidate {
  // Emptiness is judged on the trimmed text, but the PEMs are carried through
  // VERBATIM — a re-serialized or newline-stripped copy is a needless difference
  // from what the box was already serving, and some tools mind a missing final
  // newline.
  const certPem = pems.certPem ?? "";
  const keyPem = pems.keyPem ?? "";
  if (!certPem.trim() || !keyPem.trim()) {
    return { cert: null, reason: `${source}: cert or key is empty` };
  }

  let x509: X509Certificate;
  try {
    x509 = new X509Certificate(certPem);
  } catch (err) {
    return { cert: null, reason: `${source}: unreadable certificate (${safeErrorMessage(err)})` };
  }

  try {
    if (!x509.checkPrivateKey(createPrivateKey(keyPem))) {
      return { cert: null, reason: `${source}: private key does not match the certificate` };
    }
  } catch (err) {
    return { cert: null, reason: `${source}: unreadable private key (${safeErrorMessage(err)})` };
  }

  if (!coversHost(x509, host)) {
    return {
      cert: null,
      reason: `${source}: certificate covers ${certNames(x509).join(", ") || "no DNS names"} — not ${host}`,
    };
  }

  const notAfter = new Date(x509.validTo);
  if (!Number.isFinite(notAfter.getTime())) {
    return { cert: null, reason: `${source}: certificate has an unreadable expiry` };
  }
  if (notAfter.getTime() <= Date.now()) {
    return { cert: null, reason: `${source}: certificate expired ${notAfter.toISOString()}` };
  }

  return {
    cert: {
      certPem,
      keyPem,
      source,
      expiresAt: notAfter.toISOString(),
      issuer: issuerLabel(x509),
      covers: certNames(x509),
      renewable: isAcmeIssuer(x509),
    },
  };
}

/** A filesystem path safe to interpolate into a shell command. */
export function isSafeCertPath(p: string): boolean {
  return /^\/[A-Za-z0-9._/-]+$/.test(p) && !p.includes("..");
}

/**
 * Path segment holding the temporary self-signed certs Openship serves while a
 * domain's real cert is still being issued (see `ensureBootstrapCert` in
 * infra/nginx.ts). Lives here, next to the adoption rules, because the ONE thing
 * that must never happen to this material is being adopted as a real cert.
 */
export const BOOTSTRAP_CERT_SEGMENT = "openship-bootstrap";

/** Is this path one of our own placeholder certs rather than a real one? */
export function isBootstrapCertPath(p: string): boolean {
  return p.split("/").includes(BOOTSTRAP_CERT_SEGMENT);
}

/**
 * Read a cert path pair a proxy config DECLARED. The paths come from parsing
 * untrusted config, so both are gated on {@link isSafeCertPath} before they reach
 * a shell — the takeover checked this, cert reuse didn't, and they read the same
 * files off the same boxes.
 *
 * `container`, when given, is a fallback: the file is read on the host first and,
 * if that comes back empty, inside that container. A containerized proxy's certs
 * frequently live only in its own volume, where a host read is indistinguishable
 * from "no cert".
 *
 * Openship's OWN placeholder certs are refused here, at the single funnel every
 * declared-pair read passes through. A bootstrap cert would otherwise sail past
 * `validateCertFor` — right hostname, unexpired — and be classified
 * `renewable: false` (self-signed issuer), i.e. adopted as a bring-your-own cert
 * that certbot never reissues. A migrated or taken-over domain would then serve a
 * self-signed cert PERMANENTLY. Declining lands on every caller's existing
 * "unreadable → issue a fresh certificate" path instead.
 */
export async function readDeclaredPair(
  exec: CommandExecutor,
  certPath: string,
  keyPath: string,
  container?: string | null,
): Promise<ManualCert | null> {
  if (!isSafeCertPath(certPath) || !isSafeCertPath(keyPath)) return null;
  if (isBootstrapCertPath(certPath) || isBootstrapCertPath(keyPath)) return null;
  const certPem = await readMaybeInContainer(exec, certPath, container);
  const keyPem = await readMaybeInContainer(exec, keyPath, container);
  return certPem && keyPem ? { certPem, keyPem } : null;
}
