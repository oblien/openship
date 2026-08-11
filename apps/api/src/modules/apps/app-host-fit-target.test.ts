import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `GET /apps/catalog/:id/host-fit` — WHICH machine the app's declared minimum is
 * matched against.
 *
 * `isLocalTarget` is what makes a `source: "local"` capacity probe trusted, and that
 * probe reads the API host's OWN `os.*`. So it has to be derived from the server row,
 * not read off the query string: a caller naming "local" for a remote server would
 * have had the app sized against the orchestrator's RAM and been told about a
 * shortfall on the wrong box. Same `isLocalHostRow` test the deploy path uses, so the
 * advisory notice here and the preflight refusal describe one machine.
 */

const h = vi.hoisted(() => ({
  /** Every getTrustedHostCapacity call: the server asked about, and the claim. */
  probes: [] as Array<{ serverId?: string; isLocalTarget: boolean }>,
  rows: {} as Record<string, { id: string; isLocal: boolean } | undefined>,
}));

vi.mock("./catalog-source", () => ({
  getTemplateForOrg: async (_org: string, id: string) => ({
    id,
    minResources: { memoryMb: 2048 },
  }),
  getRuntimeCatalog: async () => [],
  listOrgCustomApps: async () => [],
}));

// Partial: the installer's module graph reaches auth/provision-user, which
// destructures `schema` at import time — a repos-only stub fails to LOAD.
vi.mock("@repo/db", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  repos: {
    server: {
      getInOrganization: async (id: string) => h.rows[id] ?? null,
    },
    project: { findDraftByAppTemplate: async () => null },
  },
}));

// The same predicate the deploy path uses; keyed off the flag here so the test
// doesn't depend on loopback resolution or env.
vi.mock("../../lib/box-org", () => ({
  isLocalHostRow: async (row: { isLocal?: boolean }) => Boolean(row?.isLocal),
}));

vi.mock("../../lib/host-capacity", () => ({
  getTrustedHostCapacity: async (
    serverId: string | undefined,
    _org: string,
    opts: { isLocalTarget?: boolean },
  ) => {
    h.probes.push({ serverId, isLocalTarget: Boolean(opts?.isLocalTarget) });
    return { memoryMb: 4096, cpus: 2, diskGb: 40, source: "docker" as const };
  },
}));

const { getAppHostFit } = await import("./app-install.service");

const ctx = { userId: "u1", organizationId: "org1" } as never;
const fit = (target: { deployTarget?: string; serverId?: string }) =>
  getAppHostFit(ctx, "some-app", target);

beforeEach(() => {
  h.probes = [];
  h.rows = {
    "srv-local": { id: "srv-local", isLocal: true },
    "srv-remote": { id: "srv-remote", isLocal: false },
  };
});

describe("getAppHostFit — the destination is derived, not claimed", () => {
  it("ignores a caller claiming 'local' for a REMOTE server", async () => {
    await fit({ deployTarget: "local", serverId: "srv-remote" });
    expect(h.probes).toEqual([{ serverId: "srv-remote", isLocalTarget: false }]);
  });

  it("trusts the local probe for this box's own row", async () => {
    await fit({ deployTarget: "server", serverId: "srv-local" });
    expect(h.probes).toEqual([{ serverId: "srv-local", isLocalTarget: true }]);
  });

  it("treats no server at all as this box — an unbound project derives exactly that", async () => {
    await fit({ deployTarget: "server" });
    expect(h.probes).toEqual([{ serverId: undefined, isLocalTarget: true }]);
  });

  it("reports unknown for a server this org doesn't own, without probing anything", async () => {
    const res = await fit({ deployTarget: "server", serverId: "srv-other-tenant" });
    expect(h.probes).toEqual([]);
    expect(res.capacity.source).toBe("unknown");
    expect(res.fit.ok).toBe(true);
  });

  it("skips the match for cloud, which is sized from the tier table", async () => {
    const res = await fit({ deployTarget: "cloud" });
    expect(h.probes).toEqual([]);
    expect(res.fit.ok).toBe(true);
  });
});
