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

  test("path-routing: migrates the root location, warns about extra upstreams (no silent collapse)", async () => {
    // `location /` is declared AFTER `/api` — the primary must still be `/`.
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
    // the /api upstream is NOT dropped silently — it's surfaced as a warning
    const w = res.warnings.find((x) => x.includes("path-routes"));
    expect(w).toBeTruthy();
    expect(w).toContain("/api");
    expect(w).toContain("http://127.0.0.1:9000");
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
