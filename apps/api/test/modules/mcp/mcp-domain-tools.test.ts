import { beforeEach, describe, expect, it } from "vitest";
import "../../../src/modules/domains/domain.routes";
import { getMcpTools, resetMcpToolCache } from "../../../src/modules/mcp/mcp-tools";

describe("Domain routes MCP tool generation", () => {
  beforeEach(() => {
    resetMcpToolCache();
  });

  it("exposes delete_domains_by_id tool for DELETE /api/domains/:id", () => {
    const tools = getMcpTools();
    const deleteTool = tools.find((t) => t.method === "DELETE" && t.path === "/api/domains/:id");
    expect(deleteTool).toBeDefined();
    expect(deleteTool?.name).toBe("delete_domains_by_id");
    expect(deleteTool?.description).toMatch(/Delete a domain/i);
  });
});
