import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * Retention for mail-server policies.
 *
 * `prunePolicy` used to return early on any policy without a `projectId`, so the
 * one backup source that can carry every stored message on a server was also the
 * one whose runs accumulated forever. These pin the contract now that it doesn't:
 *
 *   • a mail policy's runs page by `mailServerId`, never by project (a project
 *     filter on a null projectId is what made this un-implementable before)
 *   • the org comes off the mail server's row, so a deleted server is a named
 *     skip rather than an unscoped read across the whole table
 *   • artifacts + manifest go to the destination's deleteMany, same as a project
 *   • `retentionLockedUntil` ("Protect this backup") still wins
 *   • a negative retainCount is treated as unset, not as "delete everything"
 */

const h = vi.hoisted(() => ({
  runs: [] as Array<Record<string, unknown>>,
  listCalls: [] as Array<Record<string, unknown>>,
  softDeleted: [] as string[],
  deletedKeys: [] as string[][],
  mailServer: { organizationId: "org1" } as { organizationId: string } | undefined,
  project: undefined as { organizationId: string } | undefined,
  destination: { id: "dest1", kind: "s3" } as Record<string, unknown> | undefined,
}));

vi.mock("@repo/db", () => ({
  repos: {
    project: { findById: vi.fn(async () => h.project) },
    server: { get: vi.fn(async () => h.mailServer) },
    backupPolicy: {
      iterateEnabledForRetention: async function* () {},
    },
    backupRun: {
      listByOrganization: vi.fn(
        async (organizationId: string, opts: Record<string, unknown>) => {
          h.listCalls.push({ organizationId, ...opts });
          // One page, then empty — the caller pages until short.
          return (opts.offset as number) === 0 ? h.runs : [];
        },
      ),
      softDelete: vi.fn(async (id: string) => {
        h.softDeleted.push(id);
      }),
    },
    backupDestination: { findById: vi.fn(async () => h.destination) },
  },
}));

vi.mock("@repo/adapters", () => ({
  // Read at module scope by openship-server-store (imported transitively), so the
  // mock has to carry it or nothing under test loads. Its value is irrelevant here.
  HOST_STATE_DIR: "/root/.openship",
  resolveDestination: () => ({
    // Per-key outcomes, never a throw — the real contract. A mock returning
    // nothing let the prune read a refused delete as a successful one.
    deleteMany: vi.fn(async (keys: string[]) => {
      h.deletedKeys.push(keys);
      return { deleted: keys, failed: [] };
    }),
  }),
}));

vi.mock("../backup-destinations/hydrate-server", () => ({
  toAdapterRow: vi.fn(async (row: unknown) => row),
}));

const { prunePolicy } = await import("./retention-prune");

type PolicyArg = Parameters<typeof prunePolicy>[0];

const mailPolicy = (over: Record<string, unknown> = {}): PolicyArg =>
  ({
    id: "bkp_mail",
    sourceKind: "mail_server",
    projectId: null,
    serviceId: null,
    mailServerId: "srv_mail",
    destinationId: "dest1",
    enabled: true,
    retainCount: 2,
    retainDays: null,
    ...over,
  }) as unknown as PolicyArg;

/** A succeeded mail run, `ageDays` old. */
const run = (id: string, ageDays: number, over: Record<string, unknown> = {}) => ({
  id,
  policyId: "bkp_mail",
  destinationId: "dest1",
  projectId: null,
  serviceId: null,
  mailServerId: "srv_mail",
  status: "succeeded",
  deletedAt: null,
  retentionLockedUntil: null,
  finishedAt: new Date(Date.now() - ageDays * 86_400_000),
  artifacts: [{ key: `mail/${id}.tar.zst` }],
  manifestKey: `mail/${id}.json`,
  ...over,
});

beforeEach(() => {
  h.runs = [];
  h.listCalls = [];
  h.softDeleted = [];
  h.deletedKeys = [];
  h.mailServer = { organizationId: "org1" };
  h.project = undefined;
  h.destination = { id: "dest1", kind: "s3" };
});

describe("prunePolicy — mail-server policies", () => {
  it("pages runs by mailServerId under the mail server's org", async () => {
    h.runs = [run("r1", 1)];
    await prunePolicy(mailPolicy({ retainCount: 5 }));

    expect(h.listCalls[0]).toMatchObject({
      organizationId: "org1",
      mailServerId: "srv_mail",
    });
    // A project filter here would match nothing (projectId is null) — that read
    // returning zero rows is exactly what "not implemented" looked like.
    expect(h.listCalls[0]).not.toHaveProperty("projectId");
  });

  it("drops the runs outside retainCount, newest kept", async () => {
    h.runs = [run("newest", 1), run("middle", 5), run("oldest", 9)];
    const result = await prunePolicy(mailPolicy({ retainCount: 2 }));

    expect(result).toEqual({ dropped: 1, deferred: 0, skipped: null });
    expect(h.softDeleted).toEqual(["oldest"]);
    // Artifacts AND the manifest leave the destination, or the bytes outlive the row.
    expect(h.deletedKeys).toEqual([["mail/oldest.tar.zst", "mail/oldest.json"]]);
  });

  it("drops runs past retainDays", async () => {
    h.runs = [run("fresh", 2), run("stale", 40)];
    const result = await prunePolicy(mailPolicy({ retainCount: null, retainDays: 30 }));

    expect(result.dropped).toBe(1);
    expect(h.softDeleted).toEqual(["stale"]);
  });

  it("never touches a protected run", async () => {
    h.runs = [
      run("newest", 1),
      run("locked", 40, { retentionLockedUntil: new Date(Date.now() + 86_400_000) }),
    ];
    const result = await prunePolicy(mailPolicy({ retainCount: 1, retainDays: 30 }));

    expect(result).toEqual({ dropped: 0, deferred: 0, skipped: null });
    expect(h.softDeleted).toEqual([]);
  });

  it("ignores other policies' runs on the same destination", async () => {
    h.runs = [run("mine", 9), run("theirs", 40, { policyId: "bkp_other" })];
    await prunePolicy(mailPolicy({ retainCount: 1 }));

    expect(h.softDeleted).toEqual([]);
  });

  it("skips by name when the mail server row is gone", async () => {
    h.mailServer = undefined;
    h.runs = [run("r1", 40)];
    const result = await prunePolicy(mailPolicy({ retainCount: 1 }));

    // No org means no scoped read is even possible; deleting on a guess would be
    // a cross-tenant delete.
    expect(result).toEqual({ dropped: 0, deferred: 0, skipped: "mail server row is gone" });
    expect(h.listCalls).toEqual([]);
    expect(h.softDeleted).toEqual([]);
  });

  it("treats a non-positive retainCount as unlimited, not as delete-everything", async () => {
    h.runs = [run("a", 1), run("b", 2), run("c", 3)];
    const result = await prunePolicy(mailPolicy({ retainCount: -1 }));

    expect(result).toEqual({ dropped: 0, deferred: 0, skipped: "retention set to unlimited" });
    expect(h.softDeleted).toEqual([]);
  });

  it("keeps everything when both dimensions are null", async () => {
    h.runs = [run("a", 400)];
    const result = await prunePolicy(mailPolicy({ retainCount: null, retainDays: null }));

    expect(result).toEqual({ dropped: 0, deferred: 0, skipped: "retention set to unlimited" });
  });

  it("still prunes project policies by projectId", async () => {
    h.project = { organizationId: "org2" };
    h.runs = [
      run("p_new", 1, { projectId: "prj1", mailServerId: null, policyId: "bkp_prj" }),
      run("p_old", 9, { projectId: "prj1", mailServerId: null, policyId: "bkp_prj" }),
    ];
    const result = await prunePolicy(
      mailPolicy({ id: "bkp_prj", projectId: "prj1", mailServerId: null, retainCount: 1 }),
    );

    expect(h.listCalls[0]).toMatchObject({ organizationId: "org2", projectId: "prj1" });
    expect(result.dropped).toBe(1);
    expect(h.softDeleted).toEqual(["p_old"]);
  });
});
