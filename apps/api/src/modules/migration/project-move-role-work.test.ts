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
  scanned: 0,
  services: [] as Record<string, unknown>[],
  placements: [] as Record<string, unknown>[],
  volumes: [] as Record<string, unknown>[],
  otherContainers: [] as Record<string, unknown>[],
}));

// Only these reads exist: a guard that read wider history would call an unmocked method.
vi.mock("@repo/db", () => ({
  repos: {
    project: { findByIdInOrganization: async () => h.project },
    deployment: {
      findById: async (id: string) => h.byId.get(id),
      listUnsettledByProject: async () => h.unsettled,
    },
    service: {
      listByProject: async () => h.services,
      listByDeployment: async () => h.placements,
    },
  },
}));

vi.mock("@repo/platform/engine/modules/migration/docker-inspect.service", () => ({
  discoverServerStack: async (
    _server: string,
    _org: string,
    _progress: unknown,
    options: { onlyContainerIds: string[] },
  ) => {
    h.scanned++;
    return {
      services: options.onlyContainerIds.map((containerId) => ({
        name: "old-compose-name",
        containerId,
        image: "test:live",
        imageId: "sha256:image",
        ports: [],
        volumes: h.volumes,
        env: {},
        running: true,
      })),
    };
  },
}));

vi.mock("@repo/platform/engine/modules/migration/migration-runtime", () => ({
  createMigrationDockerRuntime: async () => {
    h.hostContacted++;
    return {
      listProjectContainerIds: async () => [],
      dispose: async () => {},
      docker: { listContainers: async () => h.otherContainers },
    };
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

describe("in-place imports keep their exact active container identity", () => {
  const containerId = "a".repeat(64);
  const copy = () =>
    loadProjectMoveWorkload({
      organizationId: ORG,
      projectId: "p1",
      targetServerId: "srv_a",
      intent: "copy",
      serviceNames: ["frontend"],
    });
  beforeEach(() => {
    h.byId.set(
      "dep_active",
      dep("dep_active", "ready", { meta: { adopt: true, serverId: "srv_a" } }),
    );
    h.services = [{ id: "svc_web", name: "frontend" }];
    h.placements = [{ serviceId: "svc_web", containerId }];
  });
  it("finds an unlabeled imported container by its renamed service", async () => {
    expect((await copy()).chosen).toEqual([
      expect.objectContaining({ name: "frontend", containerId }),
    ]);
    expect(h.scanned).toBe(1);
  });
  it.each([
    { organizationId: "other-org" },
    { projectId: "other-project" },
    { meta: { adopt: true, serverId: "different-host" } },
  ])("does not trust an unrelated deployment or server: %j", async (patch) => {
    h.byId.set("dep_active", { ...h.byId.get("dep_active"), ...patch });
    await expect(copy()).rejects.toMatchObject({ code: "unknown_service" });
    expect(h.scanned).toBe(0);
  });
  it("ignores a placement whose service is no longer owned by this project", async () => {
    h.services = [];
    await expect(copy()).rejects.toMatchObject({ code: "unknown_service" });
    expect(h.scanned).toBe(0);
  });
  it("refuses an external storage writer, but permits a read-only consumer", async () => {
    h.volumes = [{ source: "shared-data", target: "/data", type: "volume", rw: true }];
    const mount = {
      Name: "shared-data",
      Source: "/var/lib/docker/volumes/shared-data/_data",
      RW: true,
    };
    h.otherContainers = [{ Id: "b".repeat(64), Mounts: [mount] }];
    await expect(copy()).rejects.toMatchObject({ code: "shared_data" });
    mount.RW = false;
    expect((await copy()).chosen).toHaveLength(1);
  });
});

beforeEach(() => {
  h.byId.clear();
  h.unsettled = [];
  h.hostContacted = 0;
  h.scanned = 0;
  h.services = [];
  h.placements = [];
  h.volumes = [];
  h.otherContainers = [];
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
