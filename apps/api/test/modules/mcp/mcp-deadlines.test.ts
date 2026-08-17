import { describe, expect, it } from "vitest";
import {
  MCP_EXECUTION_DEADLINE_MS,
  MCP_READ_TIMEOUT_MS,
  MCP_TOOL_TIMEOUT_MS,
  McpTimeoutError,
  toolTimeoutMs,
  withDeadline,
} from "../../../src/modules/mcp/mcp-timeouts";

describe("MCP deadlines", () => {
  it("keeps the outer deadline larger than per-tool budgets", () => {
    expect(MCP_EXECUTION_DEADLINE_MS).toBeGreaterThan(MCP_TOOL_TIMEOUT_MS);
    expect(MCP_TOOL_TIMEOUT_MS).toBeGreaterThan(MCP_READ_TIMEOUT_MS);
  });

  it("uses the read budget for read-only tools", () => {
    expect(toolTimeoutMs({ readOnly: true })).toBe(MCP_READ_TIMEOUT_MS);
    expect(toolTimeoutMs({ readOnly: false })).toBe(MCP_TOOL_TIMEOUT_MS);
    expect(toolTimeoutMs({ readOnly: true, timeoutMs: 3_000 })).toBe(3_000);
  });

  it("rejects when the deadline elapses", async () => {
    const pending = new Promise<string>(() => {});
    await expect(withDeadline(pending, 20, "MCP_EXECUTION_DEADLINE", "deadline")).rejects.toMatchObject({
      name: "McpTimeoutError",
      code: "MCP_EXECUTION_DEADLINE",
    } satisfies Partial<McpTimeoutError>);
  });

  it("resolves when the work finishes first", async () => {
    await expect(withDeadline(Promise.resolve("ok"), 200, "MCP_TOOL_TIMEOUT", "timeout")).resolves.toBe(
      "ok",
    );
  });
});
