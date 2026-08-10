import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * `unlinkConsumersOfSource` — what happens to the projects using an app when
 * that app is deleted.
 *
 * The contract teardown depends on: the injected env var is removed from each
 * consuming project and the link row dropped, NOTHING about the consumer's own
 * workload is touched, and one bad link can't hide the others (teardown keeps
 * the project row when `errors` comes back non-empty).
 */

const h = vi.hoisted(() => ({
  projects: {} as Record<string, { id: string; name: string; organizationId: string } | null>,
  mergeEnvVars: vi.fn(async () => ({}) as never),
  deleteLink: vi.fn(async (_id: string) => {}),
}));

vi.mock("@repo/db", () => ({
  repos: {
    project: { findById: vi.fn(async (id: string) => h.projects[id] ?? null) },
    projectConnection: { delete: h.deleteLink },
  },
}));
vi.mock("./project-env.service", () => ({ mergeEnvVars: h.mergeEnvVars }));
vi.mock("../apps/catalog-source", () => ({ getTemplateForOrg: vi.fn(async () => null) }));
vi.mock("../apps/app-settings.service", () => ({ getAppConnectionView: vi.fn(async () => ({ outputs: [] })) }));
vi.mock("../../lib/permission", () => ({ permission: { assert: vi.fn(async () => {}) } }));

import { unlinkConsumersOfSource } from "./project-connection.service";

beforeEach(() => {
  vi.clearAllMocks();
  h.projects = {
    "app-a": { id: "app-a", name: "storefront", organizationId: "org1" },
    "app-b": { id: "app-b", name: "admin", organizationId: "org1" },
  };
});

describe("unlinkConsumersOfSource", () => {
  it("removes the injected env var from each project and drops the link", async () => {
    const res = await unlinkConsumersOfSource([
      { id: "conn_a", targetProjectId: "app-a", envKey: "DATABASE_URL" },
      { id: "conn_b", targetProjectId: "app-b", envKey: "MONGO_URL" },
    ]);

    expect(h.mergeEnvVars).toHaveBeenCalledWith("app-a", "org1", {
      environment: "production",
      upserts: [],
      deletes: ["DATABASE_URL"],
    });
    expect(h.deleteLink).toHaveBeenCalledWith("conn_a");
    expect(h.deleteLink).toHaveBeenCalledWith("conn_b");
    expect(res.errors).toEqual([]);
    // Reported by NAME — the caller tells the user which projects to redeploy.
    expect(res.unlinked).toEqual([
      { linkId: "conn_a", projectId: "app-a", projectName: "storefront", envKey: "DATABASE_URL" },
      { linkId: "conn_b", projectId: "app-b", projectName: "admin", envKey: "MONGO_URL" },
    ]);
  });

  it("skips the env merge when the consuming project is already gone", async () => {
    // Its own delete cascaded the link away (target FK is ON DELETE CASCADE), so
    // there's no env var left to clean — merging against a missing project would
    // just throw and block the app's delete.
    h.projects["app-a"] = null;

    const res = await unlinkConsumersOfSource([
      { id: "conn_a", targetProjectId: "app-a", envKey: "DATABASE_URL" },
    ]);

    expect(h.mergeEnvVars).not.toHaveBeenCalled();
    expect(h.deleteLink).toHaveBeenCalledWith("conn_a");
    expect(res.errors).toEqual([]);
  });

  it("collects a failure and keeps going instead of aborting on the first bad link", async () => {
    h.mergeEnvVars.mockRejectedValueOnce(new Error("db down"));

    const res = await unlinkConsumersOfSource([
      { id: "conn_a", targetProjectId: "app-a", envKey: "DATABASE_URL" },
      { id: "conn_b", targetProjectId: "app-b", envKey: "MONGO_URL" },
    ]);

    expect(res.errors).toEqual(["DATABASE_URL on storefront: db down"]);
    expect(res.unlinked.map((u) => u.linkId)).toEqual(["conn_b"]);
    // The failed link's row survives — there's still an env var pointing at it.
    expect(h.deleteLink).not.toHaveBeenCalledWith("conn_a");
  });
});
