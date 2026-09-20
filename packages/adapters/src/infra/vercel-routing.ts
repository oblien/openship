/**
 * Compile a normalized `RoutingConfig` (parsed from vercel.json / netlify) into
 * the reverse-proxy directives OpenResty can serve. PURE — no I/O — so the
 * translation is unit-testable without a live nginx.
 *
 * Faithful to the documented CONFIG semantics (rewrites/redirects/headers/
 * cleanUrls/trailingSlash), not to a platform's edge/serverless runtime. The
 * `source` path-to-regexp is reduced to an nginx location prefix (the common
 * `:param` / `(.*)` / static-prefix forms) — except a redirect whose destination
 * refers back to the source's wildcard, which needs real captures and so compiles
 * to a `pattern` as well. Anything with conditional matching (`has`/`missing`) is
 * dropped upstream in the parser and never reaches here.
 */

import { isLoopbackHost, type RoutingConfig } from "@repo/core";
import type { RouteProxyLocation, RouteRedirect, RouteHeaderRule } from "../types";

/** Compiled shapes reuse the RouteConfig entry types (single source of truth). */
export type CompiledRedirect = RouteRedirect;
export type CompiledHeaderRule = RouteHeaderRule;

export interface CompiledRouting {
  /** rewrites → reverse-proxy locations (backend service or external URL). */
  proxyLocations: RouteProxyLocation[];
  redirects: RouteRedirect[];
  headerRules: RouteHeaderRule[];
  /** A `/(.*) → /index.html` rewrite was present (SPA fallback). */
  spaFallback: boolean;
  cleanUrls: boolean;
  /**
   * TRI-STATE, matching vercel.json: true → enforce a trailing slash, false → strip
   * it, undefined → leave both forms served. A plain boolean would collapse "strip"
   * and "don't care" into one value, and those emit opposite redirects.
   */
  trailingSlash?: boolean;
  /** Human-readable notes for rules we could not faithfully reproduce. */
  skipped: string[];
}

/** Reduce a path-to-regexp `source` to an nginx location prefix (+ exactness). */
export function sourceToLocation(source: string): { path: string; exact: boolean } | null {
  if (!source.startsWith("/")) return null;
  const hasPattern = /[([:*?]/.test(source);
  const match = source.match(/^\/[^([:*?\s]*/);
  if (!match) return null;
  let path = match[0];
  const exact = !hasPattern;
  if (!exact && path !== "/" && !path.endsWith("/")) path += "/";
  // vercel.json is untrusted repo input compiled into nginx config - reject any
  // path that isn't a clean location (no whitespace / metachars that break out).
  return isSafePath(path) ? { path, exact } : null;
}

// ── Wildcard captures ────────────────────────────────────────────────────────
// A prefix location captures NOTHING, so a destination that refers back to the
// source's wildcard cannot be served from one: `:path*` goes out to the browser
// literally and `$1` expands to empty (#510). Such a rule compiles to a capture
// PATTERN instead, which both emitters match on in place of the prefix.

/**
 * path-to-regexp param token: `:name` plus an optional `*` / `+` / `?` modifier.
 *
 * A name is an IDENTIFIER, so it cannot open with a digit — which is what makes a
 * colon in `/at/12:30` an ordinary path character rather than a reference to a param
 * called `30`, without having to consult the source to tell them apart.
 */
const PARAM_TOKEN = /^:([A-Za-z_][A-Za-z0-9_]*)([*+?]?)/;

/** What each param modifier captures. Unmodified `:name` is one path segment. */
const PARAM_CAPTURE: Record<string, string> = {
  "": "([^/]+)",
  "*": "(.*)", // zero or more segments, slashes included
  "+": "(.+)",
  "?": "([^/]*)",
};

/** Literal source/pattern chars — the `isSafePath` set, minus `.` which is escaped. */
const PATTERN_LITERAL = /[A-Za-z0-9_~\-/]/;

/** nginx caps regex back-references at `$9`, so a longer source cannot compile. */
const MAX_CAPTURES = 9;

export interface SourcePattern {
  /** Emitter-agnostic capture pattern, e.g. `/blog/(.*)`, `/u/([^/]+)`. */
  pattern: string;
  /** Ordered capture names; `""` for an anonymous `(.*)` group. */
  names: string[];
}

/**
 * Compile a wildcard `source` to a capture pattern, or null when it uses a
 * path-to-regexp form we do not reproduce (a custom group like `:id(\\d+)`, an
 * unnamed modifier, a character outside the safe path set). Null means the rule is
 * SKIPPED rather than emitted half-translated.
 */
export function sourceToPattern(source: string): SourcePattern | null {
  if (!source.startsWith("/")) return null;
  let rest = source;
  let pattern = "";
  const names: string[] = [];
  while (rest.length > 0) {
    if (rest.startsWith("(.*)")) {
      names.push("");
      pattern += "(.*)";
      rest = rest.slice(4);
      continue;
    }
    const param = PARAM_TOKEN.exec(rest);
    if (param) {
      names.push(param[1]);
      pattern += PARAM_CAPTURE[param[2]];
      rest = rest.slice(param[0].length);
      continue;
    }
    const ch = rest[0];
    if (ch === ".") {
      pattern += "\\.";
      rest = rest.slice(1);
      continue;
    }
    if (!PATTERN_LITERAL.test(ch)) return null;
    pattern += ch;
    rest = rest.slice(1);
  }
  if (names.length === 0 || names.length > MAX_CAPTURES) return null;
  return { pattern, names };
}

/** An http(s) origin at the head of a destination — its `:` is a scheme/port, not a param. */
const DESTINATION_ORIGIN = /^https?:\/\/[^/?#\s]*/i;

/**
 * The AUTHORITY of a destination is literal text: no capture reference, no nginx
 * variable. A `$` there is the dangerous case — `http://$http_x_target/:path*`
 * compiles to `proxy_pass http://$http_x_target;`, which turns the edge into an open
 * proxy any visitor steers with one request header (loopback, link-local metadata,
 * RFC1918 all reachable), and `https://$arg_next` into an open redirect. A `:name`
 * there is merely unreproducible — we substitute captures into a path, never a host —
 * so both are refused and the rule is SKIPPED rather than half-translated.
 *
 * Checked separately because {@link resolveCaptureRefs} deliberately walks only the
 * part after the origin: inside an authority `:` is a scheme/port delimiter.
 */
function isLiteralAuthority(origin: string): boolean {
  if (origin === "") return true;
  // After `//`, the only legitimate `:` is the port delimiter, which is followed by a
  // digit — so `:` before an identifier start is always a param token, wherever in the
  // host it sits (`https://:sub.example.com`, `https://x.:sub.example.com`).
  const authority = origin.slice(origin.indexOf("//") + 2);
  return !authority.includes("$") && !/:[A-Za-z_]/.test(authority);
}

/**
 * Rewrite a destination's `:name` / `$n` references to nginx-style `$1..$9` against
 * the source's ordered captures, reporting whether it referenced any. Null when a
 * reference resolves to nothing the source captured — `/blog/:path*` → `/news/:slug*`
 * is a typo, and emitting it would put `:slug*` in a Location header — or when the
 * destination's authority is not literal (see {@link isLiteralAuthority}).
 *
 * Only `$1`..`$9` are honoured: any other `$…` would expand as an nginx RUNTIME
 * VARIABLE (`$host`, `$request_uri`, …) in the emitted `return`, which no
 * vercel.json means to ask for.
 */
function resolveCaptureRefs(
  destination: string,
  names: string[],
): { destination: string; referenced: boolean } | null {
  const origin = DESTINATION_ORIGIN.exec(destination)?.[0] ?? "";
  if (!isLiteralAuthority(origin)) return null;
  let rest = destination.slice(origin.length);
  let out = "";
  let referenced = false;
  while (rest.length > 0) {
    const param = PARAM_TOKEN.exec(rest);
    if (param) {
      const index = names.indexOf(param[1]);
      if (index < 0) return null;
      out += `$${index + 1}`;
      referenced = true;
      rest = rest.slice(param[0].length);
      continue;
    }
    if (rest[0] === "$") {
      const capture = /^\$([1-9])/.exec(rest);
      if (!capture || Number(capture[1]) > names.length) return null;
      out += capture[0];
      referenced = true;
      rest = rest.slice(capture[0].length);
      continue;
    }
    out += rest[0];
    rest = rest.slice(1);
  }
  return { destination: origin + out, referenced };
}

/**
 * Resolve a redirect's destination against its source, returning the destination to
 * emit plus — when it refers back to a wildcard — the `pattern` an emitter must
 * match on INSTEAD of the prefix location. Null when the pair cannot be reproduced.
 *
 * A source we cannot compile offers NO captures, which resolution then treats exactly
 * as it should: a destination referencing one is unresolvable and skipped
 * (`/u/:id(\\d+)` → `/user/:id` must not emit `:id` literally), while a destination
 * referencing none is unaffected and keeps its prefix location.
 */
function resolveRedirectTarget(
  source: string,
  destination: string,
): { destination: string; pattern?: string } | null {
  const src = sourceToPattern(source);
  const resolved = resolveCaptureRefs(destination, src?.names ?? []);
  if (!resolved) return null;
  // A destination naming no capture keeps the prefix location and its longest-prefix
  // ordering; only a capture-bearing one has to become a regex. `referenced` implies
  // a non-empty capture list, hence a compiled source.
  return resolved.referenced && src
    ? { destination: resolved.destination, pattern: src.pattern }
    : { destination: resolved.destination };
}

/**
 * The rewrite counterpart of {@link resolveRedirectTarget}: split a full-URL
 * destination into the origin we proxy to and, when it refers back to the source's
 * wildcard, the upstream path template plus the `pattern` to match on.
 *
 * A capture-free destination keeps today's shape — the whole URL as `targetUrl` on a
 * prefix location — so internal and previously-working external rewrites are
 * untouched. Null when the pair cannot be reproduced (same rule as redirects).
 */
function resolveRewriteTarget(
  source: string,
  destination: string,
): { targetUrl: string; pattern?: string; upstreamPath?: string } | null {
  const src = sourceToPattern(source);
  const origin = DESTINATION_ORIGIN.exec(destination)?.[0] ?? "";
  // The origin is sliced off before resolution here (it becomes `proxy_pass`, not part
  // of the rewritten path), so it has to be vetted explicitly — `resolveCaptureRefs`
  // never sees it and would not reject a variable smuggled into the host.
  if (!isLiteralAuthority(origin)) return null;
  const path = destination.slice(origin.length);
  const resolved = resolveCaptureRefs(path, src?.names ?? []);
  if (!resolved) return null;
  if (!resolved.referenced || !src) return { targetUrl: destination };
  // `proxy_pass` takes the bare origin; the rewritten URI carries the path. An empty
  // path template would strip the request URI entirely, so fall back to `/$1`-less
  // root rather than emitting `rewrite … "" break`.
  return {
    targetUrl: origin,
    pattern: src.pattern,
    upstreamPath: resolved.destination || "/",
  };
}

// ── Injection guards ─────────────────────────────────────────────────────────
// Every value below is interpolated into an nginx config, so anything that could
// break out of a directive/block is rejected (the rule is skipped, never emitted).

/** Safe nginx path/prefix: leading slash, no whitespace or nginx metachars. */
function isSafePath(value: string): boolean {
  return /^\/[A-Za-z0-9._~\-/]*$/.test(value);
}

/**
 * Safe redirect destination: a safe path OR an http(s) URL; no ctrl/space/`;`/`{`/`}`.
 * `#` is rejected too — it opens a COMMENT in nginx config, so a destination carrying
 * a fragment would swallow the directive's `;` and fail `openresty -t`, taking the
 * whole vhost down instead of just this rule.
 */
function isSafeDestination(value: string): boolean {
  if (/[\s;{}#\\'"]/.test(value)) return false;
  if (/^https?:\/\//i.test(value)) return true;
  return value.startsWith("/");
}

/**
 * Safe proxy target (backend `http://ip:port` or external http(s) URL).
 *
 * The charclass MUST stay a superset of the emitter's `assertNoNginxInjection`
 * (`[\s;{}#\\]`), plus `$`. A value this function blesses but the emitter refuses does
 * not degrade to a skipped rule — it throws mid-`registerRoute`, so the whole vhost
 * (every rule, every other domain of the project) is never written. `#` opens an nginx
 * comment and `$` expands as a runtime variable, so both are rejected here where the
 * cost is one `skipped` note.
 *
 * A bare `$1`..`$9` is exempt: a destination may legitimately be written in nginx
 * capture form (`https://api.example.com/$1`) instead of `:param` form, and
 * `resolveCaptureRefs` is what decides whether those references actually resolve.
 */
function isSafeTargetUrl(value: string): boolean {
  if (!/^https?:\/\//i.test(value)) return false;
  return !/[\s;{}#\\'"]/.test(value) && !value.replace(/\$[1-9]/g, "").includes("$");
}

function isSafeHeaderKey(value: string): boolean {
  return /^[A-Za-z0-9-]+$/.test(value);
}

/**
 * A header value is emitted into two nginx COMPLEX values (`add_header` and the
 * path-scoped `map`), where `$name` expands. A vercel.json header value is documented
 * literal text, so `$` is refused rather than passed through: `"build-$BUILD_ID"` is an
 * `[emerg] unknown "build_id" variable` that costs the whole vhost, `"US $5 only"`
 * silently serves `US  only`, and `"$http_cookie"` would reflect request state into a
 * response.
 */
function isSafeHeaderValue(value: string): boolean {
  return !/["\\\n\r$]/.test(value); // emitted double-quoted, and `$` would expand
}

/**
 * Rules under `/.well-known/` are refused outright. A generated location there can
 * out-prefix the edge's own `^~ /.well-known/acme-challenge/` (a LONGER plain prefix
 * beats a shorter `^~` one), which both denies certificate issuance and lets a third
 * party answer the HTTP-01 challenge from an origin they control — a publicly trusted
 * cert for someone else's domain. The same trick under the oblien proxy-challenge
 * prefix would prove control of this box as another account's routing target.
 */
function isReservedPath(path: string): boolean {
  return path === "/.well-known" || path.startsWith("/.well-known/");
}

/**
 * Loopback / link-local / RFC1918 literal, i.e. one of OUR OWN upstreams rather than a
 * third-party origin. Such a target keeps `Host $host` (the pre-existing behavior);
 * only a genuinely external origin gets its own Host and TLS SNI.
 */
function isPrivateOrigin(targetUrl: string): boolean {
  let host: string;
  try {
    host = new URL(targetUrl).hostname;
  } catch {
    return false;
  }
  if (isLoopbackHost(host)) return true;
  const v6 = host.replace(/^\[|\]$/g, "").toLowerCase();
  if (v6 === "::1" || v6.startsWith("fe80:") || v6.startsWith("fc") || v6.startsWith("fd")) {
    return true;
  }
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return (
    a === 127 ||
    a === 10 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  );
}

/**
 * A vercel.json redirect status: an HTTP 3xx integer, else the `permanent` default.
 *
 * Vercel documents `permanent` as defaulting to TRUE ("when true, the status code is
 * 308"), and its own `/blog/:path*` → `/news/:path*` example as a 308 — so an absent
 * key means permanent, and only an explicit `false` is temporary.
 */
function redirectStatus(statusCode: number | undefined, permanent: boolean | undefined): number {
  if (
    statusCode !== undefined &&
    Number.isInteger(statusCode) &&
    statusCode >= 300 &&
    statusCode <= 399
  ) {
    return statusCode;
  }
  return permanent === false ? 307 : 308;
}

function isFullUrl(destination: string): boolean {
  return /^https?:\/\//i.test(destination.trim());
}

function isSpaDestination(destination: string): boolean {
  return /(^|\/)index\.html?$/i.test(destination.trim());
}

export function compileVercelRouting(
  routing: RoutingConfig,
  ctx: { backendTargetUrl?: string } = {},
): CompiledRouting {
  const out: CompiledRouting = {
    proxyLocations: [],
    redirects: [],
    headerRules: [],
    spaFallback: false,
    cleanUrls: !!routing.cleanUrls,
    ...(routing.trailingSlash === undefined ? {} : { trailingSlash: routing.trailingSlash }),
    skipped: [],
  };

  for (const rewrite of routing.rewrites ?? []) {
    // A `/(.*) → /index.html` catch-all IS the SPA fallback the static server
    // already does via try_files; flag it and move on.
    if (isSpaDestination(rewrite.destination)) {
      out.spaFallback = true;
      continue;
    }
    const loc = sourceToLocation(rewrite.source);
    if (!loc) {
      out.skipped.push(`rewrite ${rewrite.source} (unsupported source)`);
      continue;
    }
    if (isReservedPath(loc.path)) {
      out.skipped.push(`rewrite ${rewrite.source} (reserved path — /.well-known/ is the edge's)`);
      continue;
    }
    if (isFullUrl(rewrite.destination)) {
      if (!isSafeTargetUrl(rewrite.destination)) {
        out.skipped.push(`rewrite ${rewrite.source} (unsafe destination)`);
        continue;
      }
      try {
        if (isLoopbackHost(new URL(rewrite.destination).hostname)) {
          out.skipped.push(
            `rewrite ${rewrite.source} (loopback destinations must be mapped to an owned service)`,
          );
          continue;
        }
      } catch {
        out.skipped.push(`rewrite ${rewrite.source} (unsafe destination)`);
        continue;
      }
      const target = resolveRewriteTarget(rewrite.source, rewrite.destination);
      if (!target) {
        out.skipped.push(
          `rewrite ${rewrite.source} → ${rewrite.destination} (destination references a wildcard the source does not capture, or smuggles a variable into the host)`,
        );
        continue;
      }
      // Only a genuinely third-party origin gets its own Host + SNI. A private/loopback
      // literal is one of OUR upstreams (a sibling service, a migration takeover), and
      // flipping its Host would break vhost-based routing on the far side — which is
      // what an unconditional `external` did to every capture-free rewrite.
      out.proxyLocations.push({
        pathPrefix: loc.path,
        ...(isPrivateOrigin(target.targetUrl) ? {} : { external: true }),
        ...target,
      });
      continue;
    }
    // A path destination (e.g. "/api" / "/api/index.js" — Vercel routes it to a
    // function) maps to the backend service in our container model. A wildcard in that
    // path still has to be carried: `/docs/:path*` → `/documentation/:path*` must reach
    // the backend as `/documentation/intro`, not as the untouched request URI.
    if (ctx.backendTargetUrl) {
      const target = resolveRewriteTarget(rewrite.source, rewrite.destination);
      if (!target) {
        out.skipped.push(
          `rewrite ${rewrite.source} → ${rewrite.destination} (destination references a wildcard the source does not capture)`,
        );
        continue;
      }
      out.proxyLocations.push({
        pathPrefix: loc.path,
        ...target,
        targetUrl: ctx.backendTargetUrl,
      });
      continue;
    }
    out.skipped.push(`rewrite ${rewrite.source} → ${rewrite.destination} (no backend to proxy to)`);
  }

  for (const redirect of routing.redirects ?? []) {
    const loc = sourceToLocation(redirect.source);
    if (!loc) {
      out.skipped.push(`redirect ${redirect.source} (unsupported source)`);
      continue;
    }
    if (isReservedPath(loc.path)) {
      out.skipped.push(`redirect ${redirect.source} (reserved path — /.well-known/ is the edge's)`);
      continue;
    }
    if (!isSafeDestination(redirect.destination)) {
      out.skipped.push(`redirect ${redirect.source} (unsafe destination)`);
      continue;
    }
    const target = resolveRedirectTarget(redirect.source, redirect.destination);
    if (!target) {
      out.skipped.push(
        `redirect ${redirect.source} → ${redirect.destination} (destination references a wildcard the source does not capture, or smuggles a variable into the host)`,
      );
      continue;
    }
    out.redirects.push({
      path: loc.path,
      exact: loc.exact,
      statusCode: redirectStatus(redirect.statusCode, redirect.permanent),
      destination: target.destination,
      ...(target.pattern ? { pattern: target.pattern } : {}),
    });
  }

  for (const rule of routing.headers ?? []) {
    const loc = sourceToLocation(rule.source);
    if (!loc) {
      out.skipped.push(`header ${rule.source} (unsupported source)`);
      continue;
    }
    const safe = rule.headers.filter((h) => isSafeHeaderKey(h.key) && isSafeHeaderValue(h.value));
    if (safe.length !== rule.headers.length) {
      out.skipped.push(`header ${rule.source} (dropped unsafe header(s))`);
    }
    if (safe.length > 0) out.headerRules.push({ path: loc.path, headers: safe });
  }

  return out;
}
