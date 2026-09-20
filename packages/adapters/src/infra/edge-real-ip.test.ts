import { describe, it, expect, afterEach } from "vitest";
import {
  CLOUD_EDGE_REAL_IP_HEADER,
  cloudEdgeRealIpConf,
  edgeRealIpConf,
  edgeRealIpHeader,
  edgeTrustedProxies,
  isCloudFrontedHost,
} from "./edge-real-ip";
import { CLOUDFLARE_IPV4, CLOUDFLARE_IPV6 } from "./cloudflare-ips.generated";
import { bakedEdgeNginxConf } from "./edge-baked-conf";

const ENV_KEYS = ["OPENSHIP_EDGE_REAL_IP_HEADER", "OPENSHIP_EDGE_TRUSTED_PROXIES"] as const;

afterEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
});

describe("which header names the client", () => {
  it("defaults to CF-Connecting-IP, not X-Forwarded-For", () => {
    // This is the difference between spoofable and not. Cloudflare OVERWRITES
    // CF-Connecting-IP but APPENDS to X-Forwarded-For, so XFF arrives partly under client
    // control and a left-to-right read lets a visitor choose their own apparent address —
    // and with it their rate-limit bucket and which ban rules miss them.
    expect(edgeRealIpHeader()).toBe("CF-Connecting-IP");
  });

  it("lets an operator name their own proxy's header", () => {
    process.env.OPENSHIP_EDGE_REAL_IP_HEADER = "X-Forwarded-For";
    expect(edgeRealIpHeader()).toBe("X-Forwarded-For");
  });

  it("refuses a header value that could close the directive and inject another", () => {
    // The value is concatenated into nginx config. An env var is a lower bar than a
    // socket, but it is still not a place to interpolate unvalidated text.
    for (const attack of [
      "X-Real-IP;\n    set_real_ip_from 0.0.0.0/0",
      "X Real IP",
      "X-Real-IP}",
      "a".repeat(200),
      "",
    ]) {
      process.env.OPENSHIP_EDGE_REAL_IP_HEADER = attack;
      expect(edgeRealIpHeader()).toBe("CF-Connecting-IP");
    }
  });
});

describe("the trusted-proxy list", () => {
  it("is empty unless the operator declares one", () => {
    expect(edgeTrustedProxies()).toEqual([]);
  });

  it("accepts comma- or whitespace-separated v4 and v6 CIDRs", () => {
    process.env.OPENSHIP_EDGE_TRUSTED_PROXIES = "10.0.0.0/8, 192.168.1.1\n2001:db8::/32";
    expect(edgeTrustedProxies()).toEqual(["10.0.0.0/8", "192.168.1.1", "2001:db8::/32"]);
  });

  it("drops a malformed entry rather than emitting it", () => {
    // A bad token fails `nginx -t`, and a failed test means the reload is REFUSED — so one
    // typo in an env var would wedge every route on the box, not just misconfigure trust.
    process.env.OPENSHIP_EDGE_TRUSTED_PROXIES = "10.0.0.0/8, not-an-ip, ; rm -rf /, 1.2.3.4";
    expect(edgeTrustedProxies()).toEqual(["10.0.0.0/8", "1.2.3.4"]);
  });
});

describe("the emitted config", () => {
  it("trusts every published Cloudflare range and nothing else by default", () => {
    const conf = edgeRealIpConf();
    for (const cidr of [...CLOUDFLARE_IPV4, ...CLOUDFLARE_IPV6]) {
      expect(conf).toContain(`set_real_ip_from ${cidr};`);
    }
    const trusted = [...conf.matchAll(/^set_real_ip_from (\S+);$/gm)].map((m) => m[1]);
    expect(trusted).toHaveLength(CLOUDFLARE_IPV4.length + CLOUDFLARE_IPV6.length);
  });

  it("never trusts a catch-all", () => {
    process.env.OPENSHIP_EDGE_TRUSTED_PROXIES = "0.0.0.0/0";
    // 0.0.0.0/0 is a valid CIDR, so the validator passes it — but it would mean "believe
    // this header from anyone", i.e. hand every visitor a free choice of source address.
    // If we ever want to allow that it must be a deliberate, separate decision.
    const trusted = [...edgeRealIpConf().matchAll(/^set_real_ip_from (\S+);$/gm)].map((m) => m[1]);
    expect(trusted).not.toContain("::/0");
    expect(trusted.filter((t) => t === "0.0.0.0/0")).toHaveLength(1);
  });

  it("turns on recursive walking, which is what makes an appended header safe", () => {
    // Inert for single-value CF-Connecting-IP; load-bearing the moment an operator
    // switches to X-Forwarded-For, where the left-hand entries are client-supplied.
    expect(edgeRealIpConf()).toContain("real_ip_recursive on;");
  });

  it("explains itself in the file, for whoever is reading it inside a container", () => {
    const conf = edgeRealIpConf();
    expect(conf).toContain("does NOT mean");
    expect(conf).toMatch(/APPENDS/);
  });
});

describe("a host fronted by Openship Cloud's edge", () => {
  it("recognizes a free <slug>.opsh.io host and nothing else", () => {
    expect(isCloudFrontedHost("myapp.opsh.io")).toBe(true);
    expect(isCloudFrontedHost("MyApp-Web.OPSH.IO.")).toBe(true);
    // A custom domain is fronted by the operator's own DNS (or Cloudflare) and keeps
    // the http-scope CF-Connecting-IP block.
    expect(isCloudFrontedHost("app.example.com")).toBe(false);
    // The apex is not a routable free host, and a lookalike suffix must not match.
    expect(isCloudFrontedHost("opsh.io")).toBe(false);
    expect(isCloudFrontedHost("notopsh.io")).toBe(false);
    expect(isCloudFrontedHost("myapp.opsh.io.evil.com")).toBe(false);
  });

  it("reads X-Real-IP, because that is the header that front overwrites", () => {
    // CF-Connecting-IP is what the http-scope block reads, and Openship Cloud's edge
    // does not send it — inheriting that scope is why every free-domain visitor read as
    // the edge: one rate-limit bucket for the planet, bans that ban the edge, and one
    // country for everyone.
    const conf = cloudEdgeRealIpConf();
    expect(CLOUD_EDGE_REAL_IP_HEADER).toBe("X-Real-IP");
    expect(conf).toContain("real_ip_header X-Real-IP;");
    expect(conf).not.toContain("CF-Connecting-IP;");
  });

  it("trusts the header from ANY peer, because the edge's own address is unknowable here", () => {
    // The deliberate difference from the Cloudflare path. The Cloud edge reaches origins
    // from its own address; opsh.io's Cloudflare-proxied A records are the visitor→edge
    // leg and say nothing about it. A peer list that doesn't contain the real egress
    // address does not fail loudly — it ignores the header, and every free-domain visitor
    // stays logged as the edge, which is the bug this block exists to fix.
    const conf = cloudEdgeRealIpConf();
    expect(conf).toContain("set_real_ip_from 0.0.0.0/0;");
    expect(conf).toContain("set_real_ip_from ::/0;");
  });

  it("does not walk the header recursively", () => {
    // The front OVERWRITES X-Real-IP with one address, so there is no list to walk — and
    // "skip trusted addresses from the right" has no meaning once every address is trusted.
    expect(cloudEdgeRealIpConf()).toContain("real_ip_recursive off;");
  });

  it("says in the file what the blanket trust costs", () => {
    // A bare `set_real_ip_from 0.0.0.0/0` looks like a mistake to anyone reading the vhost
    // — including a future us. The reason it is scoped to this server_name, and what a
    // forged Host + forged header buys an attacker, has to travel WITH the directive.
    const conf = cloudEdgeRealIpConf();
    expect(conf).toContain("forged Host");
    expect(conf).toMatch(/do not widen this to them/);
  });

  it("ignores the operator's header override — this front is never their proxy", () => {
    // OPENSHIP_EDGE_REAL_IP_HEADER describes what the OPERATOR put in front of the box.
    // A *.opsh.io host is served by Cloud's edge whatever else is installed, so honouring
    // that value here would read a header nothing sets.
    process.env.OPENSHIP_EDGE_REAL_IP_HEADER = "True-Client-IP";
    expect(cloudEdgeRealIpConf()).toContain("real_ip_header X-Real-IP;");
  });

  it("indents every line so it can be dropped into a server block", () => {
    for (const line of cloudEdgeRealIpConf().split("\n").filter(Boolean)) {
      expect(line.startsWith("    ")).toBe(true);
    }
  });

  it("keeps the blanket trust OUT of the http-scope block", () => {
    // The one thing that must not leak. http scope covers every custom domain on the box,
    // where the peer list IS the security property: trusting any peer there would let a
    // visitor to any site pick their own rate-limit bucket and dodge IP bans.
    const http = edgeRealIpConf();
    expect(http).not.toContain("set_real_ip_from 0.0.0.0/0;");
    expect(http).not.toContain("set_real_ip_from ::/0;");
    expect(http).toContain(`set_real_ip_from ${CLOUDFLARE_IPV4[0]};`);
  });
});

describe("both install paths get it", () => {
  it("bakes the block into the container config inside http {}", () => {
    const conf = bakedEdgeNginxConf();
    const http = conf.slice(conf.indexOf("http {"));
    expect(http).toContain("real_ip_header CF-Connecting-IP;");
    expect(http).toContain(`set_real_ip_from ${CLOUDFLARE_IPV4[0]};`);
    // Must land in http {}, not inside one of the nested server blocks, or it would
    // apply to the ACME/default vhost only and every managed site would keep the proxy
    // address.
    expect(conf.indexOf("real_ip_header")).toBeLessThan(conf.indexOf("server {"));
  });
});
