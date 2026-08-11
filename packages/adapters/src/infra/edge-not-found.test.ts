import { describe, expect, test } from "vitest";
import {
  EDGE_NOT_FOUND_HTML,
  EDGE_NOT_FOUND_LOCATION,
  EDGE_UNROUTED_SENTINEL,
} from "./edge-not-found";
import { stripComments, extractBlocks } from "../system/proxy/import/parse-utils";
import { edgeDefaultCatchAllConf } from "./openresty-lua";

/**
 * The page is embedded in an nginx `return 404 '<body>'` on every install path, so
 * the config tokenizer is part of its contract. These are not style checks: each
 * one of them, violated, produces a config that fails `openresty -t` — which means
 * a crash-looping fresh edge, or an existing edge that refuses this and every
 * LATER reload, freezing route changes for every site on the box.
 */
describe("edge not-found page", () => {
  test("contains no single quote — it would end the nginx token mid-page", () => {
    expect(EDGE_NOT_FOUND_HTML).not.toContain("'");
  });

  test("contains no $ — nginx interpolates variables in a return body", () => {
    // `$1`, `$host`, `$border` would each expand (usually to nothing), silently
    // deleting part of the page rather than failing loudly.
    expect(EDGE_NOT_FOUND_HTML).not.toContain("$");
  });

  test("is a single line — both writers must serve identical bytes", () => {
    // The baked conf re-indents shared blocks for `http {}`; a multi-line body would
    // pick that indentation up on the container path only.
    expect(EDGE_NOT_FOUND_HTML).not.toContain("\n");
  });

  test("contains no # — Openship's OWN config reader cuts lines at one", () => {
    // nginx doesn't care; `stripComments` in the proxy importer did. A CSS `#fff` here
    // truncated the line mid-page, taking ~40 closing braces with it, and since
    // `_default.conf` sorts first in the edge scan's single `cat` the brace balance
    // broke for the WHOLE file: every vhost after it was swallowed and the box scanned
    // as zero sites — no domains in the migrate wizard, no certs carried at cutover.
    // Nothing failed. It just found nothing. Use rgb() for colours.
    expect(EDGE_NOT_FOUND_HTML).not.toContain("#");
  });

  test("keeps its braces balanced — the same reader counts them", () => {
    // `extractBlocks` / `extractLocationProxies` find a block's end by counting braces
    // and count the ones inside this string too (the CSS is full of them). A lone `{`
    // in a text node would extend the "server block" to the end of the file.
    const open = (EDGE_NOT_FOUND_HTML.match(/\{/g) ?? []).length;
    const close = (EDGE_NOT_FOUND_HTML.match(/\}/g) ?? []).length;
    expect(open).toBe(close);
  });

  test("survives a round trip through the reader that parses these files back", () => {
    // The end-to-end version of the two above, against the real bytes: the bare edge's
    // catch-all, through the importer's comment stripper, must still yield its two
    // server blocks. This is the assertion whose absence let #431's fix take the
    // migrate scan down with it.
    const conf = edgeDefaultCatchAllConf({ certPath: "/c/fullchain.pem", keyPath: "/c/privkey.pem" });
    expect(extractBlocks(stripComments(conf), "server")).toHaveLength(2);
  });

  test("carries the sentinel in the first 200 bytes", () => {
    // So `curl -s https://host | head -c 200` says "our edge, unrouted host" rather
    // than leaving an operator to guess whose 404 they are looking at. A support
    // marker only — see the constant's docblock for why certbot can never see it.
    expect(EDGE_NOT_FOUND_HTML.indexOf(EDGE_UNROUTED_SENTINEL)).toBeGreaterThan(-1);
    expect(EDGE_NOT_FOUND_HTML.indexOf(EDGE_UNROUTED_SENTINEL)).toBeLessThan(200);
  });

  test("makes no external request", () => {
    // It is served by a box whose only known-working listener is this one — and to
    // strangers, so a third-party fetch would leak their visit too.
    expect(EDGE_NOT_FOUND_HTML).not.toMatch(/https?:\/\//);
    expect(EDGE_NOT_FOUND_HTML).not.toContain("<script");
  });

  test("never reflects the requested hostname", () => {
    // `$host` is attacker-chosen and nginx's host validation permits `<`, `>` and
    // `"` — reflecting it would be a stored-nowhere-but-live XSS sink on every
    // unrouted name the box answers. The `$` assertion above covers the mechanism;
    // this names the reason so it isn't "fixed" by escaping and re-adding it.
    expect(EDGE_NOT_FOUND_LOCATION).not.toContain("$host");
  });

  test("answers text/html regardless of the URI's extension", () => {
    // `return` with a body types the response from the request URI, so a request for
    // an unrouted host's `/app.css` would be `Content-Type: text/css` with an HTML
    // body. Clearing the map is what makes `default_type` apply.
    const typesAt = EDGE_NOT_FOUND_LOCATION.indexOf("types { }");
    const defaultAt = EDGE_NOT_FOUND_LOCATION.indexOf("default_type text/html;");
    expect(typesAt).toBeGreaterThan(-1);
    expect(defaultAt).toBeGreaterThan(typesAt);
  });

  test("hides the server version the stock page advertised", () => {
    expect(EDGE_NOT_FOUND_LOCATION).toContain("server_tokens off;");
  });

  test("says the server is up and the address is not configured", () => {
    // The one thing the page exists to communicate. A raw TLS error or a stock 404
    // destroys the distinction between "the app is down" and "nothing was ever
    // deployed at this name" (#431).
    expect(EDGE_NOT_FOUND_HTML).toContain("Service not found");
    expect(EDGE_NOT_FOUND_HTML).toContain("no application is configured");
    expect(EDGE_NOT_FOUND_HTML).toContain("noindex");
  });
});
