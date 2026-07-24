import { describe, it, expect } from "vitest";
import { summarizeCertbotFailure } from "./nginx";

/**
 * The whole point of the summarizer: turn certbot's opaque opener into the real,
 * actionable cause. Each case feeds realistic certbot output and asserts the
 * diagnosis names the right failure class (DNS / firewall-port-80 / proxy-on-80 /
 * rate-limit) and never echoes the useless "Saving debug log" opener alone.
 */

const OPENER = "Saving debug log to /var/log/letsencrypt/letsencrypt.log";

describe("summarizeCertbotFailure", () => {
  it("timeout → firewall / port-80 diagnosis (not the opener)", () => {
    const out = `${OPENER}
Requesting a certificate for hekai.org

Certbot failed to authenticate some domains (authenticator: webroot).
  Domain: hekai.org
  Type:   connection
  Detail: 65.109.55.23: Fetching http://hekai.org/.well-known/acme-challenge/abc: Timeout during connect (likely firewall problem)`;
    const s = summarizeCertbotFailure(out, "hekai.org");
    expect(s).toMatch(/Port 80/i);
    expect(s).toMatch(/firewall|proxy|point/i);
    expect(s).toContain("Timeout during connect");
    expect(s).not.toBe(OPENER);
  });

  it("NXDOMAIN → DNS-not-propagated diagnosis", () => {
    const out = `${OPENER}
  Type:   dns
  Detail: DNS problem: NXDOMAIN looking up A for hekai.org - check that a DNS record exists for this domain`;
    const s = summarizeCertbotFailure(out, "hekai.org");
    expect(s).toMatch(/doesn't resolve|DNS/i);
    expect(s).toContain("NXDOMAIN");
  });

  it("404 → another proxy still serving :80 (takeover didn't complete)", () => {
    const out = `${OPENER}
  Type:   unauthorized
  Detail: 65.109.55.23: Invalid response from http://hekai.org/.well-known/acme-challenge/abc: 404`;
    const s = summarizeCertbotFailure(out, "hekai.org");
    expect(s).toMatch(/takeover|another web server|:80/i);
  });

  it("rate limit → wait-before-retry", () => {
    const out = `${OPENER}\nThere were too many certificates already issued for exact set of domains`;
    const s = summarizeCertbotFailure(out, "hekai.org");
    expect(s).toMatch(/rate limit/i);
  });

  it("unstructured output → surfaces the tail, not the opener", () => {
    const out = `${OPENER}\nSome other unexpected certbot explosion happened here`;
    const s = summarizeCertbotFailure(out, "hekai.org");
    expect(s).toContain("unexpected certbot explosion");
    expect(s).not.toBe(OPENER);
  });

  it("empty output → still names the domain", () => {
    expect(summarizeCertbotFailure("", "hekai.org")).toContain("hekai.org");
  });
});
