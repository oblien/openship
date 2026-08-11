import { describe, expect, it, vi } from "vitest";
import { collectProxyCerts, edgeProxyFor } from "./api";
import { makeTestCert } from "./test-certs";
import type { CommandExecutor } from "../../types";
import type { ImportedSite } from "../types";

// The read api that replaced "assemble probeEdge + importSites + your own cert
// reader at the call site". These cover the seams the five old callers needed:
// per-host vhost lookup, per-host cert, and the by-port index.

const NGINX_CONF = (certPath: string, keyPath: string) => `
server {
  listen 443 ssl;
  server_name a.com www.a.com;
  ssl_certificate ${certPath};
  ssl_certificate_key ${keyPath};
  location / { proxy_pass http://127.0.0.1:3000; }
}
server {
  listen 80;
  server_name plain.com;
  location / { proxy_pass http://127.0.0.1:4000; }
}
`;

function exec(opts: { conf?: string; files?: Record<string, string> } = {}): CommandExecutor {
  return {
    exec: vi.fn(async (cmd: string) => (cmd.includes("nginx -T") ? (opts.conf ?? "") : "")),
    readFile: vi.fn(async (p: string) => {
      const hit = opts.files?.[p];
      if (hit === undefined) throw new Error("enoent");
      return hit;
    }),
  } as unknown as CommandExecutor;
}

describe("edgeProxyFor", () => {
  it("finds the vhost answering for a host, by any of its server_names", async () => {
    const api = edgeProxyFor(exec({ conf: NGINX_CONF("/c.pem", "/k.pem") }), "nginx");
    expect((await api.siteFor("a.com"))?.serverNames).toContain("a.com");
    expect((await api.siteFor("www.a.com"))?.serverNames).toContain("a.com");
    expect(await api.siteFor("nope.com")).toBeNull();
  });

  it("indexes sites by the upstream host port they forward to", async () => {
    const api = edgeProxyFor(exec({ conf: NGINX_CONF("/c.pem", "/k.pem") }), "nginx");
    const byPort = await api.sitesByPort();
    expect(byPort.get(3000)?.[0].domains).toContain("a.com");
    expect(byPort.get(4000)?.[0].domains).toContain("plain.com");
  });

  it("scans ONCE no matter how many questions are asked", async () => {
    const e = exec({ conf: NGINX_CONF("/c.pem", "/k.pem") });
    const api = edgeProxyFor(e, "nginx");
    await Promise.all([api.listSites(), api.siteFor("a.com"), api.sitesByPort()]);
    const scans = (e.exec as ReturnType<typeof vi.fn>).mock.calls.filter((c) =>
      String(c[0]).includes("nginx -T"),
    );
    expect(scans).toHaveLength(1);
  });

  it("returns the declared cert for a host it covers", async () => {
    const cert = makeTestCert(["a.com", "www.a.com"]);
    const api = edgeProxyFor(
      exec({
        conf: NGINX_CONF("/c.pem", "/k.pem"),
        files: { "/c.pem": cert.certPem, "/k.pem": cert.keyPem },
      }),
      "nginx",
    );
    const got = await api.certFor("a.com");
    expect(got?.certPem).toBe(cert.certPem);
    expect(got?.covers).toContain("www.a.com");
  });

  it("declines a cert that doesn't cover the host, and says why", async () => {
    // The vhost names two hosts; the cert only covers one.
    const cert = makeTestCert(["a.com"]);
    const api = edgeProxyFor(
      exec({
        conf: `server {
          listen 443 ssl; server_name a.com b.com;
          ssl_certificate /c.pem; ssl_certificate_key /k.pem;
          location / { proxy_pass http://127.0.0.1:3000; } }`,
        files: { "/c.pem": cert.certPem, "/k.pem": cert.keyPem },
      }),
      "nginx",
    );
    expect(await api.certFor("a.com")).not.toBeNull();
    expect(await api.certFor("b.com")).toBeNull();
    expect((await api.certCandidateFor("b.com")).reason).toContain("not b.com");
  });

  it("reports no certificate for a host with no cert at all", async () => {
    const api = edgeProxyFor(exec({ conf: NGINX_CONF("/c.pem", "/k.pem") }), "nginx");
    const r = await api.certCandidateFor("plain.com");
    expect(r.cert).toBeNull();
    expect(r.reason).toContain("no certificate found");
  });

  it("has no cert source for a takeover-only proxy", async () => {
    expect(await edgeProxyFor(exec(), "haproxy").certFor("a.com")).toBeNull();
  });

  /**
   * The live read-back (drift badge, adopt-live, migrate carry) all read the tunables
   * through THIS surface, so the values it hands back have to be the ones actually
   * serving traffic. A host with both an :80 helper and a :443 block is the normal
   * shape, and reporting the helper's defaults would show permanent false drift.
   */
  const DUAL = `
server {
  listen 80;
  server_name dual.com;
  client_max_body_size 1m;
  location / { proxy_pass http://127.0.0.1:5000; }
}
server {
  listen 443 ssl;
  server_name dual.com;
  ssl_certificate /c.pem;
  ssl_certificate_key /k.pem;
  client_max_body_size 50m;
  proxy_read_timeout 300s;
  location / { proxy_pass http://127.0.0.1:5000; }
}
`;

  it("reads the tunables the vhost is serving", async () => {
    const api = edgeProxyFor(exec({ conf: NGINX_CONF("/c.pem", "/k.pem") }), "nginx");
    // Nothing tuned in the fixture — absent, not an empty object.
    expect((await api.siteFor("a.com"))?.proxy).toBeUndefined();
  });

  it("prefers the TLS vhost's tunables when a host has both an :80 and a :443 block", async () => {
    const api = edgeProxyFor(exec({ conf: DUAL }), "nginx");
    const site = await api.siteFor("dual.com");
    expect(site?.ssl).toBe(true);
    expect(site?.proxy).toEqual({ clientMaxBodySize: "50m", proxyReadTimeout: "300s" });
  });

  it("carries the TLS vhost's tunables through the by-port index too", async () => {
    // The migrate/import join reads the port index, not siteFor — same precedence.
    const api = edgeProxyFor(exec({ conf: DUAL }), "nginx");
    const entry = (await api.sitesByPort()).get(5000)?.[0];
    expect(entry?.proxy).toEqual({ clientMaxBodySize: "50m", proxyReadTimeout: "300s" });
  });
});

describe("collectProxyCerts", () => {
  const site = (names: string[], ssl = true): ImportedSite => ({
    serverNames: names,
    ssl,
    target: { kind: "proxy", url: "http://127.0.0.1:3000" },
  });

  it("keys harvested certs by HOSTNAME so path-less proxies can carry them", async () => {
    const cert = makeTestCert(["a.com"]);
    const api = {
      certCandidateFor: vi.fn(async (h: string) =>
        h === "a.com"
          ? { cert: { certPem: cert.certPem, keyPem: cert.keyPem } }
          : { cert: null, reason: `${h}: nothing` },
      ),
    } as never;
    const { certPems, warnings } = await collectProxyCerts(api, [site(["a.com", "b.com"])]);
    expect(Object.keys(certPems)).toEqual(["a.com"]);
    expect(warnings.some((w) => w.includes("b.com"))).toBe(true);
  });

  it("skips non-TLS sites entirely (nothing to carry)", async () => {
    const api = { certCandidateFor: vi.fn() } as never;
    const { certPems } = await collectProxyCerts(api, [site(["a.com"], false)]);
    expect(certPems).toEqual({});
    expect((api as { certCandidateFor: ReturnType<typeof vi.fn> }).certCandidateFor)
      .not.toHaveBeenCalled();
  });
});
