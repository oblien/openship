import "../mail/_setup-env";
import { beforeEach, describe, expect, it, vi } from "vitest";

const deploymentRepo = vi.hoisted(() => ({ findById: vi.fn() }));
const serverRepo = vi.hoisted(() => ({ getInOrganization: vi.fn() }));

vi.mock("@repo/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@repo/db")>();
  return {
    ...actual,
    repos: {
      ...actual.repos,
      deployment: deploymentRepo,
      server: serverRepo,
    },
  };
});

import { enrichProject } from "../../../src/modules/projects/project-crud.service";

const baseProject = {
  id: "proj_1",
  organizationId: "org_1",
  groupId: null,
  slug: "app",
  name: "App",
  port: 3000,
  cloudWorkspaceId: null,
  resources: null,
  buildResources: null,
  sleepMode: "auto_sleep",
} as any;

// The durable project.serverId is the source of truth for the server binding;
// meta.serverId is a per-deploy snapshot a fresh/partial deploy can drop. These
// pin the coalesce: meta wins when present, the column fills in when it doesn't.
describe("enrichProject serverId coalesce", () => {
  beforeEach(() => {
    deploymentRepo.findById.mockReset();
    serverRepo.getInOrganization.mockReset();
    serverRepo.getInOrganization.mockResolvedValue(null);
  });

  it("uses the deploy meta serverId when present (column ignored)", async () => {
    deploymentRepo.findById.mockResolvedValue({
      id: "dep_1",
      meta: { deployTarget: "server", serverId: "srv_meta" },
      version: 2,
      status: "success",
    });
    serverRepo.getInOrganization.mockResolvedValue({ name: "Meta Box" });

    const enriched = await enrichProject({
      ...baseProject,
      activeDeploymentId: "dep_1",
      serverId: "srv_col",
    });

    expect(enriched.serverId).toBe("srv_meta");
    expect(enriched.serverName).toBe("Meta Box");
    expect(enriched.deployTarget).toBe("server");
    expect(serverRepo.getInOrganization).toHaveBeenCalledWith("srv_meta", "org_1");
  });

  it("coalesces to the durable column when meta dropped serverId", async () => {
    deploymentRepo.findById.mockResolvedValue({
      id: "dep_1",
      meta: { deployTarget: "server" },
      version: 3,
      status: "success",
    });
    serverRepo.getInOrganization.mockResolvedValue({ name: null, sshHost: "1.2.3.4" });

    const enriched = await enrichProject({
      ...baseProject,
      activeDeploymentId: "dep_1",
      serverId: "srv_col",
    });

    expect(enriched.serverId).toBe("srv_col");
    expect(enriched.serverName).toBe("1.2.3.4");
    expect(serverRepo.getInOrganization).toHaveBeenCalledWith("srv_col", "org_1");
  });

  // The lookup is ORG-SCOPED because the meta half of serverId is client-supplied:
  // a deploy body naming another org's server uuid must read as absent here, not as
  // that server's name/sshHost. See test/modules/deployments/server-name-org-scope.test.ts.
  it("leaves serverName null for a serverId outside the project's org", async () => {
    deploymentRepo.findById.mockResolvedValue({
      id: "dep_1",
      meta: { deployTarget: "server", serverId: "srv_other_org" },
      version: 2,
      status: "success",
    });
    // What getInOrganization returns for a row belonging to someone else.
    serverRepo.getInOrganization.mockResolvedValue(undefined);

    const enriched = await enrichProject({
      ...baseProject,
      activeDeploymentId: "dep_1",
      serverId: null,
    });

    expect(serverRepo.getInOrganization).toHaveBeenCalledWith("srv_other_org", "org_1");
    expect(enriched.serverId).toBe("srv_other_org");
    expect(enriched.serverName).toBeNull();
  });

  it("resolves the column server even with no active deployment", async () => {
    serverRepo.getInOrganization.mockResolvedValue({ name: "Col Box" });

    const enriched = await enrichProject({
      ...baseProject,
      activeDeploymentId: null,
      serverId: "srv_col",
    });

    expect(deploymentRepo.findById).not.toHaveBeenCalled();
    expect(enriched.serverId).toBe("srv_col");
    expect(enriched.serverName).toBe("Col Box");
    // "server", not null: the target is DERIVED from the binding, so a project bound to
    // a server reports it before its first deploy too. It read null while the target came
    // from `meta.deployTarget`, which no deployment yet supplied — an artifact of that
    // source, not a decision. Null is now reserved for a project bound to nothing that
    // has never deployed (below), which is the one case with genuinely no target, and the
    // deploy wizard hydrates this field: answering null for a bound project sent it back
    // out addressed to DEFAULT_CONFIG's "cloud".
    expect(enriched.deployTarget).toBe("server");
  });

  it("leaves serverId/serverName null when neither meta nor column has one", async () => {
    const enriched = await enrichProject({
      ...baseProject,
      activeDeploymentId: null,
      serverId: null,
    });

    expect(enriched.serverId).toBeNull();
    expect(enriched.serverName).toBeNull();
    expect(enriched.deployTarget).toBeNull();
    expect(serverRepo.getInOrganization).not.toHaveBeenCalled();
  });
});

/**
 * `deployTarget` is derived from the bindings, never read back from
 * `meta.deployTarget`. That snapshot is per-deploy state a fresh or partial redeploy can
 * drop, and every consumer of this field treats it as authoritative: `deployTarget ===
 * "cloud"` IS the dashboard's cloud test, it decides `isCloud` for the resource ceilings
 * rendered on the card, and the deploy wizard hydrates its destination from it.
 */
describe("enrichProject deployTarget derivation", () => {
  beforeEach(() => {
    deploymentRepo.findById.mockReset();
    serverRepo.getInOrganization.mockReset();
    serverRepo.getInOrganization.mockResolvedValue(null);
  });

  it("reports cloud from the workspace binding even when meta lost the target", async () => {
    // The silent failure this replaced: a cloud project whose redeploy wrote no
    // deployTarget read as null, so isCloud went false and the card swapped the metered
    // free-tier ceilings for "no limits", while every cloud-only gate switched off.
    deploymentRepo.findById.mockResolvedValue({ id: "dep_1", meta: {}, version: 4, status: "success" });

    const enriched = await enrichProject({
      ...baseProject,
      cloudWorkspaceId: "ws_1",
      activeDeploymentId: "dep_1",
      serverId: null,
    });

    expect(enriched.deployTarget).toBe("cloud");
  });

  it("ignores a meta target that contradicts the bindings", async () => {
    // A cloud-bound project cannot be reported as running on a server, whatever an older
    // deployment's snapshot says — the bindings are the durable record, meta is not.
    deploymentRepo.findById.mockResolvedValue({
      id: "dep_1",
      meta: { deployTarget: "server", serverId: null },
      version: 5,
      status: "success",
    });

    const enriched = await enrichProject({
      ...baseProject,
      cloudWorkspaceId: "ws_1",
      activeDeploymentId: "dep_1",
      serverId: null,
    });

    expect(enriched.deployTarget).toBe("cloud");
  });

  it("reports local for a deployed project bound to neither", async () => {
    deploymentRepo.findById.mockResolvedValue({ id: "dep_1", meta: {}, version: 2, status: "success" });

    const enriched = await enrichProject({
      ...baseProject,
      activeDeploymentId: "dep_1",
      serverId: null,
    });

    expect(enriched.deployTarget).toBe("local");
    expect(enriched.serverId).toBeNull();
  });

  it("never reports a server id without a server target", async () => {
    // The pair has to agree: a card showing "Local" next to a server name, or a wizard
    // hydrating one field from the target and the other from the id, is the same bug.
    for (const [cloudWorkspaceId, metaServerId, colServerId] of [
      ["ws_1", "srv_meta", null],
      ["ws_1", null, "srv_col"],
      [null, "srv_meta", null],
      [null, null, "srv_col"],
      [null, null, null],
    ] as const) {
      deploymentRepo.findById.mockResolvedValue({
        id: "dep_1",
        meta: metaServerId ? { serverId: metaServerId } : {},
        version: 1,
        status: "success",
      });

      const enriched = await enrichProject({
        ...baseProject,
        cloudWorkspaceId,
        activeDeploymentId: "dep_1",
        serverId: colServerId,
      });

      expect(Boolean(enriched.serverId), `target=${enriched.deployTarget}`).toBe(
        enriched.deployTarget === "server",
      );
    }
  });
});
