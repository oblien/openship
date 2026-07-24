/**
 * Compile a normalized `RoutingConfig` (parsed from vercel.json / netlify) into
 * the reverse-proxy directives OpenResty can serve. PURE — no I/O — so the
 * translation is unit-testable without a live nginx.
 *
 * Faithful to the documented CONFIG semantics (rewrites/redirects/headers/
 * cleanUrls/trailingSlash), not to a platform's edge/serverless runtime. The
 * `source` path-to-regexp is reduced to an nginx location prefix (the common
 * `:param` / `(.*)` / static-prefix forms); anything with conditional matching
 * (`has`/`missing`) is dropped upstream in the parser and never reaches here.
 */

import type { RoutingConfig } from "@repo/core";
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
  trailingSlash: boolean;
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

// ── Injection guards ─────────────────────────────────────────────────────────
// Every value below is interpolated into an nginx config, so anything that could
// break out of a directive/block is rejected (the rule is skipped, never emitted).

/** Safe nginx path/prefix: leading slash, no whitespace or nginx metachars. */
function isSafePath(value: string): boolean {
  return /^\/[A-Za-z0-9._~\-/]*$/.test(value);
}

/** Safe redirect destination: a safe path OR an http(s) URL; no ctrl/space/`;`/`{`/`}`. */
function isSafeDestination(value: string): boolean {
  if (/[\s;{}\\'"]/.test(value)) return false;
  if (/^https?:\/\//i.test(value)) return true;
  return value.startsWith("/");
}

/** Safe proxy target (backend `http://ip:port` or external http(s) URL). */
function isSafeTargetUrl(value: string): boolean {
  return /^https?:\/\//i.test(value) && !/[\s;{}\\'"]/.test(value);
}

function isSafeHeaderKey(value: string): boolean {
  return /^[A-Za-z0-9-]+$/.test(value);
}

function isSafeHeaderValue(value: string): boolean {
  return !/["\\\n\r]/.test(value); // emitted double-quoted
}

/** A vercel.json redirect status: an HTTP 3xx integer, else the permanent/temporary default. */
function redirectStatus(statusCode: number | undefined, permanent: boolean | undefined): number {
  if (
    statusCode !== undefined &&
    Number.isInteger(statusCode) &&
    statusCode >= 300 &&
    statusCode <= 399
  ) {
    return statusCode;
  }
  return permanent ? 308 : 307;
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
    trailingSlash: !!routing.trailingSlash,
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
    if (isFullUrl(rewrite.destination)) {
      if (!isSafeTargetUrl(rewrite.destination)) {
        out.skipped.push(`rewrite ${rewrite.source} (unsafe destination)`);
        continue;
      }
      out.proxyLocations.push({ pathPrefix: loc.path, targetUrl: rewrite.destination });
      continue;
    }
    // A path destination (e.g. "/api" / "/api/index.js" — Vercel routes it to a
    // function) maps to the backend service in our container model.
    if (ctx.backendTargetUrl) {
      out.proxyLocations.push({ pathPrefix: loc.path, targetUrl: ctx.backendTargetUrl });
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
    if (!isSafeDestination(redirect.destination)) {
      out.skipped.push(`redirect ${redirect.source} (unsafe destination)`);
      continue;
    }
    out.redirects.push({
      path: loc.path,
      exact: loc.exact,
      statusCode: redirectStatus(redirect.statusCode, redirect.permanent),
      destination: redirect.destination,
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
