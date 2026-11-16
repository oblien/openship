import { edgeStatusPage } from "./edge-status-page";

/**
 * The page the edge serves for a hostname it DOES route, whose upstream did not answer
 * (#556) — the sibling of {@link ./edge-not-found.ts} and built the same way.
 *
 * Before this, the edge defined no `error_page` for any 5xx at all, so a container that
 * was restarting, crashed, or still booting produced OpenResty's stock
 * `502 Bad Gateway` / `openresty/1.27.1.1` page. On a free `*.opsh.io` host the visitor
 * ended up looking at a page carrying the CLOUD provider's branding and links — a third
 * party, from the point of view of the operator whose own domain was requested. That is
 * the report this fixes: whatever the box answers with is what the visitor sees, because
 * Openship Cloud's shared edge forwards by IP with the `Host:` header and relays the
 * box's response (see `edge-target.ts`).
 *
 * It cannot cover every 502. When the BOX ITSELF is unreachable, the Cloud edge answers
 * on its own and no page here is involved — that case needs a Cloud-side change and is
 * named as a known limitation on #556, not silently implied to be fixed.
 *
 * WHY THE BODY IS INLINE IN THE CONFIG rather than a file the block `root`s to, and why
 * the HTML has to survive nginx's config tokenizer (no `'`, no `$`, no newline, no `#`,
 * balanced braces) — see the header of `edge-not-found.ts`. Every reason there applies
 * here unchanged, and each invariant is checked by a test, because violating one produces
 * a config that fails `openresty -t`: the reload is gated on it, so NO route change lands
 * on the box until someone finds it, and on a fresh container it is a crash loop.
 *
 * One reason is NEW here, and it is why an `include` of a single shared snippet was
 * rejected even though it would avoid repeating this body per vhost: a missing `include`
 * is itself a hard `-t` failure. The inline form cannot half-arrive; an include can, and
 * the blast radius is every later reload on the box, not just this page.
 *
 * Deliberately NOT on the page: any link, the project name, the operator's dashboard URL,
 * and `$host`. This is served to strangers — the same audience as the 404 page — so it
 * must not advertise infrastructure, and reflecting `$host` would be a reflected-XSS sink
 * (nginx's host validation permits `<`, `>` and `"`). Removing the third-party link IS
 * the fix; re-pointing it at the operator's own domain would only link to the site that
 * is currently down.
 *
 * Deliberately NOT here either: `server_tokens off`. The 404 page carries it scoped to
 * the catch-alls, and its docblock explains why it is not set at `http` level — doing so
 * would change the `Server:` header for every managed vhost on the box as a side effect
 * of an error page. This handler is emitted into every proxying vhost, so carrying it
 * would be exactly that side effect. The stock `Server:` header is a separate decision
 * from the page body.
 */

/**
 * Machine-readable marker that THIS page — our edge, for a routed host whose upstream is
 * down — is what answered, rather than some other 502. Sits immediately after the doctype
 * so `curl -s https://host | head -c 200` shows it, and distinct from the unrouted page's
 * sentinel so the two cases are told apart at a glance: "nothing is deployed at this
 * name" vs "something is, and it is not answering".
 *
 * A support/diagnostic marker, and ONLY that. Nothing branches on it.
 */
export const EDGE_UPSTREAM_DOWN_SENTINEL = "openship-edge-upstream-down";

/** The named location the `error_page` redirects into. `@`-prefixed, so it is reachable
 *  only from `error_page` and can never be selected by a request URI. */
export const EDGE_UPSTREAM_DOWN_LOCATION_NAME = "@osh_upstream_down";

/** Neutral, self-contained HTML, safe in a single-quoted nginx return token. */
export const EDGE_UPSTREAM_DOWN_HTML = edgeStatusPage({
  marker: EDGE_UPSTREAM_DOWN_SENTINEL,
  title: "Application unavailable",
  label: "Temporarily unavailable",
  description: "The application at this address is not responding.",
  detail: "It may be starting up or restarting. Please try again in a moment.",
});

/**
 * The `error_page` + named location that serve it, emitted at SERVER scope in every
 * generated vhost that proxies to an upstream. Server scope rather than inside
 * `location /` so the extra locations a compiled `vercel.json` adds
 * (`renderProxyLocations`) are covered by the same handler.
 *
 * `502 504` and deliberately NOT `503`. 502 is nginx failing to reach the upstream and
 * 504 is the upstream accepting and never answering — both are "the app is not serving".
 * 503 is reachable on purpose: `blockStatus` (default 403) and `rateLimit.status`
 * (default 429) are operator-overridable, and `limit_req_status` is set to 429 in
 * `nginx.ts`. If an operator points either of those at 503, branding it "application
 * unavailable" would report a deliberate block as an outage.
 *
 * NO `=` before the location name, which is load-bearing and was verified against
 * `openresty/openresty:1.27.1.1-alpine` rather than assumed:
 *   - `error_page 502 504 @loc;`   → the ORIGINAL code survives (502 stays 502, a real
 *     read-timeout stays 504) and the body is ours. One shared body covers both codes.
 *   - `error_page 502 504 = @loc;` → the named location's own `return` code replaces it,
 *     so both collapse to whatever that says and a 504 stops being reportable as one.
 * The `return 502` below therefore does NOT set the response status — the intercepted
 * error does. It is written as 502 so the directive reads honestly on its own; a probe
 * with `return 503` there still produced 502 and 504 on the wire.
 *
 * `types { }` before `default_type`, because `return` with a body picks the content type
 * from the request URI's extension and only falls back to `default_type`. Without the
 * empty map, a request for a down app's `/app.css` would be answered
 * `Content-Type: text/css` with an HTML body.
 *
 * An app's OWN 502/504 is untouched by this: `proxy_intercept_errors` is off (nginx's
 * default, and never set anywhere in this repo), so an upstream that answers 502 itself
 * has its own body passed straight through. Verified as case D of the same probe — this
 * page never hijacks a real response from a running app.
 */
export const EDGE_UPSTREAM_DOWN_HANDLER = `\
    error_page 502 504 ${EDGE_UPSTREAM_DOWN_LOCATION_NAME};

    location ${EDGE_UPSTREAM_DOWN_LOCATION_NAME} {
        types { }
        default_type text/html;
        return 502 '${EDGE_UPSTREAM_DOWN_HTML}';
    }`;
