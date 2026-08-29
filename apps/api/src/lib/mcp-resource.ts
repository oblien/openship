/**
 * RFC 8707 / RFC 9728 resource identity for this instance's MCP endpoint.
 *
 * An MCP client that follows the current authorization spec (Claude.ai does;
 * most others don't yet) treats the MCP server URL — *including its path* — as
 * the OAuth **resource**. It discovers Protected Resource Metadata at the
 * path-aware well-known location (`/.well-known/oauth-protected-resource` +
 * the resource's path), sends `resource=<that URL>` on both the authorization
 * and the token request, and expects the issued token to be audience-bound to
 * it. Advertising the bare origin as the `resource` fails that match.
 *
 * This module is the single source of truth for:
 *   - which URLs name the MCP endpoint of THIS instance (canonical + aliases),
 *   - how a client-supplied `resource` value is canonicalized before comparison,
 *   - the Protected Resource Metadata document served for each of them.
 *
 * Everything is derived from the instance's public origin — nothing is
 * hardcoded to a domain.
 */

import { requestPublicOrigin } from "./public-url";

/** Path the MCP JSON-RPC endpoint is mounted at (`app.route("/api/mcp", …)`). */
export const MCP_RESOURCE_PATH = "/api/mcp";

/**
 * The same endpoint reached through the dashboard's same-origin proxy. On a
 * self-hosted box the public host serves the dashboard and the API lives under
 * `/api/proxy` (see lib/public-url.ts), so a client configured with that URL is
 * talking to the same resource.
 */
export const MCP_PROXY_RESOURCE_PATH = "/api/proxy/api/mcp";

/** Every path that addresses this instance's MCP endpoint. Canonical first. */
export const MCP_RESOURCE_PATHS: readonly string[] = [
  MCP_RESOURCE_PATH,
  MCP_PROXY_RESOURCE_PATH,
];

/**
 * Canonical form of a resource identifier, per RFC 8707 §2: lowercase scheme
 * and host, no default port, no trailing slash, no query, no fragment. Returns
 * null when the value isn't an absolute http(s) URL.
 */
export function canonicalizeResource(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  // `URL` already lowercases scheme + host and drops the default port.
  const path = url.pathname.replace(/\/+$/, "");
  return `${url.origin}${path}`;
}

/** Public origin (scheme + host, no path) this request was addressed to. */
export function publicOriginFor(req: Request): string {
  const raw = requestPublicOrigin(req);
  try {
    return new URL(raw).origin;
  } catch {
    return raw.replace(/\/+$/, "");
  }
}

/**
 * The request's own URL rewritten onto the PUBLIC origin.
 *
 * `request.url` is the origin the API was reached on internally. Behind the
 * dashboard's same-origin proxy that is the upstream authority (`http://api:4000`)
 * because the proxy rewrites `Host`. Anything we hand back to a browser — above
 * all a redirect in the middle of the OAuth flow — has to be rebuilt on the
 * public origin or it points at a host the client cannot resolve.
 */
export function publicRequestUrl(req: Request): URL {
  const requested = new URL(req.url);
  return new URL(`${requested.pathname}${requested.search}`, publicOriginFor(req));
}

/** The canonical MCP resource identifier for an origin: `<origin>/api/mcp`. */
export function canonicalMcpResource(origin: string): string {
  return `${origin.replace(/\/+$/, "")}${MCP_RESOURCE_PATH}`;
}

/** Swap an absolute http(s) URL's origin for `origin`, keeping path/query/hash.
 *  A bare-origin value (pathname `/`) stays bare (no trailing slash). Anything
 *  that isn't an absolute http(s) URL passes through untouched. */
function rewriteUrlOrigin(value: string, origin: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return value;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return value;
  const path = url.pathname === "/" ? "" : url.pathname;
  return `${origin}${path}${url.search}${url.hash}`;
}

/** Recursive half of `rewriteMetadataOrigin`. Input is always `JSON.parse`
 *  output, so only plain objects / arrays / scalars occur. */
function rewriteNode(node: unknown, origin: string): unknown {
  if (typeof node === "string") return rewriteUrlOrigin(node, origin);
  if (Array.isArray(node)) return node.map((item) => rewriteNode(item, origin));
  if (node !== null && typeof node === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node)) out[key] = rewriteNode(value, origin);
    return out;
  }
  return node;
}

/**
 * Re-point every absolute http(s) URL in a discovery-metadata document onto
 * `origin`, at ANY depth.
 *
 * Better Auth builds both MCP discovery documents from its STATIC baseURL —
 * materialised at startup with no request in scope. On a box whose API container
 * has no OPENSHIP_PUBLIC_URL that origin is the internal upstream
 * (`http://api:4000`), so the advertised authorize/token endpoints name a host
 * the external OAuth client can't reach (#543). Rewriting onto the origin the
 * request actually arrived on lines discovery up with the request-scoped
 * WWW-Authenticate hint, our own path-aware protected-resource metadata, and the
 * `iss` the token handler already stamps — one reachable host end to end.
 *
 * The rule is one invariant applied uniformly: a string that parses as an
 * absolute http(s) URL is re-pointed, anything else is returned as-is. That is
 * what makes a blind full-document walk safe — every non-URL value in these
 * documents (`scopes_supported`, `claims_supported`, the `urn:` values in
 * `acr_values_supported`) fails the parse-or-protocol check and passes through
 * untouched. Walking everything rather than the fields we know about today is
 * deliberate: `authorization_servers` holds its URL inside an ARRAY, and the
 * plugin spreads caller-supplied `options.metadata` into the document, so a
 * top-level-strings-only pass would silently miss both.
 */
export function rewriteMetadataOrigin<T extends Record<string, unknown>>(
  metadata: T,
  origin: string,
): T {
  return rewriteNode(metadata, origin.replace(/\/+$/, "")) as T;
}

/**
 * Every resource identifier that names this instance's MCP endpoint, canonical
 * first. The bare origin is included as a LEGACY value: it is what the root
 * Protected Resource Metadata document has always advertised, so tokens already
 * issued to clients that echoed it back must keep working.
 */
export function allowedMcpResources(origin: string): readonly string[] {
  const base = origin.replace(/\/+$/, "");
  return [...MCP_RESOURCE_PATHS.map((p) => `${base}${p}`), base];
}

/**
 * Is a client-supplied `resource` one of ours? Compares CANONICALIZED URLs, so
 * `HTTPS://Ship.Example.NET/api/mcp/` matches `https://ship.example.net/api/mcp`.
 */
export function isAllowedMcpResource(raw: string | null | undefined, origin: string): boolean {
  const value = canonicalizeResource(raw);
  if (!value) return false;
  return allowedMcpResources(origin).some((allowed) => canonicalizeResource(allowed) === value);
}

/**
 * The audience an access token gets when the client asked for `raw`. An
 * unrecognized value is the caller's error (`invalid_target`) — check with
 * `isAllowedMcpResource` first. A missing value (legacy clients that predate
 * RFC 8707) falls back to the canonical MCP URL so their tokens still carry a
 * usable audience.
 */
export function resolveTokenAudience(raw: string | null | undefined, origin: string): string {
  return canonicalizeResource(raw) ?? canonicalMcpResource(origin);
}

/** Where a client discovers the metadata for a given MCP resource path. */
export function protectedResourceMetadataUrl(origin: string, path: string): string {
  return `${origin.replace(/\/+$/, "")}/.well-known/oauth-protected-resource${path}`;
}

export interface ProtectedResourceMetadata {
  resource: string;
  authorization_servers: string[];
  jwks_uri: string;
  scopes_supported: string[];
  bearer_methods_supported: string[];
  resource_signing_alg_values_supported: string[];
}

/**
 * RFC 9728 Protected Resource Metadata for one resource identifier. Mirrors the
 * document better-auth's mcp() plugin serves at the root, except `resource` is
 * the FULL MCP URL (with path) rather than the bare origin.
 */
export function protectedResourceMetadata(
  origin: string,
  resource: string,
): ProtectedResourceMetadata {
  const base = origin.replace(/\/+$/, "");
  return {
    resource,
    authorization_servers: [base],
    jwks_uri: `${base}/api/auth/mcp/jwks`,
    scopes_supported: ["openid", "profile", "email", "offline_access"],
    bearer_methods_supported: ["header"],
    resource_signing_alg_values_supported: ["RS256", "none"],
  };
}
