import { app } from "../../app";
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

// Base host is irrelevant — Hono routes on the path. No Origin header is set,
// so the PAT (a non-browser credential) is accepted by authMiddleware.
const INTERNAL_BASE = "http://mcp.internal";

export async function dispatchTool(
  tool: McpToolDef,
  args: Record<string, unknown>,
  bearerToken: string,
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

  const headers: Record<string, string> = { authorization: `Bearer ${bearerToken}` };
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
