import { app } from "../../app";
import { ENV_MASK } from "@repo/core";
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

const SECRET_RESPONSE_KEYS = new Set([
  "accesskey",
  "accesstoken",
  "apikey",
  "clientsecret",
  "clonetokenencrypted",
  "credentials",
  "envvars",
  "hmacsecretencrypted",
  "password",
  "privatekey",
  "privatekeypem",
  "refreshtoken",
  "secret",
  "secretsenc",
  "token",
  "tokenencrypted",
  "webhooksecret",
]);

function normalizedKey(key: string): string {
  return key.replace(/[^a-z0-9]/gi, "").toLowerCase();
}

/**
 * Last-line MCP projection for GET and explicitly read-only tools. HTTP
 * presenters remain the primary boundary, but an accidental raw repository
 * field must not reach an assistant transcript or its spillover cache.
 * Environment/build maps keep only their keys and mask every value; encrypted
 * snapshots and credential fields are omitted entirely.
 */
export function sanitizeReadOnlyToolPayload(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeReadOnlyToolPayload);
  if (!value || typeof value !== "object") return value;
  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const normalized = normalizedKey(key);
    if (
      SECRET_RESPONSE_KEYS.has(normalized) ||
      (typeof child === "string" &&
        (normalized.endsWith("encrypted") || normalized.endsWith("enc")))
    )
      continue;
    if (
      (normalized === "environment" || normalized === "buildargs") &&
      child &&
      typeof child === "object" &&
      !Array.isArray(child)
    ) {
      output[key] = Object.fromEntries(
        Object.keys(child as Record<string, unknown>).map((name) => [name, ENV_MASK]),
      );
      continue;
    }
    output[key] = sanitizeReadOnlyToolPayload(child);
  }
  return output;
}

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
      return {
        status: 400,
        ok: false,
        data: { error: `Missing required path parameter: ${param}` },
      };
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

  const res = await app.fetch(new Request(url.toString(), { method: tool.method, headers, body }));

  const text = await res.text();
  let data: unknown = text;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON response — return the raw text */
  }
  return {
    status: res.status,
    ok: res.ok,
    data:
      tool.method === "GET" || tool.annotations.readOnlyHint
        ? sanitizeReadOnlyToolPayload(data)
        : data,
  };
}
