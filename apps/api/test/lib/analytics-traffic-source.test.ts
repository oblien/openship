import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * Where a project's request traffic is READ FROM — and, on the reconcile path, written to.
 *
 * The resolver used to end in `repos.server.list()[0]`, a query with no organization
 * filter and no `isLocal` filter, so it answered with the oldest server row in the whole
 * instance. Every derived-local project hits that branch: `deployment-runtime` records
 * `meta.serverId` only for the "server" target, so a project deployed to this box carries
 * no id at all. On an instance whose oldest row is a remote — or another org's — server,
 * this project's traffic was read from that machine and its tracked hostnames pushed into
 * it, over an executor `sshManager.acquire` resolves with no organizationId, for a caller
 * holding only `{project, read}`.
 *
 * The rule is now the one `postEdgeMgmt` in the same module already used: the deployment's
 * own meta, else THIS box's canonical row scoped to the project's org, else nothing.
 * `list()` must stay unreachable from here — that is the assertion that matters, because
 * the failure it guards is silent (an operator sees empty logs, never "wrong machine").
 */

const h = vi.hoisted(() => ({
  project: null as Record<string, unknown> | null,
  deploymentMeta: null as Record<string, unknown> | null,
  localRow: null as { id: string } | null,
  findLocalArgs: [] as string[],
  /** The unscoped query. Nothing in this module may reach it. */
  list: vi.fn(async () => [{ id: "srv-oldest-in-instance" }]),
  isCloud: false,
}));

vi.mock("@repo/db", () => ({
  repos: {
    project: { findById: async () => h.project },
    deployment: { findById: async () => (h.deploymentMeta ? { meta: h.deploymentMeta } : null) },
    domain: {
      getPrimaryByProject: async () => ({ hostname: "app.example.com", isPrimary: true }),
      listByProject: async () => [{ hostname: "app.example.com", isPrimary: true }],
    },
    server: {
      list: h.list,
      findLocal: async (organizationId: string) => {
        h.findLocalArgs.push(organizationId);
        return h.localRow ?? undefined;
      },
    },
  },
}));

vi.mock("@repo/adapters", () => ({
  OPENRESTY_MGMT_PORT: 9145,
  containerCommand: () => "",
  resolveOurEdgeContainer: async () => null,
  sq: (s: string) => s,
}));
vi.mock("../../src/lib/ssh-tunnel", () => ({ tunnelRequest: async () => ({}), tunnelStream: async () => ({}) }));
vi.mock("../../src/lib/ssh-manager", () => ({ sshManager: { retain: () => {}, release: () => {} } }));
vi.mock("../../src/lib/platform-mode", () => ({ isOblienBackedDeployment: () => h.isCloud }));
vi.mock("../../src/lib/system-debug", () => ({ systemDebug: () => {} }));

const { resolveProjectTrafficSource } = await import("../../src/lib/project-analytics");

beforeEach(() => {
  h.project = { id: "p1", organizationId: "org-owning-this-project", activeDeploymentId: "d1" };
  h.deploymentMeta = null;
  h.localRow = null;
  h.findLocalArgs = [];
  h.list.mockClear();
  h.isCloud = false;
});

describe("analytics traffic source", () => {
  it("uses the deployment's own serverId when it has one", async () => {
    h.deploymentMeta = { deployTarget: "server", serverId: "srv-pinned" };
    const source = await resolveProjectTrafficSource("p1");
    expect(source).toMatchObject({ kind: "self-hosted", serverId: "srv-pinned" });
    expect(h.findLocalArgs).toEqual([]);
  });

  it("falls back to THIS box's row, scoped to the project's organization", async () => {
    h.deploymentMeta = { deployTarget: "local" };
    h.localRow = { id: "srv-this-box" };
    const source = await resolveProjectTrafficSource("p1");
    expect(source).toMatchObject({ kind: "self-hosted", serverId: "srv-this-box" });
    expect(h.findLocalArgs).toEqual(["org-owning-this-project"]);
  });

  it("resolves NOTHING rather than another machine when this box has no row", async () => {
    h.deploymentMeta = { deployTarget: "local" };
    h.localRow = null;
    expect(await resolveProjectTrafficSource("p1")).toBeNull();
  });

  it("never reaches the instance-wide server list", async () => {
    for (const meta of [null, { deployTarget: "local" }, { deployTarget: "server" }]) {
      h.deploymentMeta = meta;
      h.localRow = null;
      await resolveProjectTrafficSource("p1");
      h.localRow = { id: "srv-this-box" };
      await resolveProjectTrafficSource("p1");
    }
    expect(h.list, "server.list() is unscoped by org AND isLocal — it must be unreachable here")
      .not.toHaveBeenCalled();
  });

  it("reads a cloud project at the cloud edge, looking up no server at all", async () => {
    h.isCloud = true;
    h.deploymentMeta = { deployTarget: "cloud" };
    expect(await resolveProjectTrafficSource("p1")).toMatchObject({ kind: "cloud" });
    expect(h.findLocalArgs).toEqual([]);
    expect(h.list).not.toHaveBeenCalled();
  });
});
