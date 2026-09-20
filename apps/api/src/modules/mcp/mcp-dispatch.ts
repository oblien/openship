import { app } from "../../app";
import { internalClientHeader, internalSourceHeader } from "../../lib/call-source";
import type { McpToolDef } from "./mcp-tools";

/**
 * Execute a tool by dispatching an internal request through the real Hono app.
 * This is the ONLY execution path — routing, validation, PAT auth, permission
 * checks, and the controller/service all run exactly as they do over HTTP, so
 * no business logic is duplicated. The caller's PAT is forwarded so the
 * sub-request re-authenticates and is permission-scoped to that identity.
 */
export interface DispatchResult {
  status: number;
  ok: boolean;
  data: unknown;
}

/**
 * What the sub-request can't work out for itself.
 *
 * An in-process dispatch has no TCP peer and no browser to send headers, so
 * without this the audit row for an MCP-driven write recorded the loopback
 * address, no user agent, and no way to tell one connected assistant from
 * another. All three are read off the OUTER request, which is a real HTTP request
 * from the real client.
 */
export interface DispatchOrigin {
  /** Canonical principal id — `oauth:<clientId>` / `pat:<tokenId>`. */
  principalId: string;
  /** The outer request's resolved client IP. */
  clientIp: string | null;
  /** The outer request's user agent (the MCP client's, e.g. `claude-desktop/1.2`). */
  userAgent: string | null;
}

// Base host is irrelevant — Hono routes on the path. No Origin header is set,
// so the PAT (a non-browser credential) is accepted by authMiddleware.
const INTERNAL_BASE = "http://mcp.internal";

export async function dispatchTool(
  tool: McpToolDef,
  args: Record<string, unknown>,
  bearerToken: string,
  origin: DispatchOrigin,
): Promise<DispatchResult> {
  // Fill path params.
  let path = tool.path;
  for (const param of tool.pathParams) {
    const value = args[param];
    if (value === undefined || value === null || `${value}` === "") {
      return { status: 400, ok: false, data: { error: `Missing required path parameter: ${param}` } };
    }
    path = path.replace(`:${param}`, encodeURIComponent(String(value)));
  }
  // The registry stores root routes as `${basePath}/` (trailing slash), which
  // Hono's router 404s. Normalize to the no-trailing-slash form the routes match.
  path = path.replace(/\/+$/, "") || "/";

  // Query string (optional `query` object arg).
  const url = new URL(path, INTERNAL_BASE);
  const query = args.query;
  if (query && typeof query === "object") {
    for (const [k, v] of Object.entries(query as Record<string, unknown>)) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }
  }

  // The nonce-signed source marker is the only thing that tells the audit log an
  // action came from an AI assistant rather than a script — everything else about
  // this sub-request looks like an ordinary token call, by design. The client
  // marker is signed the same way; the IP and UA are plain, because for an
  // in-process dispatch `x-real-ip` is already trusted (no TCP peer ⇒ it can only
  // have come from us — see client-ip.ts) and the UA is not a gate anywhere.
  const headers: Record<string, string> = {
    authorization: `Bearer ${bearerToken}`,
    ...internalSourceHeader("mcp"),
    ...internalClientHeader(origin.principalId),
  };
  if (origin.clientIp) headers["x-real-ip"] = origin.clientIp;
  if (origin.userAgent) headers["user-agent"] = origin.userAgent;
  const orgId = args.organizationId;
  if (typeof orgId === "string" && orgId) headers["x-organization-id"] = orgId;

  let body: string | undefined;
  if (tool.hasBody && args.body && typeof args.body === "object") {
    headers["content-type"] = "application/json";
    body = JSON.stringify(args.body);
  }

  const res = await app.fetch(
    new Request(url.toString(), { method: tool.method, headers, body }),
  );

  const text = await res.text();
  let data: unknown = text;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON response — return the raw text */
  }
  return { status: res.status, ok: res.ok, data };
}
