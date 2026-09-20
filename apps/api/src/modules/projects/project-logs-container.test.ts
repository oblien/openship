import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Which container "the project's logs" mean.
 *
 * `deployment.container_id` holds ONE service's container, written by the compose
 * deploy loop — and that loop walks services in dependency order, so for an app
 * that `dependsOn` postgres the column named POSTGRES. Project logs therefore
 * streamed the database while the app served traffic (#498), and no migration can
 * fix the rows already written that way.
 *
 * So the id is resolved LIVE from the host through the shared service matcher,
 * against the PRIMARY service — the one the access URL points at. Colocated in
 * `src/` deliberately: `apps/api/tsconfig.json` includes only `src/**`, so a test
 * under `test/**` is never typechecked and its fixtures can drift from the real
 * shapes.
 */

const h = vi.hoisted(() => ({
  containerId: "cid-db" as string | null,
  activeDeploymentId: "dep_1" as string,
  deploymentOwner: { projectId: "proj_1", organizationId: "org_1" },
  services: [] as Array<{ id: string; name: string; enabled: boolean; exposed: boolean }>,
  serviceRows: [] as Array<{ id: string; serviceId: string; containerId: string | null }>,
  live: [] as Array<{ id: string; names: string[]; state: string; labels: Record<string, string> }>,
  logTargets: [] as string[],
  healed: [] as Array<{ rowId: string; containerId: string }>,
  listByProjectCalls: 0,
  listByDeploymentCalls: 0,
  stream: vi.fn(), dispose: vi.fn(), stop: vi.fn(),
}));

vi.mock("@repo/db", async (original) => ({
  ...await original<Record<string, unknown>>(),
  repos: {
    project: {
      findById: async () => ({
        id: "proj_1",
        slug: "stack",
        organizationId: "org_1",
        activeDeploymentId: h.activeDeploymentId,
      }),
    },
    deployment: {
      findById: async () => ({
        id: "dep_1",
        ...h.deploymentOwner,
        containerId: h.containerId,
        status: "ready",
        meta: { deployTarget: "server", serverId: "srv_1" },
      }),
      findBuildSessionByDeploymentId: async () => null,
    },
    service: {
      listByProject: async () => {
        h.listByProjectCalls += 1;
        return h.services;
      },
      listByDeployment: async () => {
        h.listByDeploymentCalls += 1;
        return h.serviceRows;
      },
      updateServiceDeployment: async (rowId: string, patch: { containerId?: string }) => {
        if (patch.containerId) h.healed.push({ rowId, containerId: patch.containerId });
      },
    },
    domain: { listByProject: async () => [] },
  },
}));

// The seam: a runtime that can enumerate the host's containers. The real matcher
// (services/live-state) runs against it unmocked — the label tiers are the thing
// under test as much as the picker is.
vi.mock("@repo/platform/engine/lib/deployment-runtime", () => ({
  withDeploymentRuntime: async (_dep: unknown, fn: (runtime: unknown) => Promise<unknown>) =>
    fn({
      supports: (cap: string) => cap === "hostContainerQuery",
      listAllContainers: async () => h.live,
      getRuntimeLogs: async (id: string) => {
        h.logTargets.push(id);
        return [];
      },
    }),
  resolveDeploymentRuntimeForRead: async () => {
    return { serverId: "srv_1", runtime: {
      supports: (cap: string) => cap === "hostContainerQuery",
      listAllContainers: async () => h.live,
      streamRuntimeLogs: h.stream,
    } };
  },
  disposeRuntime: h.dispose,
  deploymentContainerIds: async () => [],
  withDeploymentPlatform: async () => {
    throw new Error("not used by getRuntimeLogs");
  },
}));

vi.mock("@repo/adapters", async (original) => ({
  ...await original<Record<string, unknown>>(),
  checkEdge: async () => ({ healthy: true, message: "" }),
  edgeProxy: async () => null,
  isRuntimeNotFoundError: () => false,
}));

const { getRuntimeLogs, streamRuntimeLogs } = await import("@repo/platform/engine/modules/projects/project-runtime.service");
const { getDeploymentLogs } = await import("@repo/platform/engine/modules/deployments/deployment.service");

/** `openship.service` carries the service NAME, not its id — see live-state's
 *  label tier. */
const container = (serviceName: string, id: string) => ({
  id,
  names: [`/openship-stack-${serviceName}`],
  state: "running",
  labels: { "openship.project": "proj_1", "openship.service": serviceName },
});

beforeEach(() => {
  h.containerId = "cid-db";
  h.activeDeploymentId = "dep_1";
  h.deploymentOwner = { projectId: "proj_1", organizationId: "org_1" };
  h.services = [];
  h.serviceRows = [];
  h.live = [];
  h.logTargets = [];
  h.healed = [];
  h.listByProjectCalls = 0;
  h.listByDeploymentCalls = 0;
  h.stream.mockReset().mockResolvedValue(h.stop);
  h.stop.mockReset();
  h.dispose.mockReset();
});

describe("project logs target the primary service, not the recorded database", () => {
  it.each([
    { projectId: "other-project", organizationId: "org_1" },
    { projectId: "proj_1", organizationId: "other-org" },
  ])("refuses a mismatched active deployment before reading logs: %j", async (owner) => {
    h.deploymentOwner = owner;
    h.live = [container("app", "cid-app")];
    await expect(getRuntimeLogs("proj_1", "org_1")).rejects.toThrow(/No running container/);
    await expect(streamRuntimeLogs("proj_1", "org_1", () => {})).rejects.toThrow(/No running container/);
    expect(h.logTargets).toEqual([]);
    expect(h.stream).not.toHaveBeenCalled();
    expect(h.listByDeploymentCalls).toBe(0);
  });

  it("disposes a runtime when establishing its log stream fails", async () => {
    h.stream.mockRejectedValueOnce(new Error("stream setup failed"));
    await expect(streamRuntimeLogs("proj_1", "org_1", () => {})).rejects.toThrow("stream setup failed");
    expect(h.dispose).toHaveBeenCalledOnce();
    expect(h.stop).not.toHaveBeenCalled();
  });
  it("keeps streaming resources alive until cleanup and disposes them once", async () => {
    const result = await streamRuntimeLogs("proj_1", "org_1", () => {}, { tail: 10 });
    expect(h.stream).toHaveBeenCalledWith("cid-db", expect.any(Function), { tail: 10 });
    expect(h.dispose).not.toHaveBeenCalled();
    result.cleanup();
    result.cleanup();
    expect(h.stop).toHaveBeenCalledOnce();
    expect(h.dispose).toHaveBeenCalledOnce();
  });
  it("streams the exposed app even though the deployment row records the db", async () => {
    h.services = [
      { id: "svc_db", name: "db", enabled: true, exposed: false },
      { id: "svc_app", name: "app", enabled: true, exposed: true },
    ];
    h.serviceRows = [
      { id: "row_db", serviceId: "svc_db", containerId: "cid-db" },
      { id: "row_app", serviceId: "svc_app", containerId: "cid-app" },
    ];
    h.live = [container("db", "cid-db"), container("app", "cid-app")];

    await getRuntimeLogs("proj_1", "org_1");

    expect(h.logTargets).toEqual(["cid-app"]);
  });

  it("heals a stale service row from the live host instead of handing docker a dead id", async () => {
    h.services = [{ id: "svc_app", name: "app", enabled: true, exposed: true }];
    h.serviceRows = [{ id: "row_app", serviceId: "svc_app", containerId: "cid-old" }];
    h.live = [container("app", "cid-new")];

    await getRuntimeLogs("proj_1", "org_1");

    expect(h.logTargets).toEqual(["cid-new"]);
    expect(h.healed).toEqual([{ rowId: "row_app", containerId: "cid-new" }]);
  });

  it("uses the recorded id for a single-app deployment and stops after one query", async () => {
    h.containerId = "cid-single";

    await getRuntimeLogs("proj_1", "org_1");

    expect(h.logTargets).toEqual(["cid-single"]);
    // The deployment's own rows answer "was this a service deploy", and there are
    // none — so nothing further is read. Opening logs must not fan out per call.
    expect(h.listByDeploymentCalls).toBe(1);
    expect(h.listByProjectCalls).toBe(0);
  });

  it("answers a HISTORICAL deployment from its own row and never rewrites it", async () => {
    // The live matcher keys on the project+service label, so it reports whatever
    // runs NOW. For an older release that is the wrong container, and healing from
    // it would rewrite history from a GET — these endpoints take any deployment id.
    h.activeDeploymentId = "dep_7";
    h.services = [{ id: "svc_app", name: "app", enabled: true, exposed: true }];
    h.serviceRows = [{ id: "row_app", serviceId: "svc_app", containerId: "cid-v3" }];
    h.live = [container("app", "cid-v7")];

    await getDeploymentLogs("dep_1", "org_1");

    expect(h.logTargets).toEqual(["cid-v3"]);
    expect(h.healed).toEqual([]);
  });

  it("refuses the compose sentinel rather than dialling a container named 'compose'", async () => {
    h.containerId = "compose";

    await expect(getRuntimeLogs("proj_1", "org_1")).rejects.toThrow(
      /No running container for project/,
    );
    expect(h.logTargets).toEqual([]);
  });
});
