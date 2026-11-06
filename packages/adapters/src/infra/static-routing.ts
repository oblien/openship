import type { RoutingConfig } from "@repo/core";

/** Static serving policy shared by the edge and generated nginx containers. */
type StaticRoutingOptions = Pick<RoutingConfig, "spaFallback" | "cleanUrls" | "trailingSlash">;

const STATIC_FALLBACK_NAME = "@osh_fallback";

/** Only unresolved static requests reach this handler. Named locations keep error
 * pages out of user rewrite/proxy locations and leave upstream/ACME errors alone.
 * Repeat root because named locations do not inherit it from location /. */
export function renderStaticFallback(staticRoot: string, options: StaticRoutingOptions): string {
  const slash =
    options.trailingSlash === true
      ? `
        if ($request_uri ~ "^([^?]*[^/?])([?].*)?$") {
            return 308 $1/$2;
        }
`
      : "";
  const fallback =
    options.spaFallback === false
      ? "error_page 404 =404 @osh_not_found;\n        return 404;"
      : "try_files /index.html =404;";
  const notFound =
    options.spaFallback === false
      ? `

    location @osh_not_found {
        root ${staticRoot};
        try_files /404.html =404;
    }`
      : "";
  return `    location ${STATIC_FALLBACK_NAME} {
        root ${staticRoot};
${slash}
        ${fallback}
    }${notFound}`;
}

/**
 * The static `try_files` chain. `$uri.html` is the `cleanUrls` probe (after `$uri`, so a
 * real file still wins).
 *
 * `$uri/` is DROPPED when stripping trailing slashes, and replaced by an explicit
 * `$uri/index.html`. `$uri/` triggers nginx's own 301 directory redirect adding the
 * slash, which the strip rule 308s straight back — an unbreakable loop (`curl -L` exits
 * 47) for any directory the build emits without an index, e.g. a `/blog` holding only
 * `post-1.html`. Probing `$uri/index.html` serves the same directories without ever
 * asking nginx to add a slash we are about to remove.
 *
 * When enforcing the slash, `$uri/` is kept precisely BECAUSE it 301s — that is nginx
 * doing the enforcement for us — and {@link renderStaticFallback} adds it, so a
 * path that resolves to nothing gets the slash while a real file still wins. With
 * `cleanUrls` also set, `$uri.html` resolves `/about` before the fallback is reached, so
 * the pair no longer needs the special case it used to (enforcement being dropped
 * outright) and no longer depends on the build emitting `about/index.html`.
 */
export function renderStaticTryFiles(route: StaticRoutingOptions): string {
  const parts = ["$uri"];
  if (route.cleanUrls) parts.push("$uri.html");
  if (route.trailingSlash === false) parts.push("$uri/index.html");
  else parts.push("$uri/");
  parts.push(STATIC_FALLBACK_NAME);
  return `try_files ${parts.join(" ")};`;
}
