import assert from "node:assert/strict";
import { test } from "node:test";
import { mcpSurface } from "./generate-mcp-reference.mjs";
import { moduleHttpSurface } from "./docs-http.mjs";

const route = {
  method: "GET",
  path: "/api/projects",
  module: "projects",
  access: "project:list",
  source: "routes.ts",
};

test("the complete route inventory has unique MCP tools or intentional exclusions", () => {
  const { tools, httpOnly } = mcpSurface();
  assert.ok(tools.length > 300);
  assert.equal(tools.length, new Set(tools.map((tool) => tool.name)).size);
  assert.ok(tools.every((tool) => tool.name.length <= 64 && /^[a-zA-Z0-9_]+$/.test(tool.name)));
  assert.ok(!tools.some((tool) => tool.path.startsWith("/api/system/clusters")));
  assert.ok(
    tools.some((tool) => tool.path === "/api/system/networks/operations/:operationId/apply"),
  );
  assert.ok(tools.some((tool) => tool.path === "/api/projects/:id/cluster/scale"));
  assert.equal(tools.filter((tool) => tool.path === "/api/billing/state").length, 1);
  assert.ok(httpOnly.some((tool) => tool.path === "/api/jobs/runs/:runId/stream"));
});

test("coverage cannot silently ignore a new authenticated route or advertise a stream", () => {
  assert.throws(() => mcpSurface([route]), /Classify MCP coverage/);
  assert.throws(() => mcpSurface([{ ...route, mcp: { description: "" } }]), /description/);
  assert.throws(
    () => mcpSurface([{ ...route, path: "/api/projects/stream", mcp: { description: "Live" } }]),
    /JSON operation/,
  );
  assert.throws(
    () => mcpSurface([{ ...route, module: "tokens", mcp: { description: "Mint" } }]),
    /Non-tool/,
  );
  const entry = { ...route, mcp: { description: "List projects" } };
  assert.equal(mcpSurface([entry, entry]).tools.length, 1);
  assert.throws(() => mcpSurface([entry, { ...entry, mcp: { description: "Drift" } }]), /disagree/);
});

test("canonical loop metadata and router-level exclusions match runtime inheritance", () => {
  const rows = moduleHttpSurface(
    "routes.ts",
    `
    const r = secureRouter(new Hono(), { module: "system", basePath: "/api/system", mcpExcluded: "Browser only" });
    for (const base of ["/networks", "/clusters"]) {
      r.get(base, { tag: "server:list", mcp: base === "/networks" ? { description: "List private networks" } : undefined }, handler);
    }
  `,
  );
  const { tools, httpOnly } = mcpSurface(rows);
  assert.equal(tools[0].path, "/api/system/networks");
  assert.equal(httpOnly[0].path, "/api/system/clusters");
  assert.equal(httpOnly[0].reason, "Browser only");
});
