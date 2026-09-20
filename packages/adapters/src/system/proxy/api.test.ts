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
  it("strictly inventories every loopback port dialled by our edge", async () => {
    const ownEdge = {
      exec: vi.fn(async (cmd: string) => {
        if (cmd.includes("openresty -T")) {
          return `server {
              listen 80;
              server_name app.example.com;
              location / { proxy_pass http://127.0.0.1:23000; }
              location /api { proxy_pass http://127.0.0.2:24000; }
              location /remote { proxy_pass http://10.0.0.9:25000; }
            }
            server {
              listen 80 default_server;
              server_name _;
              location / { proxy_pass http://127.0.0.1:26000; }
            }
            server {
              listen 80;
              server_name ~^tenant-[0-9]+\\.example\\.com$;
              location / { proxy_pass http://127.0.0.1:27000; }
            }`;
        }
        if (cmd.includes("docker ps -a")) {
          return "openship-edge\tghcr.io/openship/edge:latest\trunning";
        }
        return "";
      }),
    } as unknown as CommandExecutor;
    const api = edgeProxyFor(ownEdge, "openresty", {
      ours: true,
      container: "openship-edge",
    });

    expect(await api.listLoopbackUpstreamPortsStrict()).toEqual(
      new Set([23_000, 24_000, 26_000, 27_000]),
    );
  });

  it("can replace the memoized strict inventory with a fresh post-write scan", async () => {
    let configDump = 0;
    const ownEdge = {
      exec: vi.fn(async (cmd: string) => {
        if (cmd.includes("openresty -T")) {
          configDump += 1;
          const port = configDump === 1 ? 23_000 : 24_000;
          return `server {
            listen 80;
            server_name app.example.com;
            location / { proxy_pass http://127.0.0.1:${port}; }
          }`;
        }
        if (cmd.includes("docker ps -a")) {
          return "openship-edge\tghcr.io/openship/edge:latest\trunning";
        }
        return "";
      }),
    } as unknown as CommandExecutor;
    const api = edgeProxyFor(ownEdge, "openresty", {
      ours: true,
      container: "openship-edge",
    });

    expect(await api.listLoopbackUpstreamPortsStrict()).toEqual(new Set([23_000]));
    expect(await api.listLoopbackUpstreamPortsStrict()).toEqual(new Set([23_000]));
    expect(configDump).toBe(1);

    expect(await api.listLoopbackUpstreamPortsStrict({ refresh: true })).toEqual(new Set([24_000]));
    expect(configDump).toBe(2);
    expect(await api.listLoopbackUpstreamPortsStrict()).toEqual(new Set([24_000]));
  });

  it("never falls back to a stale strict inventory when a forced refresh fails", async () => {
    let rejectDump = false;
    const ownEdge = {
      exec: vi.fn(async (cmd: string) => {
        if (cmd.includes("openresty -T")) {
          if (rejectDump) throw new Error("edge config unreadable");
          return `server {
            listen 80;
            server_name app.example.com;
            location / { proxy_pass http://127.0.0.1:23000; }
          }`;
        }
        if (cmd.includes("docker ps -a")) {
          return "openship-edge\tghcr.io/openship/edge:latest\trunning";
        }
        return "";
      }),
    } as unknown as CommandExecutor;
    const api = edgeProxyFor(ownEdge, "openresty", {
      ours: true,
      container: "openship-edge",
    });

    expect(await api.listLoopbackUpstreamPortsStrict()).toEqual(new Set([23_000]));
    rejectDump = true;
    await expect(api.listLoopbackUpstreamPortsStrict({ refresh: true })).rejects.toThrow(
      "edge config unreadable",
    );
    await expect(api.listLoopbackUpstreamPortsStrict()).rejects.toThrow("edge config unreadable");
  });

  it("inventories every loopback member of a named upstream group", async () => {
    const ownEdge = {
      exec: vi.fn(async (cmd: string) => {
        if (cmd.includes("openresty -T")) {
          return `upstream app_pool {
              server 127.0.0.1:23000;
              server 127.0.0.2:24000 backup;
              server 10.0.0.9:25000;
            }
            server {
              listen 80;
              server_name app.example.com;
              location / { proxy_pass http://app_pool; }
            }`;
        }
        if (cmd.includes("docker ps -a")) {
          return "openship-edge\tghcr.io/openship/edge:latest\trunning";
        }
        return "";
      }),
    } as unknown as CommandExecutor;
    const api = edgeProxyFor(ownEdge, "openresty", {
      ours: true,
      container: "openship-edge",
    });

    expect(await api.listLoopbackUpstreamPortsStrict()).toEqual(new Set([23_000, 24_000]));
  });

  it("rejects an inconclusive own-edge inventory while normal reads stay fail-soft", async () => {
    const dead = {
      exec: vi.fn(async () => {
        throw new Error("ssh timeout");
      }),
    } as unknown as CommandExecutor;
    const api = edgeProxyFor(dead, "openresty", { ours: true });

    await expect(api.listLoopbackUpstreamPortsStrict()).rejects.toThrow(
      "neither Docker nor bare OpenResty inventory",
    );
    expect((await api.listSites()).sites).toEqual([]);
  });

  it("refuses to treat a host with no Openship edge as an empty inventory", async () => {
    const emptyHost = { exec: vi.fn(async () => "") } as unknown as CommandExecutor;
    const api = edgeProxyFor(emptyHost, "openresty", { ours: true });

    await expect(api.listLoopbackUpstreamPortsStrict()).rejects.toThrow(
      "no running Openship edge or bare OpenResty inventory",
    );
    expect(
      (emptyHost.exec as ReturnType<typeof vi.fn>).mock.calls.some(([cmd]) =>
        String(cmd).includes("docker ps -a"),
      ),
    ).toBe(true);
  });

  it("does not trust leftover Openship vhosts when no Openship edge is running", async () => {
    const staleFiles = {
      exec: vi.fn(async (cmd: string) => {
        if (cmd.includes("if [ -e")) return NGINX_CONF("/c.pem", "/k.pem");
        if (cmd.includes("docker ps -a")) return "";
        return "";
      }),
    } as unknown as CommandExecutor;
    const api = edgeProxyFor(staleFiles, "openresty", { ours: true });

    await expect(api.listLoopbackUpstreamPortsStrict()).rejects.toThrow(
      "no running Openship edge or bare OpenResty inventory",
    );
  });

  it("rejects a dynamic proxy_pass instead of silently omitting a possible loopback route", async () => {
    const dynamic = {
      exec: vi.fn(async (cmd: string) => {
        if (cmd.includes("openresty -T")) {
          return (
            "server { listen 80; server_name app.example.com; " +
            "location / { proxy_pass http://$backend; } }"
          );
        }
        if (cmd.includes("docker ps -a")) {
          return "openship-edge\tghcr.io/openship/edge:latest\trunning";
        }
        return "";
      }),
    } as unknown as CommandExecutor;
    const api = edgeProxyFor(dynamic, "openresty", { ours: true });

    await expect(api.listLoopbackUpstreamPortsStrict()).rejects.toThrow("uses an nginx variable");
  });

  it("keeps a variable port fail-closed even when the request URI is concrete", async () => {
    const dynamicPort = {
      exec: vi.fn(async (cmd: string) => {
        if (cmd.includes("openresty -T")) {
          return `server {
            listen 80;
            server_name dashboard.example.com;
            location /terminal/ {
              proxy_pass http://127.0.0.1:$backend_port/terminal/;
            }
          }`;
        }
        if (cmd.includes("docker ps -a")) {
          return "openship-edge\tghcr.io/openship/edge:latest\trunning";
        }
        return "";
      }),
    } as unknown as CommandExecutor;
    const api = edgeProxyFor(dynamicPort, "openresty", {
      ours: true,
      container: "openship-edge",
    });

    await expect(api.listLoopbackUpstreamPortsStrict()).rejects.toThrow("uses an nginx variable");
  });

  it("inventories a concrete loopback upstream when only its request URI uses variables", async () => {
    const uriVariables = {
      exec: vi.fn(async (cmd: string) => {
        if (cmd.includes("openresty -T")) {
          return `server {
            listen 80;
            server_name dashboard.example.com;
            location ~ ^/terminal/(.*)$ {
              proxy_pass http://127.0.0.1:4000/$1$is_args$args;
            }
          }`;
        }
        if (cmd.includes("docker ps -a")) {
          return "openship-edge\tghcr.io/openship/edge:latest\trunning";
        }
        return "";
      }),
    } as unknown as CommandExecutor;
    const api = edgeProxyFor(uriVariables, "openresty", {
      ours: true,
      container: "openship-edge",
    });

    expect(await api.listLoopbackUpstreamPortsStrict()).toEqual(new Set([4_000]));
  });

  it("inventories a concrete loopback upstream when a query-only URI uses variables", async () => {
    const queryVariables = {
      exec: vi.fn(async (cmd: string) => {
        if (cmd.includes("openresty -T")) {
          return `server {
            listen 80;
            server_name dashboard.example.com;
            location /terminal/ {
              proxy_pass http://127.0.0.1:4100?next=$request_uri;
            }
          }`;
        }
        if (cmd.includes("docker ps -a")) {
          return "openship-edge\tghcr.io/openship/edge:latest\trunning";
        }
        return "";
      }),
    } as unknown as CommandExecutor;
    const api = edgeProxyFor(queryVariables, "openresty", {
      ours: true,
      container: "openship-edge",
    });

    expect(await api.listLoopbackUpstreamPortsStrict()).toEqual(new Set([4_100]));
  });

  it("strictly scans a bare OpenResty edge when Docker inventory is unavailable", async () => {
    const bare = {
      exec: vi.fn(async (cmd: string) => {
        if (cmd.includes("if [ -e")) return "";
        if (cmd.includes("docker ps -a")) throw new Error("docker: command not found");
        if (cmd.includes("openresty -T")) return NGINX_CONF("/c.pem", "/k.pem");
        return "";
      }),
    } as unknown as CommandExecutor;
    const api = edgeProxyFor(bare, "openresty", { ours: true });

    expect(await api.listLoopbackUpstreamPortsStrict()).toEqual(new Set([3_000, 4_000]));
  });

  it("strictly scans bare OpenResty when Docker proves there is no edge container", async () => {
    const bare = {
      exec: vi.fn(async (cmd: string) => {
        if (cmd.includes("if [ -e")) return "";
        if (cmd.includes("docker ps -a")) return "";
        if (cmd.includes("openresty -T")) return NGINX_CONF("/c.pem", "/k.pem");
        return "";
      }),
    } as unknown as CommandExecutor;
    const api = edgeProxyFor(bare, "openresty", { ours: true });

    expect(await api.listLoopbackUpstreamPortsStrict()).toEqual(new Set([3_000, 4_000]));
  });

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
    expect(
      (api as { certCandidateFor: ReturnType<typeof vi.fn> }).certCandidateFor,
    ).not.toHaveBeenCalled();
  });
});
