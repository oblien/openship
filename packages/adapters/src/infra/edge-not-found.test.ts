import { describe, expect, test } from "vitest";
import { EDGE_NOT_FOUND_HTML, EDGE_NOT_FOUND_LOCATION } from "./edge-not-found";

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
