import { describe, expect, it } from "vitest";
import { getRouteRegistry, isPublicSpec } from "../../../src/lib/route-permission";

/**
 * MCP exposure for the blocked-deploy story.
 *
 * The gap this closes: `POST /:id/build/respond` was already a tool, but
 * `GET /:id/build` — the ONLY payload naming the prompt's action ids — was not.
 * An agent had the button and no way to learn what to press, so it either
 * guessed "free_port" or let the deploy time out. A tool is only usable if the
 * information needed to call it is also reachable, and these assert that both
 * halves are exposed together.
 *
 * Tools are generated from the route registry (see mcp-tools.ts): a route is a
 * tool if and only if its spec declares an `mcp` block. So dropping that block is
 * how this silently regresses, and that is exactly what these check.
 */

const REQUIRED_MCP_ROUTES: Array<{ method: string; path: string; why: string }> = [
  {
    method: "GET",
    path: "/api/projects/:id/pending-actions",
    why: "the project-wide list of what needs a human, with each item's resolution",
  },
  {
    method: "GET",
    path: "/api/deployments/:id/pending",
    why: "what one deploy is waiting on — the thing to poll when it looks stuck",
  },
  {
    method: "GET",
    path: "/api/deployments/:id/build",
    why: "carries pendingPrompt, whose actions[].id is the only source of the id build/respond needs",
  },
  {
    method: "POST",
    path: "/api/deployments/:id/build/respond",
    why: "answers a held prompt — useless without the two reads above",
  },
  {
    method: "POST",
    path: "/api/deployments/:id/skip-port-check",
    why: "dismisses a port advisory surfaced by the pending list",
  },
  {
    method: "GET",
    path: "/api/projects/:id/incidents",
    why: "container-runtime health (crash loops, unhealthy/down) — the health story pending-actions deliberately does not cover",
  },
];

describe("pending-actions MCP exposure", () => {
  it("exposes the discover + resolve pair as tools", async () => {
    // Importing the route modules is what populates the registry.
    await Promise.all([
      import("../../../src/modules/deployments/deployment.routes"),
      import("../../../src/modules/projects/project.routes"),
    ]);
    const registry = getRouteRegistry();

    for (const want of REQUIRED_MCP_ROUTES) {
      const route = registry.find((r) => r.method === want.method && r.path === want.path);
      expect(route, `${want.method} ${want.path} is not registered`).toBeTruthy();
      const spec = route!.spec;
      expect(isPublicSpec(spec), `${want.path} must stay permission-gated`).toBe(false);
      expect(
        isPublicSpec(spec) ? undefined : spec.mcp,
        `${want.method} ${want.path} lost its mcp block — ${want.why}`,
      ).toBeTruthy();
    }
  });

  it("tells an agent not to invent an action id", async () => {
    await import("../../../src/modules/deployments/deployment.routes");
    const respond = getRouteRegistry().find(
      (r) => r.method === "POST" && r.path === "/api/deployments/:id/build/respond",
    );
    const spec = respond!.spec;
    const description = isPublicSpec(spec) ? "" : (spec.mcp?.description ?? "");
    // The ids are not guessable and a wrong one silently does nothing (the
    // registry only resolves an exact match), so the description has to send the
    // caller to the payload that lists them.
    expect(description).toMatch(/pending-actions|build-status/i);
    expect(description.toLowerCase()).toContain("free_port");
  });

  it("keeps the pending reads read-only, so a read-only token still sees them", async () => {
    // filterToolsForPrincipal drops every non-GET tool for a read-only token.
    // These are diagnosis surfaces — an agent that may only look must still be
    // able to say WHY a deploy is stuck.
    await Promise.all([
      import("../../../src/modules/deployments/deployment.routes"),
      import("../../../src/modules/projects/project.routes"),
    ]);
    const registry = getRouteRegistry();
    for (const path of ["/api/projects/:id/pending-actions", "/api/deployments/:id/pending"]) {
      const route = registry.find((r) => r.method === "GET" && r.path === path);
      const spec = route!.spec;
      expect(isPublicSpec(spec) ? "" : spec.tag).toMatch(/:read$/);
    }
  });
});
