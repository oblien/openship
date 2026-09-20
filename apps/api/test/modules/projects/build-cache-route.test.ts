import { describe, expect, it } from "vitest";
import { getRouteRegistry, isPublicSpec } from "../../../src/lib/route-permission";

describe("project build-cache route", () => {
  it("is registered as a self-hosted, project-admin action", async () => {
    await import("../../../src/modules/projects/project.routes");
    const route = getRouteRegistry().find(
      (entry) => entry.method === "POST" && entry.path === "/api/projects/:id/clear-build",
    );

    expect(route).toBeTruthy();
    expect(isPublicSpec(route!.spec)).toBe(false);
    if (isPublicSpec(route!.spec)) throw new Error("route unexpectedly public");
    expect(route!.spec.tag).toBe("project:admin");
    expect(route!.spec.localOnly).toBe(true);
    expect(route!.spec.mcp?.description).toMatch(/host-wide/i);
  });
});
