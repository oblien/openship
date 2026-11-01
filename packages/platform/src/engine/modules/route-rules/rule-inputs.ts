import type { RouteRuleSpec } from "@repo/core";

/** HTTP methods accepted in an access method allow-list. */
const HTTP_METHODS = new Set([
  "GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "TRACE", "CONNECT",
]);
/** Response codes a rule may return on block (keeps arbitrary/odd codes out). */
const BLOCK_STATUSES = new Set([401, 403, 404, 429, 444, 451, 503]);

/**
 * Sanitize a client-supplied spec into the trusted RouteRuleSpec shape.
 * Everything is allow-listed/clamped here so the edge only ever sees validated
 * data: no control chars (CRLF/header-injection), bounded list/string sizes,
 * ISO-2 countries, known methods/statuses. The Lua guard treats every value as
 * data (never a pattern), but we still normalize defensively at the boundary.
 *
 * Exported for tests: it is the whole boundary between a request body and what the
 * edge enforces.
 */
export function sanitizeSpec(input: unknown): RouteRuleSpec {
  const spec = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const out: RouteRuleSpec = {};

  // Reject empty/oversized/control-char strings; cap list length.
  const strList = (v: unknown, maxLen = 64): string[] | undefined =>
    Array.isArray(v)
      ? v
          .filter(
            (s): s is string =>
              typeof s === "string" &&
              s.length > 0 &&
              s.length <= maxLen &&
              !/[\u0000-\u001f\u007f]/.test(s),
          )
          .slice(0, 256)
      : undefined;

  const country2 = (list?: string[]) =>
    list?.map((c) => c.toUpperCase()).filter((c) => /^[A-Z]{2}$/.test(c));

  const rl = spec.rateLimit as Record<string, unknown> | undefined;
  if (rl && typeof rl === "object") {
    const rps = Number(rl.rps);
    const burst = Number(rl.burst);
    const status = Number(rl.status);
    if (Number.isFinite(rps) && rps > 0) {
      out.rateLimit = {
        rps: Math.floor(rps),
        burst: Number.isFinite(burst) && burst >= 0 ? Math.floor(burst) : 0,
        key: "ip",
        ...(BLOCK_STATUSES.has(status) ? { status } : {}),
      };
    }
  }

  const banIn = spec.ban as Record<string, unknown> | undefined;
  if (banIn && typeof banIn === "object") {
    const ban: NonNullable<RouteRuleSpec["ban"]> = {};
    const ips = strList(banIn.ips);
    const cidrs = strList(banIn.cidrs);
    const countries = country2(strList(banIn.countries));
    const userAgents = strList(banIn.userAgents, 128);
    if (ips?.length) ban.ips = ips;
    if (cidrs?.length) ban.cidrs = cidrs;
    if (countries?.length) ban.countries = countries;
    if (userAgents?.length) ban.userAgents = userAgents;
    if (banIn.emptyUserAgent === true) ban.emptyUserAgent = true;
    if (Object.keys(ban).length) out.ban = ban;
  }

  const accessIn = spec.access as Record<string, unknown> | undefined;
  if (accessIn && typeof accessIn === "object") {
    const access: NonNullable<RouteRuleSpec["access"]> = {};
    const allow = strList(accessIn.allowCidrs);
    const deny = strList(accessIn.denyCidrs);
    const allowCountries = country2(strList(accessIn.allowCountries));
    const methods = strList(accessIn.methods, 12)
      ?.map((m) => m.toUpperCase())
      .filter((m) => HTTP_METHODS.has(m));
    if (allow?.length) access.allowCidrs = allow;
    if (deny?.length) access.denyCidrs = deny;
    if (allowCountries?.length) access.allowCountries = allowCountries;
    if (methods?.length) access.methods = Array.from(new Set(methods));
    if (Object.keys(access).length) out.access = access;
  }

  const hotIn = spec.hotlink as Record<string, unknown> | undefined;
  if (hotIn && typeof hotIn === "object") {
    const referers = strList(hotIn.allowReferers, 253)?.map((h) => h.toLowerCase());
    if (referers?.length) {
      out.hotlink = { allowReferers: referers, allowEmpty: hotIn.allowEmpty !== false };
    }
  }

  const blockStatus = Number((spec.block as Record<string, unknown> | undefined)?.status);
  if (BLOCK_STATUSES.has(blockStatus)) out.block = { status: blockStatus };

  return out;
}

/** Exported for tests: decides which rule a request's path matches. */
export function normalizePathPrefix(p: string | null | undefined): string | null {
  if (!p) return null;
  const s = p.trim();
  if (!s || s === "/") return null;
  const withSlash = s.startsWith("/") ? s : `/${s}`;
  return withSlash.slice(0, 512);
}

