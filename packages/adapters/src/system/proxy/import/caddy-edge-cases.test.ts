import { describe, expect, test } from "vitest";
import type { CommandExecutor } from "../../../types";
import { scanCaddy } from "./caddy";

/**
 * Caddy migration edge cases.
 *
 * The JSON fixtures below are the SHAPE `caddy adapt` really emits — captured from
 * a `caddy:2` container, not hand-idealised. Two of these bugs were invisible to
 * hand-written fixtures and only appeared against the real adapter:
 *
 *   • `handle_path /api/*` nests its proxy in a subroute whose matcher lives on the
 *     nested route. Flattening handlers dropped that matcher, and since the scoped
 *     proxy comes FIRST, the whole host was routed to its /api backend.
 *   • `php_fastcgi` adapts to a `reverse_proxy` with `transport.protocol=fastcgi`.
 *     Read as an HTTP upstream it produced a vhost where every request fails.
 */

/** Executor that answers `caddy adapt` with JSON, or the Caddyfile cat with text. */
const exec = (opts: { adapt?: unknown; caddyfile?: string }): CommandExecutor =>
  ({
    exec: async (cmd: string) => {
      if (cmd.includes("caddy adapt")) return opts.adapt ? JSON.stringify(opts.adapt) : "";
      if (cmd.includes("Caddyfile")) return opts.caddyfile ?? "";
      return "";
    },
  }) as unknown as CommandExecutor;

const httpsServer = (routes: unknown[]) => ({
  apps: { http: { servers: { srv0: { listen: [":443"], routes } } } },
});

const urlOf = (site: { target: unknown } | undefined) =>
  (site?.target as { url?: string; root?: string } | undefined)?.url;

describe("caddy adapt: subroute path scoping", () => {
  // Verbatim structure of `handle_path /api/* { reverse_proxy api:9000 }` beside a
  // top-level `reverse_proxy web:3000`.
  const pathRoute = {
    match: [{ host: ["paths.example.com"] }],
    handle: [
      {
        handler: "subroute",
        routes: [
          {
            match: [{ path: ["/api/*"] }],
            handle: [
              {
                handler: "subroute",
                routes: [
                  { handle: [{ handler: "rewrite", strip_path_prefix: "/api" }] },
                  { handle: [{ handler: "reverse_proxy", upstreams: [{ dial: "api:9000" }] }] },
                ],
              },
            ],
          },
          { handle: [{ handler: "reverse_proxy", upstreams: [{ dial: "web:3000" }] }] },
        ],
      },
    ],
  };

  test("uses the CATCH-ALL upstream, not the path-scoped one that comes first", async () => {
    const res = await scanCaddy(exec({ adapt: httpsServer([pathRoute]) }));
    expect(urlOf(res.sites[0])).toBe("http://web:3000");
  });

  test("warns that the path rules don't survive", async () => {
    const res = await scanCaddy(exec({ adapt: httpsServer([pathRoute]) }));
    expect(res.warnings.some((w) => w.includes("routes some paths"))).toBe(true);
  });

  test("a host with ONLY a path-scoped upstream is kept but flagged as a guess", async () => {
    const onlyScoped = {
      match: [{ host: ["api-only.example.com"] }],
      handle: [
        {
          handler: "subroute",
          routes: [
            {
              match: [{ path: ["/api/*"] }],
              handle: [{ handler: "reverse_proxy", upstreams: [{ dial: "api:9000" }] }],
            },
          ],
        },
      ],
    };
    const res = await scanCaddy(exec({ adapt: httpsServer([onlyScoped]) }));
    expect(urlOf(res.sites[0])).toBe("http://api:9000");
    expect(res.warnings.some((w) => w.includes("no catch-all upstream"))).toBe(true);
  });
});

describe("caddy adapt: handlers that aren't an HTTP upstream", () => {
  test("php_fastcgi (fastcgi transport) is refused, not proxied over HTTP", async () => {
    const res = await scanCaddy(
      exec({
        adapt: httpsServer([
          {
            match: [{ host: ["php.example.com"] }],
            handle: [
              {
                handler: "subroute",
                routes: [
                  { handle: [{ handler: "vars", root: "/srv/php" }] },
                  {
                    handle: [
                      {
                        handler: "reverse_proxy",
                        transport: { protocol: "fastcgi", split_path: [".php"] },
                        upstreams: [{ dial: "php:9000" }],
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ]),
      }),
    );
    expect(res.sites).toEqual([]);
    expect(res.warnings.some((w) => /PHP-FPM|FastCGI/i.test(w))).toBe(true);
  });

  test("a unix-socket upstream is refused rather than emitted as http://unix/…", async () => {
    const res = await scanCaddy(
      exec({
        adapt: httpsServer([
          {
            match: [{ host: ["sock.example.com"] }],
            handle: [{ handler: "reverse_proxy", upstreams: [{ dial: "unix//run/app.sock" }] }],
          },
        ]),
      }),
    );
    expect(res.sites).toEqual([]);
    expect(res.warnings.some((w) => w.includes("unix socket"))).toBe(true);
  });

  test("a respond-only site is named instead of silently vanishing", async () => {
    const res = await scanCaddy(
      exec({
        adapt: httpsServer([
          {
            match: [{ host: ["ok.example.com"] }],
            handle: [{ handler: "static_response", status_code: 200 }],
          },
        ]),
      }),
    );
    expect(res.sites).toEqual([]);
    expect(res.warnings.some((w) => w.includes("ok.example.com"))).toBe(true);
  });
});

describe("caddy adapt: load balancing and collisions", () => {
  test("multiple upstreams → first is migrated, with a warning", async () => {
    const res = await scanCaddy(
      exec({
        adapt: httpsServer([
          {
            match: [{ host: ["lb.example.com"] }],
            handle: [
              {
                handler: "reverse_proxy",
                upstreams: [{ dial: "app1:3000" }, { dial: "app2:3000" }],
              },
            ],
          },
        ]),
      }),
    );
    expect(urlOf(res.sites[0])).toBe("http://app1:3000");
    expect(res.warnings.some((w) => w.includes("load-balances across 2"))).toBe(true);
  });

  test("an http:// block beside the auto-HTTPS one keeps TLS", async () => {
    // Both carry a real handler, so both reach the collapse — and one vhost file
    // per host means the plain one could otherwise win.
    const res = await scanCaddy(
      exec({
        adapt: {
          apps: {
            http: {
              servers: {
                srv0: {
                  listen: [":443"],
                  routes: [
                    {
                      match: [{ host: ["dual.example.com"] }],
                      handle: [{ handler: "reverse_proxy", upstreams: [{ dial: "secure:443" }] }],
                    },
                  ],
                },
                srv1: {
                  listen: [":80"],
                  routes: [
                    {
                      match: [{ host: ["dual.example.com"] }],
                      handle: [{ handler: "reverse_proxy", upstreams: [{ dial: "plain:80" }] }],
                    },
                  ],
                },
              },
            },
          },
        },
      }),
    );
    expect(res.sites).toHaveLength(1);
    expect(res.sites[0].ssl).toBe(true);
    expect(urlOf(res.sites[0])).toBe("http://secure:443");
  });
});

describe("caddy admin API (layout-independent)", () => {
  test("reads the running config from localhost:2019 when no Caddyfile is at a fixed path", async () => {
    // The fragility fix: a box configured any way other than a Caddyfile at
    // /etc/caddy/Caddyfile — imported snippets, an API-pushed config, a non-default
    // path — has nothing for `caddy adapt --config <fixed>` to read, so it scanned
    // as zero sites. The admin endpoint reports the live server regardless.
    const running = httpsServer([
      {
        match: [{ host: ["live.example.com"] }],
        handle: [{ handler: "reverse_proxy", upstreams: [{ dial: "app:8080" }] }],
      },
    ]);
    const exec = {
      exec: async (cmd: string) => {
        if (cmd.includes("localhost:2019/config/")) return JSON.stringify(running);
        return ""; // no Caddyfile at any fixed path, `caddy adapt` yields nothing
      },
    } as unknown as CommandExecutor;
    const res = await scanCaddy(exec);
    expect(res.sites[0]?.serverNames).toEqual(["live.example.com"]);
    expect(urlOf(res.sites[0])).toBe("http://app:8080");
  });

  test("falls back to `caddy adapt` when the admin API is unreachable", async () => {
    // Admin API off (curl/wget return nothing) → the existing fixed-path adapt read
    // must still work, unchanged.
    const res = await scanCaddy(
      exec({
        adapt: httpsServer([
          {
            match: [{ host: ["file.example.com"] }],
            handle: [{ handler: "reverse_proxy", upstreams: [{ dial: "web:3000" }] }],
          },
        ]),
      }),
    );
    expect(res.sites[0]?.serverNames).toEqual(["file.example.com"]);
    expect(urlOf(res.sites[0])).toBe("http://web:3000");
  });
});

describe("caddy Caddyfile text fallback", () => {
  const textOnly = (caddyfile: string) => scanCaddy(exec({ caddyfile }));

  test("block-form reverse_proxy { to backend } — the idiomatic shape", async () => {
    // No inline upstream, so the inline-only regex reported "no reverse_proxy"
    // and dropped the site.
    const res = await textOnly(`
proxied.example.com {
  reverse_proxy {
    to backend:8080
    header_up X-Real-IP {remote_host}
  }
}
`);
    expect(urlOf(res.sites[0])).toBe("http://backend:8080");
  });

  test("php_fastcgi is named, not reported as 'no reverse_proxy or root'", async () => {
    const res = await textOnly(`
php.example.com {
  root * /srv/php
  php_fastcgi php:9000
}
`);
    // root+php_fastcgi: the root wins as a static site only when there's no PHP.
    expect(res.warnings.some((w) => /php/i.test(w))).toBe(true);
  });

  test("unix socket upstream is refused", async () => {
    const res = await textOnly("sock.example.com {\n  reverse_proxy unix//run/app.sock\n}\n");
    expect(res.sites).toEqual([]);
    expect(res.warnings.some((w) => w.includes("unix socket"))).toBe(true);
  });

  test("inline multi-upstream warns", async () => {
    const res = await textOnly("lb.example.com {\n  reverse_proxy a:3000 b:3000\n}\n");
    expect(urlOf(res.sites[0])).toBe("http://a:3000");
    expect(res.warnings.some((w) => w.includes("load-balances"))).toBe(true);
  });

  test("handle_path in text mode warns that path rules are lost", async () => {
    const res = await textOnly(`
paths.example.com {
  handle_path /api/* {
    reverse_proxy api:9000
  }
  reverse_proxy web:3000
}
`);
    expect(res.warnings.some((w) => w.includes("path"))).toBe(true);
  });

  test("http:// prefix and :80 address both mean not-TLS", async () => {
    const res = await textOnly(
      "http://a.example.com {\n reverse_proxy x:1\n}\nb.example.com:80 {\n reverse_proxy y:2\n}\n",
    );
    expect(res.sites.every((s) => s.ssl === false)).toBe(true);
  });

  test("brace-less single-site shorthand still migrates", async () => {
    const res = await textOnly("example.com\nreverse_proxy localhost:8080\n");
    expect(res.sites[0].serverNames).toEqual(["example.com"]);
    expect(urlOf(res.sites[0])).toBe("http://localhost:8080");
  });
});
