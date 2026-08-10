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

  it("525 → Cloudflare answered the challenge itself, and names the three fixes", () => {
    // Cloudflare redirected the plain-HTTP challenge to https ("Always Use HTTPS"),
    // then couldn't complete TLS to origin. Reported as an "Invalid response", so
    // this MUST win over the 404/proxy-on-:80 branch — the fix is entirely different.
    const out = `${OPENER}
  Type:   unauthorized
  Detail: 104.21.5.7: Invalid response from https://app.example.xyz/.well-known/acme-challenge/abc: 525`;
    const s = summarizeCertbotFailure(out, "app.example.xyz");
    expect(s).toMatch(/cloudflare/i);
    expect(s).toMatch(/full/i);
    expect(s).not.toMatch(/takeover/i);
  });

  it("526 → same Cloudflare guidance (Full (strict) rejecting the temporary cert)", () => {
    const out = `${OPENER}\n  Detail: Invalid response from https://app.example.xyz/.well-known/acme-challenge/abc: 526`;
    expect(summarizeCertbotFailure(out, "app.example.xyz")).toMatch(/cloudflare/i);
  });

  it("404 over HTTPS → the request was redirected, NOT take-over", () => {
    // Same status as the case above, opposite remediation, and the scheme is the only
    // thing that separates them. Let's Encrypt always REQUESTS http://; an https:// URL
    // in the failure means something redirected it, so the answer came from :443 and
    // nothing was learned about :80 — offering take-over / migrate there would rewrite
    // a working proxy config for a cause it cannot fix.
    //
    // #431 is what makes this common: for a hostname the box doesn't route, the :443
    // catch-all used to refuse the handshake (525, caught by the branch above) and now
    // completes it and answers with the "service not found" page — a 404.
    const out = `${OPENER}
  Type:   unauthorized
  Detail: 65.109.55.23: Invalid response from https://app.example.xyz/.well-known/acme-challenge/abc: 404`;
    const s = summarizeCertbotFailure(out, "app.example.xyz");
    expect(s).toContain("app.example.xyz");
    expect(s).toMatch(/redirected/i);
    // It may NAME take-over, but only to rule it out — never as the remediation the
    // plain-HTTP 404 branch prescribes.
    expect(s).toMatch(/will not help/i);
    expect(s).not.toMatch(/choose take-over/i);
  });

  it("does NOT prescribe Cloudflare SSL-mode surgery just because the output says cloudflare", () => {
    // The 52x branch used to match the bare word: certbot's own --dns-cloudflare plugin
    // text, or a CF page carrying any status at all, got "set SSL/TLS to Full" as the
    // diagnosis for an unrelated failure. It matches the STATUS now.
    const out = `${OPENER}
Plugins selected: Authenticator dns-cloudflare, Installer None
  Type:   dns
  Detail: DNS problem: NXDOMAIN looking up A for app.example.xyz`;
    const s = summarizeCertbotFailure(out, "app.example.xyz");
    expect(s).toMatch(/doesn't resolve|DNS/i);
    expect(s).not.toMatch(/Full \(strict\)|orange cloud/i);
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

  it("edge container down → surfaces the executor's explanation WHOLE", () => {
    // certbot never ran: the `docker exec` that would have started it was refused
    // because the edge is crash-looping, and the executor already explained why in one
    // line. No certbot lens applies — and the tail fallback would chop that explanation
    // into fragments joined by " · ", which is how the useful half gets lost.
    const explanation =
      `the edge container is not running ("openship-edge") (restarting) — it is crash-looping, ` +
      `so nothing that runs through the edge on this server can work — certificate issuance, ` +
      `config reloads and route changes all go through it. OpenResty is refusing to start: ` +
      `cannot load certificate "/etc/letsencrypt/live/hekai.org/fullchain.pem". Fix that, then ` +
      "`docker start openship-edge` and retry.";
    const out = `${OPENER}\nRequesting a certificate for hekai.org\n${explanation}\nError response from daemon: Container b896 is restarting, wait until the container is running`;

    expect(summarizeCertbotFailure(out, "hekai.org")).toBe(explanation);
  });
});
