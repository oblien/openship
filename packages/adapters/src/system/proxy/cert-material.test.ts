import { afterEach, describe, expect, it, vi } from "vitest";
import { isSafeCertPath, readDeclaredPair, validateCertFor } from "./cert-material";
import { makeTestCert } from "./test-certs";
import type { CommandExecutor } from "../../types";

// The gate every adopted cert passes. Before this existed, five callers each had
// their own rules and none checked coverage or expiry — so a cert for the wrong
// hostname, or an expired one, would install and the domain row went "active".

describe("validateCertFor", () => {
  afterEach(() => vi.useRealTimers());

  it("accepts a cert that covers the host and reports its expiry + issuer", () => {
    const cert = makeTestCert(["a.com"]);
    const r = validateCertFor("a.com", cert, "/etc/ssl/a.crt");
    expect(r.cert).not.toBeNull();
    expect(r.cert?.source).toBe("/etc/ssl/a.crt");
    expect(r.cert?.covers).toContain("a.com");
    expect(new Date(r.cert!.expiresAt).getTime()).toBeGreaterThan(Date.now());
  });

  it("carries the PEMs through verbatim (no re-serialization)", () => {
    const cert = makeTestCert(["a.com"]);
    const r = validateCertFor("a.com", cert, "src");
    expect(r.cert?.certPem).toBe(cert.certPem);
    expect(r.cert?.keyPem).toBe(cert.keyPem);
  });

  it("matches any SAN, not just the first", () => {
    const cert = makeTestCert(["a.com", "www.a.com"]);
    expect(validateCertFor("www.a.com", cert, "src").cert).not.toBeNull();
  });

  it("matches a wildcard SAN one label deep, but not the apex or two labels deep", () => {
    const cert = makeTestCert(["*.a.com"]);
    expect(validateCertFor("app.a.com", cert, "src").cert).not.toBeNull();
    expect(validateCertFor("a.com", cert, "src").cert).toBeNull();
    expect(validateCertFor("deep.app.a.com", cert, "src").cert).toBeNull();
  });

  it("REJECTS a cert that doesn't cover the host, naming what it does cover", () => {
    const cert = makeTestCert(["a.com"]);
    const r = validateCertFor("b.com", cert, "/etc/ssl/a.crt");
    expect(r.cert).toBeNull();
    expect(r.reason).toContain("a.com");
    expect(r.reason).toContain("not b.com");
  });

  it("REJECTS a key that doesn't match the cert", () => {
    const cert = makeTestCert(["a.com"]);
    const other = makeTestCert(["a.com", "decoy"]); // different keypair, same name
    const r = validateCertFor("a.com", { certPem: cert.certPem, keyPem: other.keyPem }, "src");
    expect(r.cert).toBeNull();
    expect(r.reason).toContain("does not match");
  });

  it("REJECTS an expired cert", () => {
    const cert = makeTestCert(["a.com"], { days: 1 });
    // LibreSSL ignores a negative -days, so move the clock instead of minting a
    // past-dated cert (see test-certs.ts).
    vi.useFakeTimers();
    vi.setSystemTime(new Date(Date.now() + 3 * 24 * 60 * 60 * 1000));
    const r = validateCertFor("a.com", cert, "src");
    expect(r.cert).toBeNull();
    expect(r.reason).toContain("expired");
  });

  it("REJECTS empty or unparseable material", () => {
    expect(validateCertFor("a.com", { certPem: "", keyPem: "x" }, "src").reason).toContain("empty");
    expect(
      validateCertFor("a.com", { certPem: "not a pem", keyPem: "nor this" }, "src").reason,
    ).toContain("unreadable certificate");
  });

  // `renewable` decides whether the adopted row stays in the SSL scheduler's
  // renewal batch. Getting it wrong either lets an ACME cert expire silently, or
  // points certbot at a cert it can never reissue.
  describe("renewable classification", () => {
    it("marks a public-ACME issuer renewable", () => {
      const cert = makeTestCert(["a.com"], { issuerCN: "R11", issuerO: "Let's Encrypt" });
      expect(validateCertFor("a.com", cert, "src").cert?.renewable).toBe(true);
    });

    it("marks an origin/private CA NOT renewable", () => {
      const cert = makeTestCert(["a.com"], {
        issuerCN: "Cloudflare Origin SSL CA",
        issuerO: "CloudFlare, Inc.",
      });
      const r = validateCertFor("a.com", cert, "src");
      expect(r.cert?.renewable).toBe(false);
      expect(r.cert?.issuer).toContain("Cloudflare");
    });
  });
});

describe("isSafeCertPath", () => {
  it("accepts plain absolute paths", () => {
    expect(isSafeCertPath("/etc/letsencrypt/live/a.com/fullchain.pem")).toBe(true);
  });

  it("rejects traversal, relative paths, and shell metacharacters", () => {
    for (const bad of [
      "/etc/ssl/../secret.pem",
      "etc/ssl/a.pem",
      "/etc/ssl/$(whoami).pem",
      "/etc/ssl/a;rm -rf.pem",
      "/etc/ssl/`id`.pem",
    ]) {
      expect(isSafeCertPath(bad), bad).toBe(false);
    }
  });
});

describe("readDeclaredPair", () => {
  const exec = (files: Record<string, string>, containerFiles: Record<string, string> = {}) =>
    ({
      readFile: vi.fn(async (p: string) => {
        if (files[p] === undefined) throw new Error("enoent");
        return files[p];
      }),
      exec: vi.fn(async (cmd: string) => {
        const hit = Object.entries(containerFiles).find(([p]) => cmd.includes(p));
        return hit ? hit[1] : "";
      }),
    }) as unknown as CommandExecutor;

  it("reads both PEMs off the host", async () => {
    const e = exec({ "/c.pem": "CERT", "/k.pem": "KEY" });
    expect(await readDeclaredPair(e, "/c.pem", "/k.pem")).toEqual({
      certPem: "CERT",
      keyPem: "KEY",
    });
  });

  it("returns null without reading anything when a path is unsafe", async () => {
    const e = exec({ "/c.pem": "CERT" });
    expect(await readDeclaredPair(e, "/etc/../$(x).pem", "/k.pem")).toBeNull();
    expect(e.readFile).not.toHaveBeenCalled();
  });

  it("falls back INSIDE the container when the host read comes up empty", async () => {
    // A containerized proxy keeps its certs in its own volume; a host read there is
    // indistinguishable from "no cert", which is how carried certs went missing.
    const e = exec({}, { "/c.pem": "CERT", "/k.pem": "KEY" });
    expect(await readDeclaredPair(e, "/c.pem", "/k.pem", "traefik")).toEqual({
      certPem: "CERT",
      keyPem: "KEY",
    });
  });

  it("returns null when only one half of the pair is readable", async () => {
    const e = exec({ "/c.pem": "CERT" });
    expect(await readDeclaredPair(e, "/c.pem", "/k.pem")).toBeNull();
  });

  it("refuses Openship's OWN placeholder cert, without reading it", async () => {
    // A bootstrap cert is real-looking material: right hostname, unexpired, so it
    // passes validateCertFor — but its issuer is self-signed, so it'd be classified
    // renewable:false and adopted as a bring-your-own cert certbot never reissues.
    // A migrated or taken-over domain would then serve self-signed TLS forever.
    const cert = `/etc/letsencrypt/openship-bootstrap/app.example.com/fullchain.pem`;
    const key = `/etc/letsencrypt/openship-bootstrap/app.example.com/privkey.pem`;
    const e = exec({ [cert]: "CERT", [key]: "KEY" });
    expect(await readDeclaredPair(e, cert, key)).toBeNull();
    expect(e.readFile).not.toHaveBeenCalled();
  });

  it("does not mistake a legitimate path that merely CONTAINS the marker", async () => {
    // Segment match, not substring: a real cert for a host named after the marker
    // (or a dir like /etc/ssl/openship-bootstrapped) is still adoptable.
    const cert = "/etc/ssl/openship-bootstrapped/fullchain.pem";
    const key = "/etc/ssl/openship-bootstrapped/privkey.pem";
    const e = exec({ [cert]: "CERT", [key]: "KEY" });
    expect(await readDeclaredPair(e, cert, key)).toEqual({ certPem: "CERT", keyPem: "KEY" });
  });
});
