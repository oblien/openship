import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the DB layer the helper reads (links + source project slugs).
const listByTarget = vi.fn();
const findById = vi.fn();
vi.mock("@repo/db", () => ({
  repos: {
    projectConnection: { listByTarget: (...a: unknown[]) => listByTarget(...a) },
    project: { findById: (...a: unknown[]) => findById(...a) },
  },
}));

import { attachLinkedNetworks, linkedNetworkName } from "./attach-linked-networks";

describe("attachLinkedNetworks", () => {
  beforeEach(() => {
    listByTarget.mockReset();
    findById.mockReset();
  });

  it("attaches the consumer to each INTERNAL-linked source's openship-<slug> network (public links ignored)", async () => {
    listByTarget.mockResolvedValue([
      { mode: "internal", sourceProjectId: "s1" },
      { mode: "public", sourceProjectId: "s2" }, // must be skipped
      { mode: "internal", sourceProjectId: "s3" },
    ]);
    findById.mockImplementation(async (id: string) =>
      ({ s1: { slug: "supabase" }, s3: { slug: "mongo" } })[id] ?? null,
    );
    const attach = vi.fn().mockResolvedValue(undefined);

    await attachLinkedNetworks("target", { attachToExternalNetworks: attach });

    expect(attach).toHaveBeenCalledTimes(1);
    expect(attach).toHaveBeenCalledWith("target", ["openship-supabase", "openship-mongo"]);
  });

  it("no-ops (never reads links) when the runtime can't join external networks — e.g. cloud", async () => {
    await attachLinkedNetworks("target", {});
    expect(listByTarget).not.toHaveBeenCalled();
  });

  it("does not call attach when there are no internal links", async () => {
    listByTarget.mockResolvedValue([{ mode: "public", sourceProjectId: "s2" }]);
    findById.mockResolvedValue({ slug: "x" });
    const attach = vi.fn();
    await attachLinkedNetworks("target", { attachToExternalNetworks: attach });
    expect(attach).not.toHaveBeenCalled();
  });

  it("is advisory — swallows errors and never throws", async () => {
    listByTarget.mockRejectedValue(new Error("db down"));
    await expect(
      attachLinkedNetworks("t", { attachToExternalNetworks: vi.fn() }),
    ).resolves.toBeUndefined();
  });

  it("linkedNetworkName builds openship-<slug>", () => {
    expect(linkedNetworkName("foo")).toBe("openship-foo");
  });
});
