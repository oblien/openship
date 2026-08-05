import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { bakedEdgeNginxConf } from "./edge-baked-conf";
import { EDGE_NOT_FOUND_HTML } from "./edge-not-found";
import {
  ACME_HTTP01_PORT,
  EDGE_CHALLENGE_ROOT,
  EDGE_CHALLENGE_URL_PREFIX,
  EDGE_SHARED_DICTS,
  OPENRESTY_DEFAULT_PATHS,
  OPENRESTY_MGMT_PORT,
  edgeDefaultCertPaths,
} from "./openresty-lua";

/**
 * `apps/edge/nginx.conf` is COPYed into the edge image, so it can't read a TS
 * constant — yet most of what it contains is shared with the bare/remote edge,
 * which gets those same directives patched in from TypeScript. It used to be a
 * hand-maintained copy with three "keep in sync" comments, guarded by string
 * matches that would catch a rename but not a divergent VALUE.
 *
 * It is now generated. This file is the guard on that: the checked-in conf must
 * equal its generator, and the properties worth naming are asserted against the
 * generator, so breaking one gives you its name rather than a whole-file diff.
 */
describe("baked edge nginx.conf", () => {
  const conf = bakedEdgeNginxConf();
  const onDisk = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "../../../../apps/edge/nginx.conf"),
    "utf-8",
  );

  test("the checked-in file is up to date", () => {
    // If this fails: `bun run edge:conf` in packages/adapters. Never hand-edit
    // apps/edge/nginx.conf — the next regeneration silently reverts it.
    expect(onDisk).toBe(conf);
  });

  test("owns the 443 default_server", () => {
    // Without a 443 default, nginx serves the first-loaded 443 vhost to any
    // unmatched SNI — a domain we do NOT route gets another app's cert + backend.
    expect(conf).toContain("listen 443 ssl default_server;");
  });

  test("owns the 80 default_server catch-all (no HTTP fallthrough)", () => {
    expect(conf).toContain("listen 80 default_server;");
    expect(conf).toContain("server_name _;");
  });

  test("the 443 catch-all is a DEAD END, not a proxy", () => {
    // The reason owning `443 ssl default_server` closes the cross-serving hole is
    // no longer "it refuses the handshake" — it now completes one and answers with
    // a page (#431). What keeps it safe is that the block goes nowhere: the moment
    // it grows a proxy_pass or a root it becomes the cross-serving it prevents.
    const https = conf.slice(conf.indexOf("listen 443 ssl default_server;"));
    const block = https.slice(0, https.indexOf("\n    }"));
    expect(block).not.toContain("proxy_pass");
    expect(block).not.toContain("root ");
    expect(block).toContain("return 404");
  });

  test("claims each default_server EXACTLY once", () => {
    // Two defaults for the same address is `[emerg] a duplicate default server`:
    // nginx refuses to start, which on an existing box also means every subsequent
    // reload is refused and route changes freeze. One :80, one :443, nothing else.
    expect(conf.split("listen 80 default_server;").length - 1).toBe(1);
    expect(conf.split("listen 443 ssl default_server;").length - 1).toBe(1);
    // And no THIRD claim under some other spelling. Counted over `listen` lines only:
    // the surrounding comments say "default_server" too.
    const claims = conf
      .split("\n")
      .filter((l) => /^\s*listen\b/.test(l) && l.includes("default_server"));
    expect(claims).toHaveLength(2);
  });

  test("the not-found page does not swallow the two challenge probes", () => {
    // `location /` and the challenge locations live in the SAME server block, and
    // only nginx's longest-prefix rule keeps the page from answering ACME. Splitting
    // them across blocks (or serving the page from a regex/`= /` location) would
    // break issuance and edge-target verification while every test above still
    // passed, so assert they are co-located.
    const http = conf.slice(conf.indexOf("listen 80 default_server;"));
    const block = http.slice(0, http.indexOf("\n    }"));
    expect(block).toContain(`location ${EDGE_CHALLENGE_URL_PREFIX} {`);
    expect(block).toContain("location /.well-known/acme-challenge/ {");
    expect(block).toContain("location / {");
  });

  test("the catch-alls answer 404, never 200", () => {
    // A 200 would make an unrouted hostname look HEALTHY: Openship Cloud's
    // edge-target probe, any uptime monitor, and a browser's own error handling all
    // read the status, not the text. The page explains; the status is the answer.
    expect(conf).not.toMatch(/location \/ \{[\s\S]{0,200}return\s+200/);
  });

  test("the 443 catch-all leaks nothing about the request and pins nothing", () => {
    // Reflecting the hostname into a body no CSP covers is a stored-nowhere but
    // very real XSS sink (nginx accepts `< > \" '` in Host), and an HSTS header from
    // a block whose certificate is trusted by nothing would pin every visitor's
    // browser to hard-fail on it — a self-inflicted outage for a hostname that
    // later gets a real cert. http2 is left off deliberately too: this block only
    // ever emits one small response.
    const https = conf.slice(conf.indexOf("listen 443 ssl default_server;"));
    const block = https.slice(0, https.indexOf("\n    }"));
    for (const leak of ["$host", "$http_host", "$ssl_server_name", "$request_uri"]) {
      expect(block).not.toContain(leak);
    }
    expect(block).not.toContain("Strict-Transport-Security");
    expect(block).not.toContain("http2");
  });

  test("the 443 catch-all presents the placeholder cert, never a real one", () => {
    // A handshake needs a certificate, and reusing a DOMAIN's cert here is exactly
    // the cross-serving being prevented — an unrouted host would be handed a cert
    // valid for someone else's site. Only the domain-less placeholder may appear.
    const { certPath, keyPath } = edgeDefaultCertPaths(OPENRESTY_DEFAULT_PATHS.confDir);
    expect(conf).toContain(`ssl_certificate ${certPath};`);
    expect(conf).toContain(`ssl_certificate_key ${keyPath};`);
    expect(conf).not.toContain("/etc/letsencrypt");
  });

  test("the image creates the cert the config names", () => {
    // nginx refuses to LOAD a config whose ssl_certificate is missing, so a drift
    // between these two files is not a missing page — it is an edge that will not
    // boot, taking every routed site on the box with it.
    const dockerfile = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "../../../../apps/edge/Dockerfile"),
      "utf-8",
    );
    const { certPath, keyPath } = edgeDefaultCertPaths(OPENRESTY_DEFAULT_PATHS.confDir);
    expect(dockerfile).toContain("openssl req -x509");
    expect(dockerfile).toContain(certPath);
    expect(dockerfile).toContain(keyPath);
    // And the build must prove the result loads rather than shipping an edge that
    // crash-loops on a config we never parsed.
    expect(dockerfile).toContain("RUN openresty -t");
  });

  test("serves the branded not-found page on BOTH catch-alls", () => {
    // The whole point of #431: a mistyped subdomain gets an explanation, on :80 and
    // :443 alike. One occurrence per catch-all, and not one more.
    const hits = conf.split(EDGE_NOT_FOUND_HTML).length - 1;
    expect(hits).toBe(2);
  });

  /**
   * Both probes that matter arrive addressed to a bare IP, so `Host:` matches no
   * server_name and only the catch-all is left to answer them.
   */
  test("answers ACME http-01 on the catch-all, proxied to certbot's loopback port", () => {
    expect(conf).toContain(`proxy_pass http://127.0.0.1:${ACME_HTTP01_PORT};`);
  });

  test("serves the Openship Cloud edge-target challenge on the catch-all", () => {
    expect(conf).toContain(`location ${EDGE_CHALLENGE_URL_PREFIX} {`);
    expect(conf).toContain(`root ${EDGE_CHALLENGE_ROOT};`);
  });

  test("serves challenge tokens as FILES, never echoing them back", () => {
    // An echo (`return 200 $1` off a regex match) would hand a token back to
    // whoever asked, letting a third party register this box as THEIR routing
    // target and prove control with our own reply. Only files we wrote may serve.
    expect(conf).toContain("try_files $uri =404;");
    expect(conf).not.toMatch(/oblien-proxy-challenge[\s\S]{0,200}return\s+200/);
  });

  test("declares every shared dict the Lua depends on, at the shared size", () => {
    // The drift this whole generator exists for: a zone sized here by hand and
    // patched elsewhere from EDGE_SHARED_DICTS evicts under load on one edge only.
    for (const dict of EDGE_SHARED_DICTS) {
      expect(conf).toContain(`lua_shared_dict ${dict.name} ${dict.size};`);
    }
  });

  test("includes the sites-enabled glob the api actually writes into", () => {
    // A mismatch here is a box where every managed vhost is written and none load.
    expect(conf).toContain(`include ${OPENRESTY_DEFAULT_PATHS.sitesDir}/*.conf;`);
  });

  test("binds the management API to loopback only", () => {
    // Analytics, raw request logs and the live-log pipe. A bare `listen 9145;`
    // would publish all three.
    expect(conf).toContain(`listen 127.0.0.1:${OPENRESTY_MGMT_PORT};`);
    expect(conf).not.toMatch(new RegExp(`listen\\s+${OPENRESTY_MGMT_PORT}\\b`));
  });
});
