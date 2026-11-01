import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The move guard reads role work the saved project row no longer shows: a project can save
 * `roles: []` before a redeploy retires its role containers, and a cancelled deployment can
 * keep its role containers after its execution finished. These pin what is fetched for the
 * guard and that the workload loader refuses before it contacts the source host. Which rows
 * count as unsettled is pinned against Postgres in deployment-unsettled.repo.test.ts.
 */

const h = vi.hoisted(() => ({
  project: null as Record<string, unknown> | null,
  byId: new Map<string, Record<string, unknown>>(),
  unsettled: [] as Record<string, unknown>[],
  hostContacted: 0,
}));

// Only these reads exist: a guard that read wider history would call an unmocked method.
vi.mock("@repo/db", () => ({
  repos: {
    project: { findByIdInOrganization: async () => h.project },
    deployment: {
      findById: async (id: string) => h.byId.get(id),
      listUnsettledByProject: async () => h.unsettled,
    },
  },
}));

vi.mock("@repo/platform/engine/modules/migration/migration-runtime", () => ({
  createMigrationDockerRuntime: async () => {
    h.hostContacted++;
    return { listProjectContainerIds: async () => [], dispose: async () => {} };
  },
}));

const { loadProjectRoleWork, loadProjectMoveWorkload, ProjectMoveRefused } =
  await import("@repo/platform/engine/modules/migration/project-move");

const ORG = "org_1";
const dep = (id: string, status: string, over: Record<string, unknown> = {}) => ({
  id,
  projectId: "p1",
  organizationId: ORG,
  status,
  meta: null,
  roleContainers: null,
  ...over,
});
const roleRefs = [{ role: "queue", replica: 1, containerId: "c_queue" }];
const queue = { name: "queue", kind: "worker", command: "php artisan queue:work" };

beforeEach(() => {
  h.byId.clear();
  h.unsettled = [];
  h.hostContacted = 0;
  h.project = {
    id: "p1",
    organizationId: ORG,
    name: "example-app",
    slug: "example-app",
    serverId: "srv_a",
    runtimeMode: "docker",
    roles: [],
    activeDeploymentId: "dep_active",
  };
});

function active(over: Record<string, unknown> = {}) {
  const row = dep("dep_active", "ready", over);
  h.byId.set(row.id, row);
}

const load = () =>
  loadProjectMoveWorkload({ organizationId: ORG, projectId: "p1", targetServerId: "srv_b" });
const codeOf = (err: unknown) => (err as InstanceType<typeof ProjectMoveRefused>).code;

describe("loadProjectRoleWork", () => {
  it("returns the active deployment and the unsettled deployments", async () => {
    active();
    h.unsettled = [dep("dep_reconciling", "reconciling", { roleContainers: roleRefs })];

    const work = await loadProjectRoleWork({
      id: "p1",
      organizationId: ORG,
      activeDeploymentId: "dep_active",
    });

    expect(work.active?.id).toBe("dep_active");
    expect(work.unsettled.map((d) => d.id)).toEqual(["dep_reconciling"]);
  });
});

describe("loadProjectMoveWorkload", () => {
  it("refuses saved `roles: []` while the active deployment still runs roles, before contacting the host", async () => {
    active({ meta: { roles: [queue] }, roleContainers: roleRefs });

    const err = await load().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProjectMoveRefused);
    expect(codeOf(err)).toBe("has_roles");
    expect(h.hostContacted).toBe(0);
  });

  it("refuses a finished cancellation that kept its role containers, before contacting the host", async () => {
    active({ meta: { roles: [] } });
    h.unsettled = [
      dep("dep_kept", "cancelled", {
        meta: { roles: [queue], cancellation: { keepProvisioned: true } },
        roleContainers: roleRefs,
      }),
    ];

    const err = await load().catch((e: unknown) => e);
    expect(codeOf(err)).toBe("has_roles");
    expect((err as Error).message).toContain("cancelled deployment (dep_kept)");
    expect(h.hostContacted).toBe(0);
  });

  it("lets a clean role-free project through to the host", async () => {
    active({ meta: { roles: [] } });

    // The role guard passes, so the loader asks the host, which reports nothing running.
    const err = await load().catch((e: unknown) => e);
    expect(codeOf(err)).toBe("nothing_running");
    expect(h.hostContacted).toBe(1);
  });
});
