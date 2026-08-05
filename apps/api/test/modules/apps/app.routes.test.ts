import { beforeAll, describe, expect, it } from "vitest";
import { getRouteRegistry, isPublicSpec } from "../../../src/lib/route-permission";

describe("apps routes are permission-scoped correctly", () => {
  beforeAll(async () => {
    // Importing the route module populates the global secure-router registry.
    await import("../../../src/modules/apps/app.routes");
  });

  it("POST /api/apps/custom is a collection-scoped write route", () => {
    const route = getRouteRegistry().find(
      (r) => r.method === "POST" && r.path === "/api/apps/custom",
    );

    expect(route, "POST /api/apps/custom must be registered").toBeDefined();

    const spec = route!.spec;
    expect(isPublicSpec(spec)).toBe(false);
    if (isPublicSpec(spec)) throw new Error("POST /api/apps/custom must be a permission route");

    expect(spec.collection).toBe(true);
  });
});
