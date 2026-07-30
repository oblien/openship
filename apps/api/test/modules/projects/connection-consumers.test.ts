import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * The SHARED-RESOURCE contract: one database app backs many consumers.
 *
 * "App A and app B both need the same PostgreSQL (app C)" is the normal shape, not
 * an edge case — `project_connection`'s unique index is on `(targetProjectId,
 * envKey)`, deliberately NOT on the source. These pin that:
 *
 *   • one source → many targets is allowed (nothing is target-exclusive)
 *   • the source's own page can enumerate its dependents (`listConsumers`)
 *   • a consumer holding TWO links shows up once per link, grouped by the UI
 *   • cross-org rows are never surfaced, even if data drift produced one
 */

const h = vi.hoisted(() => ({
  links: [] as Array<Record<string, unknown>>,
  projects: new Map<string, Record<string, unknown> | null>(),
  assertCalled: [] as Array<{ resourceId: string; action: string }>,
}));

vi.mock("@repo/db", () => ({
  repos: {
    projectConnection: {
      listBySource: vi.fn(async (sourceId: string) =>
        h.links.filter((l) => l.sourceProjectId === sourceId),
      ),
    },
    project: { findById: vi.fn(async (id: string) => h.projects.get(id) ?? null) },
  },
}));

vi.mock("../../../src/lib/permission", () => ({
  permission: {
    assert: vi.fn(async (_ctx: unknown, req: { resourceId: string; action: string }) => {
      h.assertCalled.push({ resourceId: req.resourceId, action: req.action });
    }),
  },
}));

import { listConsumers } from "../../../src/modules/projects/project-connection.service";

const ctx = { organizationId: "org1", userId: "u1" } as never;

const link = (over: Record<string, unknown> = {}) => ({
  id: "conn_1",
  sourceProjectId: "db-c",
  targetProjectId: "app-a",
  outputId: "dbUrl",
  envKey: "DATABASE_URL",
  mode: "internal",
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  h.links = [];
  h.assertCalled = [];
  h.projects = new Map<string, Record<string, unknown> | null>([
    ["db-c", { id: "db-c", name: "Postgres", slug: "postgres", organizationId: "org1" }],
    ["app-a", { id: "app-a", name: "App A", slug: "app-a", organizationId: "org1" }],
    ["app-b", { id: "app-b", name: "App B", slug: "app-b", organizationId: "org1" }],
  ]);
});

describe("listConsumers — one shared database, many consumers", () => {
  it("returns BOTH apps consuming the same database", async () => {
    h.links = [
      link({ id: "conn_a", targetProjectId: "app-a" }),
      link({ id: "conn_b", targetProjectId: "app-b" }),
    ];

    const out = await listConsumers(ctx, "db-c");

    expect(out.map((c) => c.targetName).sort()).toEqual(["App A", "App B"]);
    expect(out.map((c) => c.targetProjectId).sort()).toEqual(["app-a", "app-b"]);
  });

  it("carries the env key + reach mode per link, so the UI can label each", async () => {
    h.links = [link({ envKey: "DATABASE_URL", mode: "internal" })];
    const [c] = await listConsumers(ctx, "db-c");

    expect(c!.envKey).toBe("DATABASE_URL");
    expect(c!.mode).toBe("internal");
    expect(c!.targetSlug).toBe("app-a");
  });

  it("returns one entry PER LINK when a consumer wires two values", async () => {
    // Grouping is the card's job; the API stays faithful to the rows.
    h.links = [
      link({ id: "conn_1", envKey: "DATABASE_URL" }),
      link({ id: "conn_2", envKey: "DIRECT_URL" }),
    ];

    const out = await listConsumers(ctx, "db-c");
    expect(out).toHaveLength(2);
    expect(new Set(out.map((c) => c.targetProjectId))).toEqual(new Set(["app-a"]));
  });

  it("is empty for an app nothing depends on (card renders nothing)", async () => {
    expect(await listConsumers(ctx, "db-c")).toEqual([]);
  });

  it("requires only READ on the source app", async () => {
    h.links = [link()];
    await listConsumers(ctx, "db-c");

    expect(h.assertCalled).toEqual([{ resourceId: "db-c", action: "read" }]);
  });

  it("never surfaces a consumer from another org", async () => {
    // createConnection can't make one, so this is drift-defence — a foreign name
    // leaking through a read endpoint is a tenant boundary problem.
    h.projects.set("app-b", {
      id: "app-b",
      name: "Someone Else's App",
      slug: "x",
      organizationId: "org2",
    });
    h.links = [
      link({ id: "conn_a", targetProjectId: "app-a" }),
      link({ id: "conn_b", targetProjectId: "app-b" }),
    ];

    const out = await listConsumers(ctx, "db-c");
    expect(out.map((c) => c.targetName)).toEqual(["App A"]);
  });

  it("falls back to the id when the consumer row is gone (never throws)", async () => {
    h.projects.set("app-a", null);
    h.links = [link()];

    const [c] = await listConsumers(ctx, "db-c");
    expect(c!.targetName).toBe("Unknown");
    expect(c!.targetProjectId).toBe("app-a");
  });
});
