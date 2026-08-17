import {
  getMcpTools,
  toClientTool,
  listToolsForPrincipal,
  findMcpTool,
  CURATED_OPERATOR_TOOLS,
  type McpPrincipal,
} from "./mcp-tools";
import { dispatchTool, type DispatchOrigin } from "./mcp-dispatch";
import type { ToolCallRecord } from "./mcp-audit";
import { listPrompts, getPrompt } from "./mcp-prompts";
import { MCP_EXECUTION_DEADLINE_MS, McpTimeoutError, withDeadline } from "./mcp-timeouts";

/**
 * Minimal MCP server over JSON-RPC 2.0 (Streamable HTTP transport, stateless).
 * Implements the surface a tools + prompts server needs: initialize, ping,
 * tools/list, tools/call, prompts/list, prompts/get. Server-initiated messaging
 * (SSE stream) isn't used — every tool is a synchronous request/response mapped
 * onto the real HTTP API; prompts are the static guided-flow catalog.
 */

const SERVER_INFO = { name: "openship", version: "1.0.0" };
const DEFAULT_PROTOCOL = "2025-06-18";
/** Versions we can speak; `initialize` negotiates down to one of these. */
const SUPPORTED_PROTOCOLS = new Set(["2025-06-18", "2025-03-26", "2024-11-05"]);

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

function result(id: JsonRpcRequest["id"], value: unknown) {
  return { jsonrpc: "2.0" as const, id: id ?? null, result: value };
}

/** tools/list extra params — MCP clients ignore unknown fields, so this is additive. */
export function wantsAdvancedTools(params?: Record<string, unknown>): boolean {
  if (!params) return false;
  return params.includeAdvanced === true || params.advanced === true;
}
/** JSON-RPC error envelope — shared with mcp.routes.ts so the shape stays single-sourced. */
export function jsonRpcError(id: JsonRpcRequest["id"], code: number, message: string) {
  return { jsonrpc: "2.0" as const, id: id ?? null, error: { code, message } };
}

export interface McpMessageContext {
  /** The caller's credential, forwarded to dispatch so sub-requests re-auth. */
  bearerToken: string;
  /** Effective capability, for `tools/list` filtering. */
  principal: McpPrincipal;
  /** Facts only the outer HTTP request knows — see DispatchOrigin. */
  origin: DispatchOrigin;
  /** Called once per executed tool call, after it returns. */
  onToolCall?: (record: ToolCallRecord) => void;
}

/**
 * Handle one JSON-RPC message. Returns the response object, or null for
 * notifications (no `id` → no reply).
 */
export async function handleMcpMessage(
  msg: JsonRpcRequest,
  { bearerToken, principal, origin, onToolCall }: McpMessageContext,
): Promise<object | null> {
  const isNotification = msg.id === undefined || msg.id === null;

  // Reject malformed envelopes up front (JSON-RPC 2.0 → Invalid Request).
  if (msg.jsonrpc !== "2.0" || typeof msg.method !== "string") {
    return jsonRpcError(msg.id, -32600, "Invalid Request");
  }

  switch (msg.method) {
    case "initialize": {
      // Negotiate: honour the client's version only if we speak it, else offer ours.
      const requested = msg.params?.protocolVersion as string | undefined;
      const protocolVersion =
        requested && SUPPORTED_PROTOCOLS.has(requested) ? requested : DEFAULT_PROTOCOL;
      return result(msg.id, {
        protocolVersion,
        capabilities: {
          tools: { listChanged: false },
          prompts: { listChanged: false },
        },
        serverInfo: {
          ...SERVER_INFO,
          curatedTools: [...CURATED_OPERATOR_TOOLS],
          advancedTools: {
            prefix: "advanced.",
            includeVia: "tools/list params.includeAdvanced or OPENSHIP_MCP_ADVANCED_TOOLS=1",
          },
          ...(process.env.OPENSHIP_CONTROL_PLANE_FINGERPRINT
            ? {
                fingerprint: process.env.OPENSHIP_CONTROL_PLANE_FINGERPRINT,
                advertisedOrigin: process.env.OPENSHIP_ADVERTISED_ORIGIN,
              }
            : {}),
        },
      });
    }

    case "notifications/initialized":
    case "initialized":
      return null; // ack-only notification

    case "ping":
      return result(msg.id, {});

    case "tools/list":
      // Advertise only what this caller can actually use (call-time still
      // enforces on tools/call). Default catalog is the curated operator set;
      // generated REST tools stay behind includeAdvanced / the env flag.
      return result(msg.id, {
        tools: listToolsForPrincipal(getMcpTools(), principal, {
          includeAdvanced: wantsAdvancedTools(msg.params),
        }).map(toClientTool),
      });

    case "tools/call": {
      const name = msg.params?.name as string | undefined;
      const args = (msg.params?.arguments as Record<string, unknown>) ?? {};
      const tool = findMcpTool(name);
      if (!tool) return jsonRpcError(msg.id, -32602, `Unknown tool: ${name}`);

      const ac = new AbortController();
      try {
        const dispatched = await withDeadline(
          dispatchTool(tool, args, bearerToken, origin, { signal: ac.signal }),
          MCP_EXECUTION_DEADLINE_MS,
          "MCP_EXECUTION_DEADLINE",
          `MCP execution deadline exceeded after ${MCP_EXECUTION_DEADLINE_MS}ms`,
        );
        onToolCall?.({
          tool: tool.name,
          method: tool.method,
          path: tool.path,
          action: tool.perm.action,
          status: dispatched.status,
          ok: dispatched.ok,
        });
        return result(msg.id, {
          content: [{ type: "text", text: JSON.stringify(dispatched.data, null, 2) }],
          isError: !dispatched.ok,
        });
      } catch (err) {
        ac.abort();
        if (err instanceof McpTimeoutError) {
          onToolCall?.({
            tool: tool.name,
            method: tool.method,
            path: tool.path,
            action: tool.perm.action,
            status: 504,
            ok: false,
          });
          return result(msg.id, {
            content: [{ type: "text", text: JSON.stringify({ error: err.message, code: err.code }, null, 2) }],
            isError: true,
          });
        }
        throw err;
      }
    }

    case "prompts/list":
      // The guided-flow catalog (see mcp-prompts). Static and identical for every
      // caller — prompts are documentation, not privileged actions.
      return result(msg.id, { prompts: listPrompts() });

    case "prompts/get": {
      const name = msg.params?.name as string | undefined;
      const args = (msg.params?.arguments as Record<string, string>) ?? {};
      const prompt = name ? getPrompt(name, args) : null;
      if (!prompt) return jsonRpcError(msg.id, -32602, `Unknown prompt: ${name}`);
      return result(msg.id, prompt);
    }

    default:
      return isNotification ? null : jsonRpcError(msg.id, -32601, `Method not found: ${msg.method}`);
  }
}
