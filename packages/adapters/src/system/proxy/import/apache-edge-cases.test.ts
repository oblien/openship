import { describe, expect, test } from "vitest";
import type { CommandExecutor } from "../../../types";
import { scanApache } from "./apache";

/**
 * Apache migration edge cases, written against config a real `httpd:2.4` accepted
 * (verified with `apachectl -S`, whose vhost-file discovery this exercises).
 *
 * The pattern that made these worth chasing: Apache's `:80` half of a TLS site
 * usually carries a DocumentRoot ALONGSIDE its redirect, so it parsed as a real
 * static site and then collided with the `:443` vhost for the same ServerName —
 * one vhost file per host, and the live HTTPS site lost.
 */

/** Answers `apachectl -S` with a dump and any `cat` with the vhost text. */
const exec = (conf: string, dump?: string): CommandExecutor =>
  ({
    exec: async (cmd: string) => {
      if (cmd.includes("apachectl -S")) return dump ?? "";
      if (cmd.startsWith("cat ")) return conf;
      return "";
    },
  }) as unknown as CommandExecutor;

const site = (
  res: { sites: Array<{ serverNames: string[]; target: unknown }> },
  host: string,
) => res.sites.find((s) => s.serverNames.includes(host));
const urlOf = (s: { target: unknown } | undefined) =>
  (s?.target as { url?: string; root?: string } | undefined)?.url;
const rootOf = (s: { target: unknown } | undefined) =>
  (s?.target as { url?: string; root?: string } | undefined)?.root;

describe("apache: the :80 redirect half vs the :443 site", () => {
  // Real-world shape: mod_rewrite redirect AND a DocumentRoot on the :80 vhost.
  const conf = `
<VirtualHost *:80>
    ServerName shop.example.com:80
    ServerAlias www.shop.example.com
    DocumentRoot /var/www/shop
    RewriteEngine on
    RewriteCond %{HTTPS} off
    RewriteRule ^(.*)$ https://shop.example.com$1 [R=301,L]
</VirtualHost>

<VirtualHost *:443>
    ServerName shop.example.com:443
    ServerAlias www.shop.example.com
    SSLEngine on
    SSLCertificateFile /etc/ssl/certs/shop.pem
    SSLCertificateKeyFile /etc/ssl/private/shop.key
    ProxyPass /api http://127.0.0.1:9000/ retry=0
    ProxyPass / http://127.0.0.1:8080/
    ProxyPassReverse / http://127.0.0.1:8080/
</VirtualHost>
`;

  test("keeps the TLS proxy, not the redirect vhost's docroot", async () => {
    const res = await scanApache(exec(conf));
    expect(res.sites).toHaveLength(1);
    expect(res.sites[0].ssl).toBe(true);
    expect(urlOf(res.sites[0])).toBe("http://127.0.0.1:8080/");
  });

  test("strips the port from ServerName — `example.com:443` is not a hostname", async () => {
    // Carried through, this produced `server_name shop.example.com:443`, which
    // matches no request at all.
    const res = await scanApache(exec(conf));
    expect(res.sites[0].serverNames).toEqual(["shop.example.com", "www.shop.example.com"]);
  });

  test("keeps the full path fan-out for later use", async () => {
    const res = await scanApache(exec(conf));
    expect(res.sites[0].routes?.map((r) => r.path)).toEqual(["/api", "/"]);
  });

  test("carries the existing cert paths so the takeover can reuse them", async () => {
    const res = await scanApache(exec(conf));
    expect(res.sites[0].tls).toEqual({
      certPath: "/etc/ssl/certs/shop.pem",
      keyPath: "/etc/ssl/private/shop.key",
    });
  });

  test("a `Redirect permanent` half is recognised as well as a RewriteRule one", async () => {
    const res = await scanApache(
      exec(`
<VirtualHost *:80>
    ServerName r.example.com
    DocumentRoot /var/www/r
    Redirect permanent / https://r.example.com/
</VirtualHost>
<VirtualHost *:443>
    ServerName r.example.com
    SSLEngine on
    ProxyPass / http://127.0.0.1:7000/
</VirtualHost>
`),
    );
    expect(res.sites).toHaveLength(1);
    expect(urlOf(res.sites[0])).toBe("http://127.0.0.1:7000/");
  });

  test("a redirect-only host with NO TLS vhost is reported, not silently dropped", async () => {
    const res = await scanApache(
      exec(`
<VirtualHost *:80>
    ServerName legacy.example.com
    Redirect permanent / https://legacy.example.com/
</VirtualHost>
`),
    );
    expect(res.sites).toEqual([]);
    expect(
      res.warnings.some((w) => w.includes("legacy.example.com") && w.includes("nothing to serve")),
    ).toBe(true);
  });

  test("a :80 vhost that really serves content is NOT treated as a redirect", async () => {
    const res = await scanApache(
      exec(`
<VirtualHost *:80>
    ServerName plain.example.com
    DocumentRoot /var/www/plain
</VirtualHost>
`),
    );
    expect(rootOf(site(res, "plain.example.com"))).toBe("/var/www/plain");
  });
});

describe("apache: upstreams we can't express", () => {
  test("PHP-FPM (ProxyPassMatch → fcgi) is refused even though a DocumentRoot exists", async () => {
    // Emitting the docroot would serve .php as PLAIN TEXT — source disclosure,
    // credentials in config.php included. Refusing is the only safe answer.
    const res = await scanApache(
      exec(`
<VirtualHost *:443>
    ServerName php.example.com
    SSLEngine on
    DocumentRoot /var/www/php
    ProxyPassMatch ^/(.*\\.php(/.*)?)$ unix:/run/php-fpm.sock|fcgi://localhost/var/www/php
</VirtualHost>
`),
    );
    expect(res.sites).toEqual([]);
    expect(res.warnings.some((w) => /PHP-FPM/i.test(w))).toBe(true);
  });

  test("a balancer:// cluster is refused with its name", async () => {
    const res = await scanApache(
      exec(`
<VirtualHost *:443>
    ServerName cluster.example.com
    SSLEngine on
    ProxyPass / balancer://mycluster/
</VirtualHost>
`),
    );
    expect(res.sites).toEqual([]);
    expect(res.warnings.some((w) => w.includes("balancer://mycluster/"))).toBe(true);
  });

  test("ProxyPass ... ! exclusions don't become the upstream", async () => {
    const res = await scanApache(
      exec(`
<VirtualHost *:443>
    ServerName ex.example.com
    SSLEngine on
    ProxyPass /static !
    ProxyPass / http://127.0.0.1:6000/
</VirtualHost>
`),
    );
    expect(urlOf(res.sites[0])).toBe("http://127.0.0.1:6000/");
  });
});

describe("apache: names and TLS detection", () => {
  test("ServerAlias across several lines all become serverNames", async () => {
    const res = await scanApache(
      exec(`
<VirtualHost *:443>
    ServerName a.example.com
    ServerAlias b.example.com c.example.com
    ServerAlias d.example.com
    SSLEngine on
    ProxyPass / http://127.0.0.1:5000/
</VirtualHost>
`),
    );
    expect(res.sites[0].serverNames).toEqual([
      "a.example.com",
      "b.example.com",
      "c.example.com",
      "d.example.com",
    ]);
  });

  test("TLS is inferred from the :443 arg, SSLEngine, or a cert path", async () => {
    const res = await scanApache(
      exec(`
<VirtualHost *:443>
    ServerName byport.example.com
    ProxyPass / http://127.0.0.1:1/
</VirtualHost>
<VirtualHost *:8443>
    ServerName byengine.example.com
    SSLEngine on
    ProxyPass / http://127.0.0.1:2/
</VirtualHost>
<VirtualHost *:9000>
    ServerName bycert.example.com
    SSLCertificateFile /etc/ssl/x.pem
    ProxyPass / http://127.0.0.1:3/
</VirtualHost>
`),
    );
    expect(res.sites.every((s) => s.ssl)).toBe(true);
  });

  test("a VirtualHost with no ServerName is reported", async () => {
    const res = await scanApache(
      exec("<VirtualHost *:80>\n  DocumentRoot /var/www/x\n</VirtualHost>\n"),
    );
    expect(res.sites).toEqual([]);
    expect(res.warnings.some((w) => w.includes("no ServerName"))).toBe(true);
  });

  test("two real vhosts for one host collapse to the TLS/proxy one", async () => {
    // Both serve content (no redirect), so only the collapse prevents the plain
    // static one from overwriting the TLS proxy.
    const res = await scanApache(
      exec(`
<VirtualHost *:80>
    ServerName dual.example.com
    DocumentRoot /var/www/dual
</VirtualHost>
<VirtualHost *:443>
    ServerName dual.example.com
    SSLEngine on
    ProxyPass / http://127.0.0.1:4000/
</VirtualHost>
`),
    );
    expect(res.sites).toHaveLength(1);
    expect(urlOf(res.sites[0])).toBe("http://127.0.0.1:4000/");
    expect(res.warnings.some((w) => w.includes("second VirtualHost"))).toBe(true);
  });
});

describe("apache: quoted arguments and the one-argument ProxyPass", () => {
  test("quoted ProxyPass arguments yield a bare path and upstream", async () => {
    const res = await scanApache(
      exec(`
<VirtualHost *:443>
    ServerName q.example.com
    SSLEngine on
    ProxyPass "/api" "http://127.0.0.1:9000/"
    ProxyPass "/" "http://127.0.0.1:8080/"
    ProxyPassReverse "/" "http://127.0.0.1:8080/"
</VirtualHost>
`),
    );
    expect(urlOf(res.sites[0])).toBe("http://127.0.0.1:8080/");
    expect(res.sites[0].routes).toEqual([
      { path: "/api", url: "http://127.0.0.1:9000/" },
      { path: "/", url: "http://127.0.0.1:8080/" },
    ]);
  });

  test("quoted ServerName and ServerAlias are hostnames, not quoted strings", async () => {
    const res = await scanApache(
      exec(`
<VirtualHost *:443>
    ServerName "q.example.com"
    ServerAlias "www.q.example.com" 'alt.q.example.com'
    SSLEngine on
    ProxyPass / http://127.0.0.1:8080/
</VirtualHost>
`),
    );
    expect(res.sites[0].serverNames).toEqual([
      "q.example.com",
      "www.q.example.com",
      "alt.q.example.com",
    ]);
  });

  test("quoted cert paths stay usable for the carry", async () => {
    const res = await scanApache(
      exec(`
<VirtualHost *:443>
    ServerName q.example.com
    SSLEngine on
    SSLCertificateFile "/etc/letsencrypt/live/q.example.com/fullchain.pem"
    SSLCertificateKeyFile "/etc/letsencrypt/live/q.example.com/privkey.pem"
    ProxyPass / http://127.0.0.1:8080/
</VirtualHost>
`),
    );
    expect(res.sites[0].tls).toEqual({
      certPath: "/etc/letsencrypt/live/q.example.com/fullchain.pem",
      keyPath: "/etc/letsencrypt/live/q.example.com/privkey.pem",
    });
  });

  test("a one-argument ProxyPass takes the path of its <Location>", async () => {
    const res = await scanApache(
      exec(`
<VirtualHost *:443>
    ServerName loc.example.com
    SSLEngine on
    <Location "/api">
        ProxyPass "http://127.0.0.1:9000/"
        ProxyPassReverse "http://127.0.0.1:9000/"
    </Location>
    <Location "/">
        ProxyPass "http://127.0.0.1:8080/"
        ProxyPassReverse "http://127.0.0.1:8080/"
    </Location>
</VirtualHost>
`),
    );
    expect(res.sites[0].routes).toEqual([
      { path: "/api", url: "http://127.0.0.1:9000/" },
      { path: "/", url: "http://127.0.0.1:8080/" },
    ]);
    expect(urlOf(res.sites[0])).toBe("http://127.0.0.1:8080/");
  });

  test("a one-argument ProxyPass under <LocationMatch> is reported as regex proxying", async () => {
    const res = await scanApache(
      exec(`
<VirtualHost *:443>
    ServerName rx.example.com
    SSLEngine on
    <LocationMatch "^/v[0-9]+/">
        ProxyPass "http://127.0.0.1:9000/"
    </LocationMatch>
</VirtualHost>
`),
    );
    expect(res.sites).toEqual([]);
    expect(res.warnings).toContain(
      "apache: rx.example.com proxies from inside a <LocationMatch> (regex proxying) — re-add it manually",
    );
  });

  test("a one-argument ProxyPass with no enclosing <Location> is not given a `/` route", async () => {
    const res = await scanApache(
      exec(`
<VirtualHost *:443>
    ServerName bare.example.com
    SSLEngine on
    ProxyPass "http://127.0.0.1:9000/"
</VirtualHost>
`),
    );
    expect(res.sites).toEqual([]);
    expect(res.warnings).toContain(
      "apache: bare.example.com has neither ProxyPass nor DocumentRoot — skipped",
    );
  });
});

describe("apache: apachectl -S vhost discovery", () => {
  test("finds vhost files in a non-standard path from the real dump format", async () => {
    // Verbatim `apachectl -S` shape from httpd:2.4 — the paths come from its
    // trailing `(file:line)` annotations, which is how Include-resolved configs
    // in non-conventional locations are found at all.
    const dump = `VirtualHost configuration:
*:80                   is a NameVirtualHost
         default server shop.example.com (/opt/custom/vhosts.conf:1)
         port 80 namevhost shop.example.com (/opt/custom/vhosts.conf:1)
                 alias www.shop.example.com
*:443                  is a NameVirtualHost
         default server shop.example.com (/opt/custom/vhosts.conf:10)
ServerRoot: "/usr/local/apache2"`;
    const conf = `
<VirtualHost *:443>
    ServerName shop.example.com
    SSLEngine on
    ProxyPass / http://127.0.0.1:8080/
</VirtualHost>
`;
    const calls: string[] = [];
    const tracking = {
      exec: async (cmd: string) => {
        calls.push(cmd);
        if (cmd.includes("apachectl -S")) return dump;
        if (cmd.startsWith("cat ")) return conf;
        return "";
      },
    } as unknown as CommandExecutor;

    const res = await scanApache(tracking);
    expect(urlOf(res.sites[0])).toBe("http://127.0.0.1:8080/");
    // Proves discovery drove the read, not the conventional fallback paths.
    expect(calls.some((c) => c.includes("/opt/custom/vhosts.conf"))).toBe(true);
  });

  test("no readable config at all is a warning, never a throw", async () => {
    const res = await scanApache({ exec: async () => "" } as unknown as CommandExecutor);
    expect(res.sites).toEqual([]);
    expect(res.warnings.length).toBeGreaterThan(0);
  });
});
