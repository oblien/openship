import { describe, expect, it } from "vitest";
import { getRouteRegistry } from "../../lib/route-permission";
import { projectRoutes } from "./project.routes";

function swarmRoute(method: string, path: string) {
  const route = getRouteRegistry().find((candidate) =>
    candidate.method === method && candidate.path === "/api/projects" + path,
  );
  expect(route, `missing registered Swarm route ${method} ${path}`).toBeDefined();
  return route!;
}

describe("project Swarm route permissions", () => {
  it("keeps every manager inspection endpoint read-only", () => {
    // Referencing the exported router ensures its secure-router declarations
    // have registered before the assertions below.
    expect(projectRoutes).toBeDefined();

    for (const [method, path] of [
      ["GET", "/:id/swarm/source"],
      ["GET", "/:id/swarm/managed-inputs"],
      ["GET", "/:id/swarm/observation"],
      ["POST", "/:id/swarm/observation/refresh"],
      ["GET", "/:id/swarm/connection"],
      ["POST", "/:id/swarm/source/validate"],
      ["POST", "/:id/swarm/source/render"],
      ["GET", "/:id/swarm/services/:serviceName/logs"],
      ["GET", "/:id/swarm/services/:serviceName/logs/stream"],
    ]) {
      expect(swarmRoute(method, path).spec).toMatchObject({ tag: "project:read", readOnly: true });
    }
  });

  it("requires a project write grant for every operational change", () => {
    for (const [method, path] of [
      ["POST", "/:id/swarm/stack"],
      ["POST", "/:id/swarm/managed-inputs"],
      ["DELETE", "/:id/swarm/managed-inputs/:inputId"],
      ["POST", "/:id/swarm/connection/rebind"],
      ["PUT", "/:id/swarm/source"],
      ["PATCH", "/:id/swarm/registry"],
      ["PATCH", "/:id/swarm/routing"],
      ["PUT", "/:id/swarm/storage-acknowledgements"],
      ["PUT", "/:id/swarm/volume-replacement-acknowledgements"],
      ["POST", "/:id/swarm/claim"],
      ["POST", "/:id/swarm/services/:serviceName/scale"],
      ["POST", "/:id/swarm/services/:serviceName/restart"],
    ]) {
      expect(swarmRoute(method, path).spec).toMatchObject({ tag: "project:write" });
    }
  });

  it("reserves destructive management actions for project admins", () => {
    expect(swarmRoute("GET", "/:id/swarm/handoff").spec).toMatchObject({
      tag: "project:admin",
      readOnly: true,
    });
    expect(swarmRoute("POST", "/:id/swarm/release-management").spec).toMatchObject({ tag: "project:admin" });
    expect(swarmRoute("POST", "/:id/swarm/remove").spec).toMatchObject({ tag: "project:admin" });
  });
});
