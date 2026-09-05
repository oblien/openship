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

/**
 * The page, in fragments. Joined with no separator, so every fragment must be
 * self-contained at its boundaries (a break only ever falls between tags or between CSS
 * declarations — never inside a text node, where the missing newline would run two words
 * together).
 */
const HTML_FRAGMENTS: readonly string[] = [
  `<!doctype html>`,
  `<!--${EDGE_UPSTREAM_DOWN_SENTINEL}-->`,
  `<html lang="en">`,
  `<head>`,
  `<meta charset="utf-8">`,
  `<meta name="viewport" content="width=device-width,initial-scale=1">`,
  // A transient outage must never be the version of the page that enters an index.
  `<meta name="robots" content="noindex,nofollow">`,
  `<title>Application unavailable</title>`,
  `<style>`,
  // Same neutral black-on-white scale as the 404 page, mirrored for dark, so the two
  // pages the edge serves read as one system. No webfont, no image, no external request:
  // the page must render on a box whose only working listener is the one serving it.
  // Colours are `rgb()`, never a hex triplet — see the no-`#` invariant above.
  `:root{color-scheme:light dark}`,
  `*{box-sizing:border-box}`,
  `body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:rgb(255,255,255);color:rgba(0,0,0,.66);font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;-webkit-font-smoothing:antialiased}`,
  `main{width:100%;max-width:32rem;padding:2.5rem 1.5rem;text-align:center}`,
  // .56 on white ≈ 4.75:1 — WCAG AA for text this small. The 404 page documents why the
  // lighter scales it started at (.4–.52) were under the bar.
  `.tag{display:inline-flex;align-items:center;gap:.5rem;margin-bottom:1.25rem;padding:.25rem .625rem;border:1px solid rgba(0,0,0,.1);border-radius:999px;font-size:12px;color:rgba(0,0,0,.56)}`,
  // Red, not the 404 page's amber: that page describes a name that was never wired up,
  // this one an app that should be answering and is not.
  `.dot{width:6px;height:6px;border-radius:50%;background:rgb(214,69,58)}`,
  `h1{margin:0 0 .5rem;font-size:1.375rem;font-weight:600;letter-spacing:-.01em;color:rgba(0,0,0,.92)}`,
  `p{margin:0 auto 1.5rem;max-width:26rem}`,
  `ul{display:inline-block;margin:0;padding:0;list-style:none;text-align:left;font-size:13.5px;color:rgba(0,0,0,.56)}`,
  `li{position:relative;padding:.2rem 0 .2rem 1rem}`,
  `li::before{content:"";position:absolute;left:0;top:.75em;width:4px;height:4px;border-radius:50%;background:rgba(0,0,0,.25)}`,
  `footer{margin-top:2.25rem;font-size:12px;color:rgba(0,0,0,.56)}`,
  `@media(prefers-color-scheme:dark){`,
  `body{background:rgb(10,10,10);color:rgba(255,255,255,.66)}`,
  `.tag{border-color:rgba(255,255,255,.12);color:rgba(255,255,255,.56)}`,
  `h1{color:rgba(255,255,255,.95)}`,
  `ul{color:rgba(255,255,255,.56)}`,
  `li::before{background:rgba(255,255,255,.28)}`,
  `footer{color:rgba(255,255,255,.56)}`,
  `}`,
  `</style>`,
  `</head>`,
  `<body>`,
  `<main>`,
  // No status number in the tag: this one page answers both 502 and 504, and nginx keeps
  // the real code on the status line (see the handler below). Naming one of them here
  // would be wrong half the time.
  `<span class="tag"><span class="dot"></span>upstream not responding</span>`,
  `<h1>Application unavailable</h1>`,
  // "routed, but not answering" is the whole message — the distinction the stock page
  // destroys, and the mirror of the 404 page separating "nothing is deployed here".
  `<p>This address is configured, but the application behind it is not responding.</p>`,
  `<ul>`,
  `<li>The deployment may be starting up or restarting</li>`,
  `<li>The application may have stopped or crashed</li>`,
  `<li>Trying again in a moment may work</li>`,
  `</ul>`,
  `<footer>Served by Openship</footer>`,
  `</main>`,
  `</body>`,
  `</html>`,
];

/** The page as one line, ready to be embedded in a single-quoted nginx token. */
export const EDGE_UPSTREAM_DOWN_HTML = HTML_FRAGMENTS.join("");

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
