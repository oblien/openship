import { expect } from "vitest";

/** Real JSON-RPC transport. No direct dispatcher or engine shortcuts. */
export function mcpTestClient(options: {
  request: (path: string, init: RequestInit) => Promise<Response> | Response;
  token: string;
  organizationId: string;
}) {
  let id = 0;
  async function rpc<T>(method: string, params?: Record<string, unknown>): Promise<T> {
    const response = await options.request("/api/mcp", {
      method: "POST",
      headers: { Authorization: `Bearer ${options.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
    });
    expect(response.status, await response.clone().text()).toBe(200);
    const envelope = (await response.json()) as { result?: T; error?: unknown };
    expect(envelope.error).toBeUndefined();
    expect(envelope.result).toBeDefined();
    return envelope.result!;
  }
  async function result<T>(name: string, args: Record<string, unknown> = {}) {
    const envelope = await rpc<{ isError: boolean; content: { type: string; text: string }[] }>(
      "tools/call",
      { name, arguments: { organizationId: options.organizationId, ...args } },
    );
    return { isError: envelope.isError, data: JSON.parse(envelope.content[0].text) as T };
  }
  async function call<T>(name: string, args: Record<string, unknown> = {}): Promise<T> {
    const output = await result<T>(name, args);
    expect(output.isError, JSON.stringify(output.data)).toBe(false);
    return output.data;
  }
  return { rpc, result, call };
}
