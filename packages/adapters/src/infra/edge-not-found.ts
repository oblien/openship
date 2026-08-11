/**
 * The page the edge serves for a hostname it does not route (#431).
 *
 * Before this, an unrouted host got whatever OpenResty says by default: a stock
 * `404 Not Found` / `openresty/1.27.1.1` page on :80, and on :443 no page at all —
 * the catch-all answered with `ssl_reject_handshake`, so the browser showed a bare
 * TLS error and Cloudflare showed error 525. Both are the box telling a visitor
 * "something is broken here" when the truthful answer is "nothing is deployed at
 * that name". Mistyped subdomains, wildcard DNS aimed at the box, and plain
 * visits by IP all land here, so it is the most-seen page the edge serves.
 *
 * WHY THE BODY IS INLINE IN THE CONFIG rather than a file the block `root`s to:
 * it has to arrive on every install path at once. The container edge could COPY an
 * asset, but the bare/legacy edge is driven over SSH by writing config text into
 * `sites-enabled`, and the edge that has already taken over a box has no writable
 * docroot we own. A body that lives IN the directive cannot half-arrive — there is
 * no second file to mount, ship, or forget, and no path that resolves differently
 * inside the container than out.
 *
 * The cost is that the HTML has to survive nginx's config tokenizer, which is why
 * {@link EDGE_NOT_FOUND_HTML} is assembled from fragments joined with no separator
 * and is checked by a test:
 *   - no `'` — it is the quote that delimits the token, and one would end the
 *     string mid-page, leaving a config that fails `nginx -t`. Since the reload is
 *     gated on `-t`, that means NO route change lands on the box until someone
 *     finds it, and on a fresh container it means a crash loop.
 *   - no `$` — `return`'s text argument interpolates variables, so `$1` or
 *     `$border` would silently expand to an empty string.
 *   - no newline — a single line keeps the served bytes identical across the two
 *     writers (the baked conf re-indents shared blocks; a multi-line body would
 *     pick up that indentation on one path only).
 *   - no `#` — nginx is perfectly happy with one inside a quoted token; Openship's
 *     OWN config reader was not. `stripComments` in the proxy importer cut every
 *     line at the first `#`, quoted or not, and it is what parses these files back
 *     (migrate scan, orphan sweep, cert carry). A CSS `#fff` truncated the line
 *     mid-page, taking ~40 closing braces with it — and since `_default.conf` sorts
 *     first in the single `cat` the edge scan does, the whole file's brace balance
 *     broke and every vhost after it was swallowed: the box scanned as ZERO sites,
 *     so the migrate wizard offered no domains and cutover landed with no TLS. That
 *     reader is quote-aware now, and this invariant stays anyway — the files on a
 *     box are written by whatever version deployed last, so a rolled-back control
 *     plane reads a newer box's config with the older parser.
 *   - balanced `{`/`}` — for the same reader, one layer up: `extractBlocks` and
 *     `extractLocationProxies` find a block's end by counting braces, and they
 *     count the ones inside this string too. The CSS below is balanced, so they
 *     land correctly; a lone `{` in a text node would silently extend the "server
 *     block" to the end of the file.
 *
 * Deliberately NOT on the page: the requested hostname. `$host` is attacker-chosen
 * and nginx's own host validation rejects only NULs, path separators and empty
 * labels — `<` and `>` and `"` all pass — so reflecting it would be a
 * reflected-XSS sink on every unrouted name the box answers. It also cannot show
 * anything about what IS deployed here: this page is served to strangers.
 */

/**
 * Machine-readable marker that THIS page — our edge, for a hostname it does not
 * route — is what answered, rather than some other 404. Sits immediately after the
 * doctype so `curl -s https://host | head -c 200` shows it.
 *
 * A support/diagnostic marker, and ONLY that. It is deliberately not wired into
 * `certbotDiagnosis`: an earlier version of that function branched on finding this
 * string in certbot's output, which cannot happen. Boulder's http-01 validator
 * (`va/http.go`) returns `UnauthorizedError("Invalid response from %s: %d")` and
 * returns BEFORE `io.ReadAll` on any non-200 — the response body is echoed back in
 * the problem detail only on the 200 path (oversized body, key-authorization
 * mismatch). A 404 carries a status and no body, so nothing downstream of certbot
 * can ever see this. Tell that case apart by the challenge URL's SCHEME instead
 * (https:// means something redirected the plain-HTTP request), which is what
 * `certbotDiagnosis` now does.
 */
export const EDGE_UNROUTED_SENTINEL = "openship-edge-unrouted";

/**
 * The page, in fragments. Joined with no separator, so every fragment must be
 * self-contained at its boundaries (a break only ever falls between tags or
 * between CSS declarations — never inside a text node, where the missing newline
 * would run two words together).
 */
const HTML_FRAGMENTS: readonly string[] = [
  `<!doctype html>`,
  `<!--${EDGE_UNROUTED_SENTINEL}-->`,
  `<html lang="en">`,
  `<head>`,
  `<meta charset="utf-8">`,
  `<meta name="viewport" content="width=device-width,initial-scale=1">`,
  // An unrouted host must never enter a search index under our page.
  `<meta name="robots" content="noindex,nofollow">`,
  `<title>Service not found</title>`,
  `<style>`,
  // Matches the dashboard's theme: a neutral black-on-white scale, mirrored for
  // dark. No webfont, no image, no external request — the page must render on a
  // box whose only working listener is the one serving it. Colours are `rgb()`,
  // never `#rrggbb`: see the no-`#` invariant in the header.
  `:root{color-scheme:light dark}`,
  `*{box-sizing:border-box}`,
  `body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:rgb(255,255,255);color:rgba(0,0,0,.66);font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;-webkit-font-smoothing:antialiased}`,
  `main{width:100%;max-width:32rem;padding:2.5rem 1.5rem;text-align:center}`,
  // The muted scale is .56, not the .4–.52 it started at: black at .52 on white is
  // 4.3:1 and at .4 is 2.9:1, both under WCAG AA's 4.5:1 for text this small, and
  // this is the most-seen page the edge serves. .56 ≈ 4.75:1.
  `.tag{display:inline-flex;align-items:center;gap:.5rem;margin-bottom:1.25rem;padding:.25rem .625rem;border:1px solid rgba(0,0,0,.1);border-radius:999px;font-size:12px;color:rgba(0,0,0,.56)}`,
  `.dot{width:6px;height:6px;border-radius:50%;background:rgb(224,169,10)}`,
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
  `<span class="tag"><span class="dot"></span>404 &middot; no route</span>`,
  `<h1>Service not found</h1>`,
  // "reachable, but nothing is configured" is the whole message: it separates a
  // down app from an address that was never wired up, which is the distinction a
  // raw TLS error or a stock 404 destroys.
  `<p>This server is reachable, but no application is configured for the address you requested.</p>`,
  `<ul>`,
  `<li>Check the address for a typo</li>`,
  `<li>The deployment may have been removed or renamed</li>`,
  `<li>A newly added domain can take a few minutes to start serving</li>`,
  `</ul>`,
  `<footer>Served by Openship</footer>`,
  `</main>`,
  `</body>`,
  `</html>`,
];

/** The page as one line, ready to be embedded in a single-quoted nginx token. */
export const EDGE_NOT_FOUND_HTML = HTML_FRAGMENTS.join("");

/**
 * The `location /` that serves it — SHARED by the bare edge's catch-all and the
 * baked container config, and by both the :80 and :443 blocks, so all four agree.
 *
 * `types { }` before `default_type`, because `return` with a body picks the content
 * type from the request URI's extension and only falls back to `default_type`.
 * Without the empty `types` block a request for an unrouted host's `/app.css`
 * would be answered `Content-Type: text/css` with an HTML body; clearing the map
 * makes the answer text/html whatever the URI looks like.
 *
 * `server_tokens off` hides the OpenResty version this page used to advertise in
 * its `Server:` header. Scoped to the catch-alls on purpose: it is the block that
 * strangers reach, and setting it at `http` level would change the header for
 * every managed vhost on the box as a side effect of a 404 page.
 */
export const EDGE_NOT_FOUND_LOCATION = `\
    server_tokens off;

    location / {
        types { }
        default_type text/html;
        return 404 '${EDGE_NOT_FOUND_HTML}';
    }`;
