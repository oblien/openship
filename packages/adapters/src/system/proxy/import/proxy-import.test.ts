import { describe, expect, test } from "vitest";
import type { CommandExecutor } from "../../../types";
import { scanNginx } from "./nginx";
import { scanCaddy } from "./caddy";
import { scanApache } from "./apache";

function makeExecutor(rules: Array<[string, string]>): CommandExecutor {
  return {
    exec: async (cmd: string) => {
      for (const [needle, out] of rules) if (cmd.includes(needle)) return out;
      return "";
    },
  } as unknown as CommandExecutor;
}

describe("scanNginx", () => {
  test("parses proxy + static server blocks with TLS and wildcards", async () => {
    const conf = `
      server {
        listen 80;
        server_name example.com www.example.com;
        location / { proxy_pass http://127.0.0.1:3000; }
      }
      server {
        listen 443 ssl;
        server_name static.example.com *.wild.example.com;
        root /var/www/static;
        ssl_certificate /etc/ssl/x.crt;
        ssl_certificate_key /etc/ssl/x.key;
      }
    `;
    const res = await scanNginx(makeExecutor([["nginx -T", conf]]));
    expect(res.sites).toHaveLength(2);

    const proxy = res.sites[0];
    expect(proxy.target).toEqual({ kind: "proxy", url: "http://127.0.0.1:3000" });
    expect(proxy.serverNames).toEqual(["example.com", "www.example.com"]);
    expect(proxy.ssl).toBe(false);

    const stat = res.sites[1];
    expect(stat.target).toEqual({ kind: "static", root: "/var/www/static" });
    expect(stat.ssl).toBe(true);
    expect(stat.tls).toEqual({ certPath: "/etc/ssl/x.crt", keyPath: "/etc/ssl/x.key" });
    // wildcard server_name is kept as a name but filtered at registration time
    expect(stat.serverNames).toContain("static.example.com");
  });

  test("warns when no config is readable", async () => {
    const res = await scanNginx(makeExecutor([]));
    expect(res.sites).toHaveLength(0);
    expect(res.warnings.length).toBeGreaterThan(0);
  });

  test("resolves proxy_pass to a declared upstream, rejects an undeclared one", async () => {
    const conf = `
      upstream api { server 127.0.0.1:9000; server 127.0.0.1:9001; }
      server { server_name good.example.com; location / { proxy_pass http://api; } }
      server { server_name bad.example.com; location / { proxy_pass http://ghost; } }
      server { server_name var.example.com; location / { proxy_pass http://$backend; } }
    `;
    const res = await scanNginx(makeExecutor([["nginx -T", conf]]));
    const good = res.sites.find((s) => s.serverNames.includes("good.example.com"));
    expect(good?.target).toEqual({ kind: "proxy", url: "http://127.0.0.1:9000" });
    // undeclared upstream + nginx variable are NOT migrated (would break openresty -t)
    expect(res.sites.some((s) => s.serverNames.includes("bad.example.com"))).toBe(false);
    expect(res.sites.some((s) => s.serverNames.includes("var.example.com"))).toBe(false);
    expect(res.warnings.some((w) => w.includes("ghost"))).toBe(true);
    expect(res.warnings.some((w) => w.includes("variable"))).toBe(true);
  });

  test("path-routing: keeps EVERY location upstream in `routes`, primary stays `/`", async () => {
    // `location /` is declared AFTER `/api` — the primary must still be `/`, and
    // the extra upstream is RETAINED (not dropped to a warning) so the edge can
    // path-route it.
    const conf = `
      server {
        server_name app.example.com;
        listen 443 ssl;
        location /api { proxy_pass http://127.0.0.1:9000; }
        location /    { proxy_pass http://127.0.0.1:3000; }
      }
    `;
    const res = await scanNginx(makeExecutor([["nginx -T", conf]]));
    expect(res.sites).toHaveLength(1);
    // primary = the root location, not the first-appearing one
    expect(res.sites[0].target).toEqual({ kind: "proxy", url: "http://127.0.0.1:3000" });
    // both upstreams are retained in source order, each with its path
    expect(res.sites[0].routes).toEqual([
      { path: "/api", url: "http://127.0.0.1:9000" },
      { path: "/", url: "http://127.0.0.1:3000" },
    ]);
    // no "re-add manually" warning anymore — nothing is dropped
    expect(res.warnings.find((x) => x.includes("path-routes"))).toBeUndefined();
  });

  test("nested if/location braces don't truncate the block", async () => {
    const conf = `
      server {
        server_name nested.example.com;
        location / {
          if ($request_method = POST) { return 405; }
          proxy_pass http://127.0.0.1:7000;
        }
      }
    `;
    const res = await scanNginx(makeExecutor([["nginx -T", conf]]));
    const site = res.sites.find((s) => s.serverNames.includes("nested.example.com"));
    expect(site?.target).toEqual({ kind: "proxy", url: "http://127.0.0.1:7000" });
  });

  test("redirect-only server (no proxy_pass / root) is skipped with a warning", async () => {
    const conf = `
      server {
        server_name redir.example.com;
        location / { return 301 https://elsewhere.example.com$request_uri; }
      }
    `;
    const res = await scanNginx(makeExecutor([["nginx -T", conf]]));
    expect(res.sites.some((s) => s.serverNames.includes("redir.example.com"))).toBe(false);
    expect(res.warnings.some((w) => w.includes("redir.example.com"))).toBe(true);
  });

  test("certbot HTTP→HTTPS stubs + the default catch-all are skipped SILENTLY", async () => {
    // The real shape of a certbot-managed nginx (the hekai box): per host a :443
    // vhost with the route and a :80 stub that only upgrades to HTTPS, plus one
    // default_server. Every route must be found and NOTHING may be reported as
    // "won't migrate" — that warning is how a clean scan looked broken.
    const hosts = [
      ["api.onvo.me", "http://localhost:1010"],
      ["onvo.me", "http://127.0.0.1:39801"],
      ["reflx.me", "http://localhost:3100"],
    ];
    const conf = `
      server { listen 80 default_server; server_name _; return 444; }
      ${hosts
        .map(
          ([host, up]) => `
        server {
          listen 80;
          server_name ${host};
          return 301 https://$host$request_uri;
        }
        server {
          listen 443 ssl;
          server_name ${host};
          ssl_certificate /etc/letsencrypt/live/${host}/fullchain.pem;
          ssl_certificate_key /etc/letsencrypt/live/${host}/privkey.pem;
          location / { proxy_pass ${up}; }
        }`,
        )
        .join("\n")}
    `;
    const res = await scanNginx(makeExecutor([["nginx -T", conf]]));

    expect(res.sites).toHaveLength(hosts.length);
    for (const [host, up] of hosts) {
      const site = res.sites.find((s) => s.serverNames.includes(host));
      // `localhost` is pinned to IPv4 on the way in — see the normalization test
      // below for why carrying it verbatim breaks.
      expect(site?.target).toEqual({
        kind: "proxy",
        url: up.replace("//localhost:", "//127.0.0.1:"),
      });
      expect(site?.ssl).toBe(true);
    }
    expect(res.warnings).toEqual([]);
  });

  test("pins a localhost upstream to IPv4 (nginx resolves localhost to ::1 first)", async () => {
    // Carried verbatim, this 502s against any app bound to IPv4 only:
    // `connect() failed (111: Connection refused) … upstream: http://[::1]:4000`.
    const conf = `
      server { listen 443 ssl; server_name a.example.com; location / { proxy_pass http://localhost:4000; } }
      server { listen 443 ssl; server_name b.example.com; location / { proxy_pass http://localhost:5000/api/; } }
      server { listen 443 ssl; server_name c.example.com; location / { proxy_pass http://127.0.0.1:6000; } }
    `;
    const res = await scanNginx(makeExecutor([["nginx -T", conf]]));

    const url = (host: string) =>
      (res.sites.find((s) => s.serverNames.includes(host))?.target as { url: string }).url;
    expect(url("a.example.com")).toBe("http://127.0.0.1:4000");
    // The path suffix survives the host rewrite.
    expect(url("b.example.com")).toBe("http://127.0.0.1:5000/api/");
    expect(url("c.example.com")).toBe("http://127.0.0.1:6000");
  });

  test("a certbot :80 helper never overwrites the real :443 site for the same host", async () => {
    // The shape that silently lost sites: the :80 half carries BOTH the ACME
    // webroot `root` and the redirect, so it used to parse as a STATIC site and
    // then win the one-file-per-host race against the real proxy vhost.
    const conf = `
      server {
        listen 80;
        server_name apistage.example.com;
        location /.well-known/acme-challenge/ { root /var/www/certbot; }
        return 301 https://$host$request_uri;
      }
      server {
        listen 443 ssl;
        server_name apistage.example.com;
        ssl_certificate /etc/letsencrypt/live/apistage.example.com/fullchain.pem;
        ssl_certificate_key /etc/letsencrypt/live/apistage.example.com/privkey.pem;
        location / { proxy_pass http://127.0.0.1:5002; }
      }
    `;
    const res = await scanNginx(makeExecutor([["nginx -T", conf]]));

    expect(res.sites).toHaveLength(1);
    expect(res.sites[0].ssl).toBe(true);
    expect(res.sites[0].target).toEqual({ kind: "proxy", url: "http://127.0.0.1:5002" });
    expect(res.sites[0].tls?.certPath).toContain("apistage.example.com");
  });

  test("an ACME-only webroot block is not migrated as a static site", async () => {
    // certbot's `--webroot-path` pointed at a nonexistent dir. Imported as a
    // static root it becomes a vhost whose try_files loops → 500.
    const conf = `
      server {
        listen 80;
        server_name www.example.com;
        root /var/lib/letsencrypt/http_01_nonexistent;
      }
    `;
    const res = await scanNginx(makeExecutor([["nginx -T", conf]]));
    expect(res.sites).toHaveLength(0);
  });

  test("Openship's own edge-target challenge vhost is not a site (IP or hostname)", async () => {
    // `_oblien-challenge-<slug>.conf` proves this box controls a routing target for
    // Openship Cloud's edge. Reading it as a site would surface it in the orphan
    // sweep, the domain-claim warning and the migrate importer — all three read this
    // classifier, which is why the fix belongs here and not in each of them.
    const conf = `
      server {
        listen 80;
        server_name 203.0.113.10;
        location /.well-known/oblien-proxy-challenge/ {
          root /var/www/acme/oblien;
          default_type text/plain;
          try_files $uri =404;
        }
      }
      server {
        listen 80;
        server_name edge.example.com;
        location /.well-known/oblien-proxy-challenge/ {
          root /var/www/acme/oblien;
          default_type text/plain;
          try_files $uri =404;
        }
      }
    `;
    const res = await scanNginx(makeExecutor([["nginx -T", conf]]));
    expect(res.sites).toHaveLength(0);
  });

  test("a literal same-host HTTPS upgrade is silent, a cross-host redirect still warns", async () => {
    const conf = `
      server { server_name self.example.com; return 301 https://self.example.com$request_uri; }
      server { server_name away.example.com; return 301 https://other.example.com$request_uri; }
    `;
    const res = await scanNginx(makeExecutor([["nginx -T", conf]]));
    expect(res.warnings.some((w) => w.includes("self.example.com"))).toBe(false);
    expect(res.warnings.some((w) => w.includes("away.example.com"))).toBe(true);
  });

  test("ssl detection: IPv6 :443 counts, 8443 does not false-positive", async () => {
    const conf = `
      server {
        listen 80;
        listen [::]:443 ssl;
        server_name six.example.com;
        location / { proxy_pass http://127.0.0.1:4000; }
      }
      server {
        listen 8443;
        server_name eight.example.com;
        location / { proxy_pass http://127.0.0.1:5000; }
      }
    `;
    const res = await scanNginx(makeExecutor([["nginx -T", conf]]));
    expect(res.sites.find((s) => s.serverNames.includes("six.example.com"))?.ssl).toBe(true);
    expect(res.sites.find((s) => s.serverNames.includes("eight.example.com"))?.ssl).toBe(false);
  });

  /**
   * A foreign vhost's reverse-proxy tunables are the difference between a migrated
   * site that still accepts a 50 MB upload and one that starts 413-ing the day it
   * moves. Two fields, deliberately:
   *
   *   `proxy`    — what we can adopt and re-render unchanged.
   *   `proxyRaw` — what the box is actually serving, verbatim, including values our
   *                own validators reject. Showing "not set" for a limit that IS set
   *                is the one lie the read-back must not tell.
   */
  test("carries the tunables a foreign vhost is serving", async () => {
    const conf = `
      server {
        listen 443 ssl;
        server_name limits.example.com;
        client_max_body_size 50m;
        proxy_read_timeout 300s;
        proxy_buffering off;
        gzip on;
        gzip_comp_level 6;
        ssl_certificate /etc/ssl/x.crt;
        ssl_certificate_key /etc/ssl/x.key;
        location / { proxy_pass http://127.0.0.1:3000; }
      }
    `;
    const res = await scanNginx(makeExecutor([["nginx -T", conf]]));
    const site = res.sites.find((s) => s.serverNames.includes("limits.example.com"))!;

    expect(site.proxy).toEqual({
      clientMaxBodySize: "50m",
      proxyReadTimeout: "300s",
      proxyBuffering: false,
      gzip: true,
      gzipCompLevel: 6,
    });
    expect(site.proxyRaw).toEqual({
      clientMaxBodySize: "50m",
      proxyReadTimeout: "300s",
      proxyBuffering: "off",
      gzip: "on",
      gzipCompLevel: "6",
    });
  });

  test("normalizes a value nginx accepts but our validators spell differently", async () => {
    // `20M` is valid nginx; our regex is lowercase. Normalizing on the way in is what
    // makes the value adoptable instead of unreadable.
    const conf = `
      server {
        listen 80;
        server_name upper.example.com;
        client_max_body_size 20M;
        location / { proxy_pass http://127.0.0.1:3000; }
      }
    `;
    const res = await scanNginx(makeExecutor([["nginx -T", conf]]));
    const site = res.sites[0]!;
    expect(site.proxy).toEqual({ clientMaxBodySize: "20m" });
    // Display keeps what the file says.
    expect(site.proxyRaw).toEqual({ clientMaxBodySize: "20M" });
  });

  test("shows an unrepresentable value without offering to adopt it", async () => {
    // `1d` and `2000` are legal nginx outside our curated grammar. Adopting them
    // would let the next save silently rewrite them into something else.
    const conf = `
      server {
        listen 80;
        server_name odd.example.com;
        client_max_body_size 512;
        proxy_read_timeout 1d;
        gzip_comp_level 42;
        location / { proxy_pass http://127.0.0.1:3000; }
      }
    `;
    const res = await scanNginx(makeExecutor([["nginx -T", conf]]));
    const site = res.sites[0]!;
    expect(site.proxy).toBeUndefined();
    expect(site.proxyRaw).toEqual({
      clientMaxBodySize: "512",
      proxyReadTimeout: "1d",
      gzipCompLevel: "42",
    });
  });

  test("leaves both fields off a vhost that tunes nothing", async () => {
    const conf = `
      server {
        listen 80;
        server_name plain.example.com;
        location / { proxy_pass http://127.0.0.1:3000; }
      }
    `;
    const res = await scanNginx(makeExecutor([["nginx -T", conf]]));
    expect(res.sites[0]!.proxy).toBeUndefined();
    expect(res.sites[0]!.proxyRaw).toBeUndefined();
  });

  test("does not confuse a directive with its longer namesake", async () => {
    // `gzip_types` must not read as `gzip`, and `proxy_busy_buffers_size` must not
    // read as `proxy_buffers` — a prefix match here would invent settings nobody set.
    const conf = `
      server {
        listen 80;
        server_name prefix.example.com;
        gzip_types text/plain;
        proxy_busy_buffers_size 32k;
        location / { proxy_pass http://127.0.0.1:3000; }
      }
    `;
    const res = await scanNginx(makeExecutor([["nginx -T", conf]]));
    expect(res.sites[0]!.proxy).toEqual({ proxyBusyBuffersSize: "32k" });
    expect(res.sites[0]!.proxyRaw).toEqual({ proxyBusyBuffersSize: "32k" });
  });
});

describe("scanCaddy", () => {
  test("parses reverse_proxy and root site blocks", async () => {
    const caddyfile = `
      example.com {
        reverse_proxy localhost:8080
      }
      static.example.com {
        root * /srv/www
        file_server
      }
      http://plain.example.com {
        reverse_proxy 127.0.0.1:9000
      }
    `;
    const res = await scanCaddy(makeExecutor([["/etc/caddy/Caddyfile", caddyfile]]));
    expect(res.sites).toHaveLength(3);
    expect(res.sites[0].target).toEqual({ kind: "proxy", url: "http://localhost:8080" });
    expect(res.sites[0].ssl).toBe(true);
    expect(res.sites[1].target).toEqual({ kind: "static", root: "/srv/www" });
    // http:// address → not TLS
    expect(res.sites[2].ssl).toBe(false);
  });

  test("parses a brace-less single-site Caddyfile (shorthand)", async () => {
    const caddyfile = "example.com\nreverse_proxy localhost:8080\n";
    const res = await scanCaddy(makeExecutor([["/etc/caddy/Caddyfile", caddyfile]]));
    expect(res.sites).toHaveLength(1);
    expect(res.sites[0].serverNames).toEqual(["example.com"]);
    expect(res.sites[0].target).toEqual({ kind: "proxy", url: "http://localhost:8080" });
  });

  test("prefers `caddy adapt` JSON (canonical config) over the text scan", async () => {
    const adapt = JSON.stringify({
      apps: {
        http: {
          servers: {
            srv0: {
              listen: [":443"],
              routes: [
                {
                  match: [{ host: ["example.com"] }],
                  handle: [
                    {
                      handler: "subroute",
                      routes: [
                        { handle: [{ handler: "reverse_proxy", upstreams: [{ dial: "localhost:8080" }] }] },
                      ],
                    },
                  ],
                },
                {
                  match: [{ host: ["static.example.com"] }],
                  handle: [
                    {
                      handler: "subroute",
                      routes: [
                        { handle: [{ handler: "vars", root: "/srv/www" }] },
                        { handle: [{ handler: "file_server" }] },
                      ],
                    },
                  ],
                },
              ],
            },
            srv1: {
              listen: [":80"],
              routes: [
                {
                  match: [{ host: ["plain.example.com"] }],
                  handle: [
                    {
                      handler: "subroute",
                      routes: [
                        { handle: [{ handler: "reverse_proxy", upstreams: [{ dial: "127.0.0.1:9000" }] }] },
                      ],
                    },
                  ],
                },
                // auto HTTP→HTTPS redirect — no proxy/root → must be skipped
                { match: [{ host: ["example.com"] }], handle: [{ handler: "static_response", status_code: 308 }] },
              ],
            },
          },
        },
      },
    });
    // `caddy adapt` listed FIRST so it wins over the Caddyfile text (proves precedence).
    const res = await scanCaddy(
      makeExecutor([
        ["caddy adapt", adapt],
        ["/etc/caddy/Caddyfile", "example.com { respond 200 }"],
      ]),
    );
    expect(res.sites).toHaveLength(3);
    const byHost = (h: string) => res.sites.find((s) => s.serverNames.includes(h));
    expect(byHost("example.com")?.target).toEqual({ kind: "proxy", url: "http://localhost:8080" });
    expect(byHost("example.com")?.ssl).toBe(true);
    expect(byHost("example.com")?.source).toBe("caddy (adapt)");
    expect(byHost("static.example.com")?.target).toEqual({ kind: "static", root: "/srv/www" });
    expect(byHost("plain.example.com")?.target).toEqual({ kind: "proxy", url: "http://127.0.0.1:9000" });
    expect(byHost("plain.example.com")?.ssl).toBe(false);
  });
});

describe("scanApache", () => {
  test("parses a VirtualHost with ProxyPass, aliases and SSL", async () => {
    const conf = `
      <VirtualHost *:443>
        ServerName app.example.com
        ServerAlias www.app.example.com
        ProxyPass / http://127.0.0.1:9000/
        SSLCertificateFile /etc/ssl/app.crt
        SSLCertificateKeyFile /etc/ssl/app.key
      </VirtualHost>
    `;
    const res = await scanApache(makeExecutor([["sites-enabled", conf]]));
    expect(res.sites).toHaveLength(1);
    const site = res.sites[0];
    expect(site.target).toEqual({ kind: "proxy", url: "http://127.0.0.1:9000/" });
    expect(site.serverNames).toEqual(["app.example.com", "www.app.example.com"]);
    expect(site.ssl).toBe(true);
    expect(site.tls).toEqual({ certPath: "/etc/ssl/app.crt", keyPath: "/etc/ssl/app.key" });
  });

  test("collects aliases across multiple ServerAlias lines", async () => {
    const conf = `
      <VirtualHost *:80>
        ServerName example.com
        ServerAlias www.example.com
        ServerAlias example.net
        ServerAlias www.example.net
        ProxyPass / http://127.0.0.1:8080/
      </VirtualHost>
    `;
    const res = await scanApache(makeExecutor([["sites-enabled", conf]]));
    expect(res.sites[0].serverNames).toEqual([
      "example.com",
      "www.example.com",
      "example.net",
      "www.example.net",
    ]);
  });

  test("discovers vhost files via `apachectl -S` (Include-resolved, non-standard path)", async () => {
    // The vhost lives in sites-AVAILABLE — a path the cat-fallback never reads,
    // so this can only pass via the `apachectl -S` file discovery.
    const dump = [
      "VirtualHost configuration:",
      "*:443    app.example.com (/etc/apache2/sites-available/custom.conf:1)",
    ].join("\n");
    const vhost = `
      <VirtualHost *:443>
        ServerName app.example.com
        ProxyPass / http://127.0.0.1:9100/
        SSLCertificateFile /etc/ssl/app.crt
        SSLCertificateKeyFile /etc/ssl/app.key
      </VirtualHost>
    `;
    const res = await scanApache(
      makeExecutor([
        ["-S", dump],
        ["/etc/apache2/sites-available/custom.conf", vhost],
      ]),
    );
    expect(res.sites).toHaveLength(1);
    expect(res.sites[0].serverNames).toEqual(["app.example.com"]);
    expect(res.sites[0].target).toEqual({ kind: "proxy", url: "http://127.0.0.1:9100/" });
    expect(res.sites[0].ssl).toBe(true);
    expect(res.sites[0].tls).toEqual({ certPath: "/etc/ssl/app.crt", keyPath: "/etc/ssl/app.key" });
  });
});
