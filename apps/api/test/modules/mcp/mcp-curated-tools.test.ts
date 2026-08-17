import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CURATED_OPERATOR_TOOLS,
  findMcpTool,
  getMcpTools,
  listToolsForPrincipal,
  resetMcpToolCache,
  type McpPrincipal,
} from "../../../src/modules/mcp/mcp-tools";
import { collapseLongRunning, extractOperationId } from "../../../src/modules/mcp/mcp-dispatch";
import { wantsAdvancedTools } from "../../../src/modules/mcp/mcp-server";

import "../../../src/modules/projects/project.routes";
import "../../../src/modules/deployments/deployment.routes";
import "../../../src/modules/services/service.routes";
import "../../../src/modules/system/system.routes";
import "../../../src/modules/audit/audit.routes";

const owner: McpPrincipal = {
  role: "owner",
  readOnly: false,
  grantedRootTypes: new Set(),
  wildcardGrants: new Map(),
  canCreateProjects: true,
};

beforeEach(() => {
  resetMcpToolCache();
  delete process.env.OPENSHIP_MCP_ADVANCED_TOOLS;
});
afterEach(() => {
  resetMcpToolCache();
  delete process.env.OPENSHIP_MCP_ADVANCED_TOOLS;
});

describe("curated operator MCP tools", () => {
  it("advertises every curated name from spec.mcp.name", () => {
    const names = new Set(getMcpTools().map((t) => t.name));
    for (const name of CURATED_OPERATOR_TOOLS) {
      expect(names.has(name), name).toBe(true);
      expect(findMcpTool(name)?.advanced).toBe(false);
    }
  });

  it("prefixes generated REST tools with advanced.", () => {
    const sync = findMcpTool("post_projects_by_id_services_sync");
    expect(sync).toBeDefined();
    expect(sync!.advanced).toBe(true);
    expect(sync!.name).toBe("advanced.post_projects_by_id_services_sync");
  });

  it("hides advanced tools from the default catalog", () => {
    const listed = listToolsForPrincipal(getMcpTools(), owner);
    expect(listed.every((t) => !t.advanced)).toBe(true);
    expect(listed.map((t) => t.name)).toEqual(expect.arrayContaining([...CURATED_OPERATOR_TOOLS]));
    expect(listed.some((t) => t.name.startsWith("advanced."))).toBe(false);
  });

  it("includes advanced tools when opted in", () => {
    const listed = listToolsForPrincipal(getMcpTools(), owner, { includeAdvanced: true });
    expect(listed.some((t) => t.name.startsWith("advanced."))).toBe(true);
    expect(wantsAdvancedTools({ includeAdvanced: true })).toBe(true);
    expect(wantsAdvancedTools({})).toBe(false);
  });

  it("collapses long-running payloads to operationId", () => {
    expect(extractOperationId({ operationId: "dep_1" })).toBe("dep_1");
    expect(extractOperationId({ data: { deployment_id: "dep_2" } })).toBe("dep_2");
    expect(collapseLongRunning({ data: { id: "dep_3", logs: "…" } })).toEqual({ operationId: "dep_3" });
  });
});
