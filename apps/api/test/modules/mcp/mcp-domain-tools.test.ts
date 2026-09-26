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

  it("exposes start, status, check and cancel with project permission scopes and lifecycle guidance", () => {
    const tools = getMcpTools();
    const status = tools.find((t) => t.method === "GET" && t.path === "/api/domains/:id/dns/challenge")!;
    expect(status.description).toMatch(/actual ACME TXT record/);
    expect(status.annotations.readOnlyHint).toBe(true);
    for (const suffix of ["", "/check", "/cancel"]) {
      const tool = tools.find((t) => t.method === "POST" && t.path === `/api/domains/:id/dns/challenge${suffix}`)!;
      expect(tool).toBeDefined();
      expect(tool.perm).toMatchObject({ root: "domain", grantRoot: "project", action: "write" });
      expect(tool.hasBody).toBe(true);
      expect(tool.annotations.readOnlyHint).toBe(false);
      expect(JSON.stringify(tool.inputSchema)).not.toMatch(/orderEnc|accountKey|keyPem/);
    }
    expect(tools.find((t) => t.method === "POST" && t.path === "/api/domains/:id/dns/challenge")?.description).toMatch(/Manual renewals/);
    expect(tools.find((t) => t.path === "/api/domains/:id/dns/challenge/check")?.description).toContain("attemptId");
  });
});
