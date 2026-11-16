import { expect, it } from "vitest";
import { renderServerEdgePages, readServerEdgePages, renderMaintenanceGuard } from "./edge-pages";
import { compileEdgePages, type EdgePages } from "@repo/core";

it("round-trips large server documents and keeps every nginx data token bounded", () => {
  const config: EdgePages = {
    files: [
      { id: "error", name: "error.html", html: `<html>${"a' } $host; #\n".repeat(4000)}</html>` },
    ],
    errors: [{ status: 502, pageId: "error" }],
    defaultPageId: "error",
  };
  const output = renderServerEdgePages(config);
  expect(readServerEdgePages(output)).toEqual(config);
  expect(output).not.toContain(config.files[0].html);
  expect(output).toContain("table.concat");
  for (const line of output.split("\n")) expect(line.length).toBeLessThan(2300);
  expect(() => readServerEdgePages("corrupt saved data")).toThrow("left unchanged");
});

it("only adds a maintenance guard when enabled, keeping HTML out of Lua source", () => {
  const pages = {
    files: [{ id: "maintenance", name: "maintenance.html", html: "' } os.execute('bad') --" }],
    errors: [],
    maintenance: { enabled: true, retryAfter: 300, pageId: "maintenance" },
  };
  expect(renderMaintenanceGuard(compileEdgePages(pages))).not.toContain("os.execute");
  expect(
    renderMaintenanceGuard(
      compileEdgePages({ ...pages, maintenance: { ...pages.maintenance, enabled: false } }),
    ),
  ).toBe("");
});
