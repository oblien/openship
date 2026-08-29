import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * The edge's copy of "is per-path collection on?" lives in a shared dict — RAM, lost on
 * every nginx restart. Postgres is the source of truth and this pusher is the only thing
 * that reconciles the two, which makes its failure modes the whole story:
 *
 *  - **Under-push**: a host that never receives the flag silently collects nothing, and the
 *    card shows an empty list that looks like "no traffic" rather than "not switched on".
 *  - **Over-push**: pushing to a host the project no longer owns keeps paying ~1.7 µs per
 *    request for data nobody can see.
 *  - **Push-on-enable-only**: turning it OFF has to reach the box too, or the edge keeps
 *    collecting after the UI says it stopped.
 */

const h = vi.hoisted(() => ({
  project: null as Record<string, unknown> | null,
  domains: [] as Array<{ id: string; hostname: string }>,
  pushes: [] as Array<{ serverId: string | null; path: string; body: unknown }>,
  allProjects: [] as Array<Record<string, unknown>>,
  sourcesByProject: {} as Record<string, Array<Record<string, unknown>>>,
}));

vi.mock("@repo/db", () => ({
  repos: {
    project: {
      findById: vi.fn(async () => h.project),
      listAllForScan: vi.fn(async () => h.allProjects),
    },
    domain: { listByProject: vi.fn(async () => h.domains) },
  },
}));

vi.mock("../../../src/lib/project-analytics", () => ({
  postEdgeMgmt: vi.fn(async (serverId: string | null, path: string, body: unknown) => {
    h.pushes.push({ serverId, path, body });
  }),
  resolveProjectTrafficSources: vi.fn(async (id: string) => h.sourcesByProject[id] ?? []),
}));

const { pushProjectAnalyticsConfig, reconcileAnalyticsConfig } = await import(
  "../../../src/modules/analytics/analytics-config.service"
);

beforeEach(() => {
  h.project = { id: "p1", collectPaths: true, cloudWorkspaceId: null };
  h.domains = [
    { id: "d1", hostname: "a.com" },
    { id: "d2", hostname: "B.com" },
  ];
  h.pushes = [];
  h.allProjects = [];
  h.sourcesByProject = {};
});

/**
 * Every host across every push, sorted.
 *
 * The payload is BATCHED — one round trip carrying all of a box's hosts — because the
 * reconcile runs this against servers with dozens of domains, and through an SSH tunnel the
 * round trip is the cost. So the assertion has to flatten, not index.
 */
type Entry = { host: string; paths: boolean };
const entries = (): Entry[] =>
  h.pushes
    .flatMap((p) => (p.body as { hosts: Entry[] }).hosts)
    .sort((a, b) => a.host.localeCompare(b.host));
const hosts = () => entries().map((e) => e.host);

describe("who receives the flag", () => {
  it("pushes to every hostname the project serves, lowercased, in ONE call", async () => {
    await pushProjectAnalyticsConfig("p1", "srv1");
    expect(hosts()).toEqual(["a.com", "b.com"]);
    expect(h.pushes).toHaveLength(1);
    // The edge keys its counters by a lowercased host; pushing `B.com` would write a key no
    // request ever reads.
    expect(h.pushes.every((p) => p.path === "/analytics/config")).toBe(true);
    expect(h.pushes.every((p) => p.serverId === "srv1")).toBe(true);
  });

  it("clears hosts whose domain row was removed", async () => {
    await pushProjectAnalyticsConfig("p1", "srv1", ["Old.com"]);
    expect(hosts()).toEqual(["a.com", "b.com", "old.com"]);
  });

  it("pushes each host once when a prior hostname is still current", async () => {
    await pushProjectAnalyticsConfig("p1", "srv1", ["a.com"]);
    expect(hosts()).toEqual(["a.com", "b.com"]);
  });

  it("targets local when there is no server", async () => {
    await pushProjectAnalyticsConfig("p1", null);
    expect(h.pushes.every((p) => p.serverId === null)).toBe(true);
  });
});

describe("what the flag says", () => {
  it("sends paths:true when collection is on", async () => {
    await pushProjectAnalyticsConfig("p1", "srv1");
    expect(entries()).toEqual([
      { host: "a.com", paths: true },
      { host: "b.com", paths: true },
    ]);
  });

  it("STILL pushes when collection is off — turning it off must reach the box", async () => {
    h.project = { id: "p1", collectPaths: false, cloudWorkspaceId: null };
    await pushProjectAnalyticsConfig("p1", "srv1");
    // Skipping the push here would leave the edge collecting after the UI says it stopped.
    expect(hosts()).toEqual(["a.com", "b.com"]);
    expect(entries().every((e) => e.paths === false)).toBe(true);
  });

  it("treats a missing column as off, never as on", async () => {
    h.project = { id: "p1", cloudWorkspaceId: null };
    await pushProjectAnalyticsConfig("p1", "srv1");
    expect(entries().every((e) => e.paths === false)).toBe(true);
  });
});

describe("when it does nothing at all", () => {
  it("skips a cloud project — Oblien's edge is not OpenResty", async () => {
    h.project = { id: "p1", collectPaths: true, cloudWorkspaceId: "ws1" };
    await pushProjectAnalyticsConfig("p1", null);
    expect(h.pushes).toHaveLength(0);
  });

  it("skips a project with no domains rather than pushing an empty host", async () => {
    h.domains = [];
    await pushProjectAnalyticsConfig("p1", "srv1");
    expect(h.pushes).toHaveLength(0);
  });

  it("does not throw when the project is gone", async () => {
    h.project = null;
    await expect(pushProjectAnalyticsConfig("p1", "srv1")).resolves.toBeUndefined();
    expect(h.pushes).toHaveLength(0);
  });
});

/**
 * The reconcile is the answer to a verified failure:
 *
 *   `openresty -s reload`  → the shared dict SURVIVES (a routing change keeps the flag)
 *   full restart           → the dict is EMPTY, so absent-means-off silently stops
 *                            collection while the database still says it is on
 *
 * Confirmed against a real edge container. Without a periodic re-assert, the only thing
 * that corrected it was the project's next route apply — weeks away for a stable project,
 * during which the dashboard kept claiming "on".
 */
describe("reconcile after an edge restart", () => {
  const proj = (id: string, collectPaths: boolean) => ({
    id,
    collectPaths,
    cloudWorkspaceId: null,
    activeDeploymentId: "dep1",
  });

  it("groups every host by server and sends ONE call per server", async () => {
    h.allProjects = [proj("p1", true), proj("p2", false)];
    h.sourcesByProject = {
      p1: [
        { kind: "self-hosted", domain: "A.com", serverId: "srv1" },
        { kind: "self-hosted", domain: "b.com", serverId: "srv1" },
      ],
      p2: [{ kind: "self-hosted", domain: "c.com", serverId: "srv2" }],
    };

    const res = await reconcileAnalyticsConfig();

    expect(res).toEqual({ servers: 2, hosts: 3 });
    // One round trip per SERVER, not per host — through an SSH tunnel the round trip is
    // the cost, and a box can serve dozens of domains.
    expect(h.pushes).toHaveLength(2);
    const srv1 = h.pushes.find((p) => p.serverId === "srv1")!.body as { hosts: Entry[] };
    expect(srv1.hosts.map((e) => e.host).sort()).toEqual(["a.com", "b.com"]);
    expect(srv1.hosts.every((e) => e.paths === true)).toBe(true);
    const srv2 = h.pushes.find((p) => p.serverId === "srv2")!.body as { hosts: Entry[] };
    expect(srv2.hosts).toEqual([{ host: "c.com", paths: false }]);
  });

  it("routes a null serverId to the local edge", async () => {
    h.allProjects = [proj("p1", true)];
    h.sourcesByProject = { p1: [{ kind: "self-hosted", domain: "a.com", serverId: null }] };
    await reconcileAnalyticsConfig();
    expect(h.pushes).toHaveLength(1);
    expect(h.pushes[0]!.serverId).toBeNull();
  });

  it("skips cloud projects and cloud sources", async () => {
    h.allProjects = [
      { id: "p1", collectPaths: true, cloudWorkspaceId: "ws1", activeDeploymentId: "d" },
      proj("p2", true),
    ];
    h.sourcesByProject = { p2: [{ kind: "cloud", domain: "x.com" }] };
    const res = await reconcileAnalyticsConfig();
    // Oblien's edge is not OpenResty and has no dict to push into.
    expect(res).toEqual({ servers: 0, hosts: 0 });
    expect(h.pushes).toHaveLength(0);
  });

  it("skips an undeployed project — its first route apply will configure it", async () => {
    h.allProjects = [{ id: "p1", collectPaths: true, cloudWorkspaceId: null, activeDeploymentId: null }];
    h.sourcesByProject = { p1: [{ kind: "self-hosted", domain: "a.com", serverId: "srv1" }] };
    expect(await reconcileAnalyticsConfig()).toEqual({ servers: 0, hosts: 0 });
  });

  it("keeps going when one project cannot be resolved", async () => {
    h.allProjects = [proj("p1", true), proj("p2", true)];
    h.sourcesByProject = { p2: [{ kind: "self-hosted", domain: "b.com", serverId: "srv1" }] };
    const { resolveProjectTrafficSources } = await import("../../../src/lib/project-analytics");
    vi.mocked(resolveProjectTrafficSources).mockImplementationOnce(async () => {
      throw new Error("no deployment");
    });
    // One unresolvable project must not cost every other box its config for 30 minutes.
    const res = await reconcileAnalyticsConfig();
    expect(res.hosts).toBe(1);
  });
});
