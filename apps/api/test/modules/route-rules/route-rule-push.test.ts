import { describe, expect, it, vi, beforeEach } from "vitest";
import type { RouteRuleSpec } from "@repo/core";

/**
 * The DB is the source of truth for route rules; the edge only knows what was last
 * pushed into its `rules` shared dict. That makes the serializer + pusher the whole
 * correctness story, and both of its failure modes are silent:
 *
 *  - **Under-push**: a rule deleted or disabled in the UI keeps enforcing, because
 *    nothing told the edge to forget it. So every current host is pushed on every
 *    mutation — an empty ruleset IS the clear — plus `priorHostnames` for hosts whose
 *    domain row is gone.
 *  - **Mis-target**: a `domainId`-bound rule fanned out to every host of the project
 *    would rate-limit domains the operator never touched.
 *
 * Faked at `postEdgeMgmt`, the one seam that decides server-vs-local transport (it is
 * shared with the analytics collection-switch push, so both cannot disagree about where
 * "local" is). Its own two branches — mgmt over SSH for a server, loopback fetch for
 * local — are covered in lib/post-edge-mgmt.test.ts; here we assert the FAN-OUT: which
 * hosts get pushed, with what body, and to which target.
 */

const { listByProject, listDomains, findProject, findDeployment, postEdgeMgmt, resolveDeploymentRuntime } =
  vi.hoisted(() => ({
    listByProject: vi.fn(),
    listDomains: vi.fn(),
    findProject: vi.fn(),
    findDeployment: vi.fn(),
    postEdgeMgmt: vi.fn(),
    resolveDeploymentRuntime: vi.fn(),
  }));

vi.mock("@repo/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@repo/db")>()),
  repos: {
    routeRule: { listByProject },
    domain: { listByProject: listDomains },
    project: { findById: findProject },
    deployment: { findById: findDeployment },
  },
}));

vi.mock("../../../src/lib/project-analytics", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/lib/project-analytics")>()),
  postEdgeMgmt,
}));

vi.mock("../../../src/lib/deployment-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/lib/deployment-runtime")>()),
  resolveDeploymentRuntime,
}));

import {
  pushProjectRules,
  resolveProjectPushTarget,
  serializeProjectRules,
  type HostRuleEntry,
} from "../../../src/modules/route-rules/route-rule.service";

const RL: RouteRuleSpec = { rateLimit: { rps: 5, burst: 5, key: "ip" } };
const BAN: RouteRuleSpec = { ban: { countries: ["RU"] } };

const rule = (over: Record<string, unknown> = {}) => ({
  id: "r1",
  domainId: null,
  pathPrefix: null,
  spec: RL,
  enabled: true,
  ...over,
});

const domain = (id: string, hostname: string) => ({ id, hostname });

/** Push bodies as they reached the transport seam. `serverId: null` is the local target. */
function capturedPushes() {
  return postEdgeMgmt.mock.calls.map(([serverId, path, body]) => ({
    serverId,
    path,
    body: body as { host: string; rules: HostRuleEntry[] },
  }));
}

beforeEach(() => {
  vi.clearAllMocks();
  postEdgeMgmt.mockResolvedValue(undefined);
  // pushProjectRules now loads the project too, for the organizationId that resolves a
  // null serverId to the "This Server" row. The real repo always returns a promise; an
  // unset mock returns undefined and blows up on `.catch`.
  findProject.mockResolvedValue(null);
});

describe("serializeProjectRules", () => {
  it("binds a domain-scoped rule to that hostname only", async () => {
    listByProject.mockResolvedValue([rule({ domainId: "d1" })]);
    listDomains.mockResolvedValue([domain("d1", "a.com"), domain("d2", "b.com")]);

    const map = await serializeProjectRules("p1");
    expect([...map.keys()]).toEqual(["a.com"]);
    expect(map.get("a.com")).toEqual([{ pathPrefix: null, spec: RL }]);
  });

  it("fans a project-wide rule (domainId null) out to every hostname", async () => {
    listByProject.mockResolvedValue([rule()]);
    listDomains.mockResolvedValue([domain("d1", "a.com"), domain("d2", "b.com")]);

    const map = await serializeProjectRules("p1");
    expect([...map.keys()].sort()).toEqual(["a.com", "b.com"]);
  });

  it("lowercases hostnames, because the guard looks up by ngx.var.host", async () => {
    listByProject.mockResolvedValue([rule({ domainId: "d1" })]);
    listDomains.mockResolvedValue([domain("d1", "A.Example.COM")]);

    expect([...(await serializeProjectRules("p1")).keys()]).toEqual(["a.example.com"]);
  });

  it("skips disabled rules (the UI toggle has to mean something)", async () => {
    listByProject.mockResolvedValue([rule({ id: "r1", enabled: false })]);
    listDomains.mockResolvedValue([domain("d1", "a.com")]);

    expect((await serializeProjectRules("p1")).size).toBe(0);
  });

  it("drops a rule whose domain row is gone rather than fanning it out", async () => {
    // Deleting a domain must not promote its rule to the whole project.
    listByProject.mockResolvedValue([rule({ domainId: "deleted" })]);
    listDomains.mockResolvedValue([domain("d1", "a.com")]);

    expect((await serializeProjectRules("p1")).size).toBe(0);
  });

  it("orders entries longest-prefix-first, matching the guard's own choice", async () => {
    // The guard picks the longest match anyway; a deterministic order keeps the
    // pushed payload stable (and makes an eyeball diff of the dict readable).
    listByProject.mockResolvedValue([
      rule({ id: "root", pathPrefix: null }),
      rule({ id: "api", pathPrefix: "/api" }),
      rule({ id: "v3", pathPrefix: "/api/v3" }),
    ]);
    listDomains.mockResolvedValue([domain("d1", "a.com")]);

    expect((await serializeProjectRules("p1")).get("a.com")?.map((e) => e.pathPrefix)).toEqual([
      "/api/v3",
      "/api",
      null,
    ]);
  });

  it("keeps several rules for one host", async () => {
    listByProject.mockResolvedValue([
      rule({ id: "a", pathPrefix: "/api", spec: RL }),
      rule({ id: "b", pathPrefix: "/admin", spec: BAN }),
    ]);
    listDomains.mockResolvedValue([domain("d1", "a.com")]);

    expect((await serializeProjectRules("p1")).get("a.com")).toHaveLength(2);
  });

  it("returns an empty map for a project with no domains", async () => {
    listByProject.mockResolvedValue([rule()]);
    listDomains.mockResolvedValue([]);

    expect((await serializeProjectRules("p1")).size).toBe(0);
  });
});

describe("pushProjectRules", () => {
  it("pushes every current host, even the ones with no rules", async () => {
    // An empty ruleset is how a host is CLEARED. Pushing only hosts that still have
    // rules is exactly the bug where a deleted rule keeps enforcing.
    listByProject.mockResolvedValue([rule({ domainId: "d1" })]);
    listDomains.mockResolvedValue([domain("d1", "a.com"), domain("d2", "b.com")]);

    await pushProjectRules("p1", "srv1");

    const pushes = capturedPushes();
    expect(pushes.map((p) => p.body.host).sort()).toEqual(["a.com", "b.com"]);
    expect(pushes.find((p) => p.body.host === "b.com")?.body.rules).toEqual([]);
    expect(pushes.every((p) => p.path === "/rules")).toBe(true);
  });

  it("clears hosts whose domain row was removed (priorHostnames)", async () => {
    listByProject.mockResolvedValue([]);
    listDomains.mockResolvedValue([domain("d1", "a.com")]);

    await pushProjectRules("p1", "srv1", ["Old.com"]);

    const pushes = capturedPushes();
    expect(pushes.map((p) => p.body.host).sort()).toEqual(["a.com", "old.com"]);
    expect(pushes.every((p) => p.body.rules.length === 0)).toBe(true);
  });

  it("pushes each host exactly once when it appears in several sources", async () => {
    listByProject.mockResolvedValue([rule({ domainId: "d1" })]);
    listDomains.mockResolvedValue([domain("d1", "a.com")]);

    await pushProjectRules("p1", "srv1", ["a.com"]);

    expect(postEdgeMgmt).toHaveBeenCalledTimes(1);
  });

  it("keeps pushing the other hosts when one fails", async () => {
    // Best-effort per host: a single unreachable edge must not leave the rest stale.
    listByProject.mockResolvedValue([]);
    listDomains.mockResolvedValue([domain("d1", "a.com"), domain("d2", "b.com")]);
    postEdgeMgmt.mockRejectedValueOnce(new Error("tunnel closed")).mockResolvedValue({ ok: true });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(pushProjectRules("p1", "srv1")).resolves.toBeUndefined();
    expect(postEdgeMgmt).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("targets LOCAL when there is no server", async () => {
    listByProject.mockResolvedValue([rule({ domainId: "d1", spec: BAN })]);
    listDomains.mockResolvedValue([domain("d1", "a.com")]);

    await pushProjectRules("p1", null);

    // `serverId: null` IS the local target. That it then becomes a loopback fetch rather
    // than an SSH tunnel is postEdgeMgmt's job, asserted in lib/post-edge-mgmt.test.ts.
    const pushes = capturedPushes();
    expect(pushes).toHaveLength(1);
    expect(pushes[0]!.serverId).toBeNull();
    expect(pushes[0]!.path).toBe("/rules");
    expect(pushes[0]!.body).toEqual({ host: "a.com", rules: [{ pathPrefix: null, spec: BAN }] });
  });

  it("sends the spec through unchanged — the guard reads exactly what was stored", async () => {
    const spec: RouteRuleSpec = {
      rateLimit: { rps: 10, burst: 20, key: "ip", status: 429 },
      ban: { ips: ["1.2.3.4"], countries: ["RU"], userAgents: ["badbot"], emptyUserAgent: true },
      access: { allowCidrs: ["10.0.0.0/8"], methods: ["GET"] },
      hotlink: { allowReferers: ["a.com"], allowEmpty: false },
      block: { status: 451 },
    };
    listByProject.mockResolvedValue([rule({ domainId: "d1", pathPrefix: "/api", spec })]);
    listDomains.mockResolvedValue([domain("d1", "a.com")]);

    await pushProjectRules("p1", "srv1");

    expect(postEdgeMgmt.mock.calls[0]![2]).toEqual({
      host: "a.com",
      rules: [{ pathPrefix: "/api", spec }],
    });
  });

  it("does nothing at all for a project with no hosts to push", async () => {
    listByProject.mockResolvedValue([]);
    listDomains.mockResolvedValue([]);

    await pushProjectRules("p1", "srv1");
    expect(postEdgeMgmt).not.toHaveBeenCalled();
  });
});

describe("resolveProjectPushTarget", () => {
  it("returns nothing for a cloud project (its edge is not OpenResty)", async () => {
    findProject.mockResolvedValue({ id: "p1", cloudWorkspaceId: "ws1" });
    expect(await resolveProjectPushTarget("p1")).toBeNull();
  });

  it("returns nothing for a project deployed to cloud", async () => {
    findProject.mockResolvedValue({ id: "p1", activeDeploymentId: "dep1" });
    findDeployment.mockResolvedValue({ id: "dep1", meta: {}, organizationId: "org1" });
    resolveDeploymentRuntime.mockResolvedValue({ effectiveTarget: "cloud", serverId: null });

    expect(await resolveProjectPushTarget("p1")).toBeNull();
  });

  it("targets the server the deployment actually runs on", async () => {
    findProject.mockResolvedValue({ id: "p1", activeDeploymentId: "dep1" });
    findDeployment.mockResolvedValue({ id: "dep1", meta: {}, organizationId: "org1" });
    resolveDeploymentRuntime.mockResolvedValue({ effectiveTarget: "server", serverId: "srv9" });

    expect(await resolveProjectPushTarget("p1")).toEqual({ serverId: "srv9" });
  });

  it("falls back to the local edge for a project that has never deployed", async () => {
    // Rules can be authored before the first deploy; the local edge is the default.
    findProject.mockResolvedValue({ id: "p1", activeDeploymentId: null });
    expect(await resolveProjectPushTarget("p1")).toEqual({ serverId: null });
  });

  it("returns nothing for a project that doesn't exist", async () => {
    findProject.mockResolvedValue(null);
    expect(await resolveProjectPushTarget("p1")).toBeNull();
  });
});
