import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the DB layer the helper reads (links + source project slugs).
const listByTarget = vi.fn();
const findById = vi.fn();
const listByDeployment = vi.fn();
vi.mock("@repo/db", () => ({
  repos: {
    projectConnection: { listByTarget: (...a: unknown[]) => listByTarget(...a) },
    project: { findById: (...a: unknown[]) => findById(...a) },
    // The consumer's OWN container ids, passed explicitly because an adopted container
    // keeps its original labels and the `openship.project` filter cannot see it.
    service: { listByDeployment: (...a: unknown[]) => listByDeployment(...a) },
  },
}));

import { attachLinkedNetworks, linkedNetworkName } from "./attach-linked-networks";

describe("attachLinkedNetworks", () => {
  beforeEach(() => {
    listByTarget.mockReset();
    findById.mockReset();
    listByDeployment.mockReset().mockResolvedValue([]);
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
    expect(attach).toHaveBeenCalledWith("target", ["openship-supabase", "openship-mongo"], []);
  });

  /**
   * An ADOPTED (in-place migrated) container keeps its ORIGINAL `openship.*` labels —
   * labels are immutable — so `attachToExternalNetworks`'s `openship.project=<id>` filter
   * is structurally blind to it. Connecting an app to a migrated project in internal mode
   * therefore wrote the alias (`db:5432`) into the consumer's env and never joined the
   * container to the source's network: the connection failed to resolve at runtime while
   * the UI reported success. Naming the stored container ids — the identity the READ paths
   * already use — is what closes it.
   */
  it("names the consumer's stored container ids, so an adopted container is joined too", async () => {
    listByTarget.mockResolvedValue([{ mode: "internal", sourceProjectId: "s1" }]);
    findById.mockImplementation(async (id: string) =>
      id === "s1" ? { slug: "supabase" } : { activeDeploymentId: "dep-1" },
    );
    listByDeployment.mockResolvedValue([
      { containerId: "adopted-web-1" },
      { containerId: null }, // no container → nothing to join
      { containerId: "adopted-db-1" },
    ]);
    const attach = vi.fn().mockResolvedValue(undefined);

    await attachLinkedNetworks("target", { attachToExternalNetworks: attach });

    expect(attach).toHaveBeenCalledWith("target", ["openship-supabase"], [
      "adopted-web-1",
      "adopted-db-1",
    ]);
  });

  it("passes no ids when the consumer has no active deployment", async () => {
    listByTarget.mockResolvedValue([{ mode: "internal", sourceProjectId: "s1" }]);
    findById.mockImplementation(async (id: string) =>
      id === "s1" ? { slug: "supabase" } : { activeDeploymentId: null },
    );
    const attach = vi.fn().mockResolvedValue(undefined);
    await attachLinkedNetworks("target", { attachToExternalNetworks: attach });
    expect(attach).toHaveBeenCalledWith("target", ["openship-supabase"], []);
    expect(listByDeployment).not.toHaveBeenCalled();
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
