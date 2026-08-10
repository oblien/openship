import { describe, expect, it } from "vitest";
import { Value } from "@sinclair/typebox/value";
import type { TSchema } from "@sinclair/typebox";
import { getRouteRegistry, isPublicSpec } from "../../src/lib/route-permission";
import { AddDomainBody } from "../../src/modules/domains/domain.schema";
import { TriggerDeployBody, BuildAccessBody } from "../../src/modules/deployments/deployment.schema";

/**
 * `collectionProject: true` tells `requirePermission` to SKIP the collection
 * `{leaf,"*"}` pre-check because the route's handler asserts
 * `{project, body.projectId, <action>}` itself. That is only safe while the body
 * schema makes `projectId` REQUIRED — the auto-wired validator runs immediately
 * after the permission middleware, so a body without it 400s before the handler
 * (and therefore before anything unauthorized can happen).
 *
 * Make `projectId` optional on one of these schemas and the route silently loses
 * its gate. This test is the ratchet that stops that, for every route carrying
 * the flag — present and future.
 */

const requiresProjectId = (schema: TSchema): boolean =>
  Value.Check(schema, { projectId: "p1", hostname: "app.example.com" }) &&
  !Value.Check(schema, { hostname: "app.example.com" });

describe("collectionProject: the flag's safety precondition", () => {
  it("every route carrying the flag declares a body whose projectId is required", async () => {
    // Importing the route modules is what populates the registry.
    await Promise.all([
      import("../../src/modules/deployments/deployment.routes"),
      import("../../src/modules/domains/domain.routes"),
    ]);

    const flagged = getRouteRegistry().filter(
      (r) => !isPublicSpec(r.spec) && r.spec.collectionProject === true,
    );

    // Guard the guard: if the registry didn't load, an empty list would make
    // every assertion below vacuously pass.
    expect(flagged.length).toBeGreaterThanOrEqual(3);

    for (const route of flagged) {
      const spec = route.spec;
      const body = isPublicSpec(spec) ? undefined : spec.body;
      expect(body, `${route.method} ${route.path} has collectionProject but no body schema`).toBeDefined();
      expect(
        requiresProjectId(body as TSchema),
        `${route.method} ${route.path}: projectId must be REQUIRED — the handler's per-project assert is the only gate left`,
      ).toBe(true);
    }
  });

  it("flagged routes are advertised to a project-scoped MCP principal, not treated as org-wide", async () => {
    await import("../../src/modules/deployments/deployment.routes");
    const { getMcpTools, filterToolsForPrincipal } = await import("../../src/modules/mcp/mcp-tools");

    const deploy = getMcpTools().find((t) => t.method === "POST" && t.path.endsWith("/deployments/build/access"));
    expect(deploy).toBeDefined();
    // Org-wide in shape (no :id), project-scoped in effect.
    expect(deploy!.perm.wildcard).toBe(false);
    expect(deploy!.perm.grantRoot).toBe("project");

    const listed = filterToolsForPrincipal([deploy!], {
      role: "restricted",
      readOnly: false,
      grantedRootTypes: new Set(["project"]),
      canCreateProjects: false,
    });
    expect(listed).toHaveLength(1);

    // Read-only bindings still can't see it — that gate is by HTTP method.
    expect(
      filterToolsForPrincipal([deploy!], {
        role: "restricted",
        readOnly: true,
        grantedRootTypes: new Set(["project"]),
        canCreateProjects: false,
      }),
    ).toHaveLength(0);
  });

  it("the three known bodies reject a missing projectId", () => {
    expect(Value.Check(TriggerDeployBody, { projectId: "p1" })).toBe(true);
    expect(Value.Check(TriggerDeployBody, {})).toBe(false);

    expect(Value.Check(BuildAccessBody, { projectId: "p1" })).toBe(true);
    expect(Value.Check(BuildAccessBody, {})).toBe(false);

    expect(Value.Check(AddDomainBody, { projectId: "p1", hostname: "app.example.com" })).toBe(true);
    expect(Value.Check(AddDomainBody, { hostname: "app.example.com" })).toBe(false);
  });
});
