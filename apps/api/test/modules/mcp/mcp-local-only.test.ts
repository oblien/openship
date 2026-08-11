/**
 * A `localOnly` route is not advertised as an MCP tool on the hosted control plane.
 *
 * The bug this pins: `app.ts` mounts the jobs router unconditionally, while
 * `job.routes.ts` restricts it to self-hosted. When that restriction was applied as
 * `r.use("*", localOnly)` it never reached the route REGISTRY — Hono middleware is
 * invisible there — so `getMcpTools()` had no way to know, and all 11 jobs tools
 * were listed on the SaaS where every one of them 404s. Router-level `localOnly` is
 * now a `secureRouter` option that folds into each registered spec, which is what
 * makes this filterable at all.
 *
 * Registry entries are written at module-import time, so importing the route module
 * is what populates them; `resetMcpToolCache()` is what stops the memo from freezing
 * a list built under the wrong mode.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

// `vi.hoisted` because vi.mock is lifted above ordinary top-level declarations —
// a plain const here is not initialized when the factory runs.
// `vi.hoisted` because vi.mock is lifted above ordinary top-level declarations —
// a plain const here is not initialized when the factory runs.
//
// Spread the real modules and override only CLOUD_MODE: these config modules export
// far more than `env`, and importing the jobs route module pulls in enough of the
// app that a bare `{ env }` factory breaks on the first missing export.
// CLOUD_MODE is a live GETTER, not a spread value: the tests flip modes between
// assertions, and a copied boolean would freeze at whatever it was when the mock
// factory ran.
const { envMock } = vi.hoisted(() => ({ envMock: { CLOUD_MODE: false } }));
function liveEnv<T extends { env: Record<string, unknown> }>(actual: T) {
  return {
    ...actual,
    env: {
      ...actual.env,
      get CLOUD_MODE() {
        return envMock.CLOUD_MODE;
      },
    },
  };
}
vi.mock("../../../src/config", async (importOriginal) =>
  liveEnv(await importOriginal<typeof import("../../../src/config")>()),
);
vi.mock("../../../src/config/env", async (importOriginal) =>
  liveEnv(await importOriginal<typeof import("../../../src/config/env")>()),
);

import { getRouteRegistry } from "../../../src/lib/route-permission";
import { getMcpTools, resetMcpToolCache } from "../../../src/modules/mcp/mcp-tools";
// Imported for its side effect: registering the jobs routes. Jobs is the module the
// original bug was found in, and it is 100% mcp-annotated, so it is the sharpest probe.
import "../../../src/modules/jobs/job.routes";

function toolPaths(): string[] {
  return getMcpTools().map((t) => `${t.method} ${t.path}`);
}

beforeEach(() => {
  envMock.CLOUD_MODE = false;
  resetMcpToolCache();
});
afterEach(() => {
  envMock.CLOUD_MODE = false;
  resetMcpToolCache();
});

describe("the registry knows a route is self-hosted-only", () => {
  it("every jobs route carries localOnly in its SPEC, not just in middleware", () => {
    const jobRoutes = getRouteRegistry().filter((r) => r.module === "jobs");
    expect(jobRoutes.length, "jobs routes should be registered").toBeGreaterThan(0);
    for (const r of jobRoutes) {
      expect(r.spec.localOnly, `${r.method} ${r.path}`).toBe(true);
    }
  });
});

describe("tools/list respects the mode", () => {
  it("self-hosted advertises the jobs tools", () => {
    const paths = toolPaths();
    expect(paths).toContain("GET /api/jobs/");
    expect(paths).toContain("POST /api/jobs/");
  });

  it("cloud advertises NONE of them", () => {
    envMock.CLOUD_MODE = true;
    resetMcpToolCache();
    const paths = toolPaths();
    expect(paths.filter((p) => p.includes("/api/jobs"))).toEqual([]);
  });

  it("cloud drops exactly the localOnly tools and keeps the rest", () => {
    const selfHosted = new Set(toolPaths());
    envMock.CLOUD_MODE = true;
    resetMcpToolCache();
    const cloud = new Set(toolPaths());

    const dropped = [...selfHosted].filter((p) => !cloud.has(p));
    const added = [...cloud].filter((p) => !selfHosted.has(p));

    expect(added, "switching to cloud must never ADD a tool").toEqual([]);
    expect(dropped.length, "expected the localOnly tools to be dropped").toBeGreaterThan(0);

    // Every dropped tool must be justified by its own spec — this is the assertion
    // that would catch the filter dropping something for the wrong reason.
    const localOnlyPaths = new Set(
      getRouteRegistry()
        .filter((r) => r.spec.localOnly)
        .map((r) => `${r.method} ${r.path}`),
    );
    for (const p of dropped) {
      expect(localOnlyPaths.has(p), `${p} was dropped but is not localOnly`).toBe(true);
    }
  });
});

describe("the memo cannot freeze a list built under the wrong mode", () => {
  it("resetMcpToolCache re-derives from the current mode", () => {
    const first = toolPaths().length;
    envMock.CLOUD_MODE = true;
    // No reset: the memo is deliberately still serving the self-hosted list.
    expect(toolPaths().length).toBe(first);
    resetMcpToolCache();
    expect(toolPaths().length).toBeLessThan(first);
  });
});
