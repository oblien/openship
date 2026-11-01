import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionDependencies } from "../../../actions";
import type { ExecutionContext } from "../../../context";

const h = vi.hoisted(() => ({ fetch: vi.fn(), warn: vi.fn() }));
vi.mock("@repo/core/diagnostics", () => ({ diagnostics: { warn: h.warn } }));
vi.mock("../../config/index", () => ({ env: { CLOUD_MODE: false } }));
vi.mock("../../lib/cloud/resource-authority", () => ({
  canDiscoverCloudResources: () => true,
  resolveResourceAuthority: async () => "local",
}));
vi.mock("../../lib/cloud/scope", () => ({ assertCloudProxyScope: () => {} }));
vi.mock("../../lib/cloud/server-reference", () => ({
  cloudRequestReferences: async (_: string, input: unknown) => input,
}));
vi.mock("../../lib/cloud/transport", () => ({
  cloudFetchAsOrgOwner: h.fetch,
  resolveOrgCloudUserId: async () => "cloud-user",
  readCloudJson: async (res: { json?: () => Promise<unknown> } | null) =>
    res && typeof res.json === "function" ? res.json() : null,
}));
import { withCloudActions } from "./cloud-operations";

const ctx = { organizationId: "local-org" } as ExecutionContext;
const rows = [{ id: "local-row" }];

beforeEach(() => {
  h.fetch.mockReset();
  h.warn.mockReset();
});

// A Cloud response that readCloudJson accepts: application/json with the given body.
const cloudJson = (body: unknown) => ({
  ok: true,
  headers: { get: (key: string) => (key.toLowerCase() === "content-type" ? "application/json" : null) },
  json: async () => body,
});

describe("Cloud Actions discovery", () => {
  it.each(["list", "listRuns", "runners", "projects"] as const)(
    "keeps local %s when Cloud is unreachable",
    async (name) => {
      h.fetch.mockResolvedValue(null);
      const local = {
        collection: { [name]: async () => rows },
        resources: {},
      } as unknown as ActionDependencies;
      expect(await withCloudActions(local).collection[name](ctx, {} as never)).toEqual(rows);
      expect(h.fetch).toHaveBeenCalledOnce();
    },
  );
});

describe("listRuns Cloud augmentation", () => {
  // Regression for the merge sort calling .localeCompare() on a Date createdAt.
  // Cloud discovery is enabled (mocks above), workflowId omitted, Cloud returns [],
  // and the two local runs carry Date createdAt (as Drizzle timestamp columns do).
  it("sorts merged runs newest-first when createdAt is a Date", async () => {
    h.fetch.mockResolvedValue(cloudJson({ data: [] }));
    const older = { id: "older", createdAt: new Date("2026-10-22T07:00:00.000Z") };
    const newer = { id: "newer", createdAt: new Date("2026-10-22T18:00:00.000Z") };
    const local = {
      // Returned oldest-first on purpose: the sort must reorder them.
      collection: { listRuns: async () => [older, newer] },
      resources: {},
    } as unknown as ActionDependencies;

    const result = (await withCloudActions(local).collection.listRuns(
      ctx,
      {} as never,
    )) as Array<{ id: string }>;

    expect(result.map((run) => run.id)).toEqual(["newer", "older"]);
    expect(h.warn).not.toHaveBeenCalled();
  });

  // Merging/sorting the Cloud result must never hide local Actions: a throw inside
  // the augmentation falls back to the unchanged local list and logs a warning.
  it("falls back to local runs and warns when the merge throws", async () => {
    h.fetch.mockResolvedValue(cloudJson({ data: [] }));
    // A null row makes the merge's `.map(row => [row.id, row])` throw.
    const localRuns = [{ id: "a", createdAt: new Date("2026-10-22T10:00:00.000Z") }, null];
    const local = {
      collection: { listRuns: async () => localRuns },
      resources: {},
    } as unknown as ActionDependencies;

    const result = await withCloudActions(local).collection.listRuns(ctx, {} as never);

    expect(result).toBe(localRuns); // unchanged local list returned on fallback
    expect(h.warn).toHaveBeenCalledOnce();
    // Distinguish the merge catch from the Cloud-fetch catch (both warn once):
    // assert the merge-specific message so a fetch/parse failure can't pass this test.
    expect(h.warn).toHaveBeenCalledWith(
      expect.any(String),
      expect.stringContaining("Could not merge Cloud listRuns"),
      expect.anything(),
      expect.anything(),
    );
  });
});
