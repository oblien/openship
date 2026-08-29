import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Pausing / resuming a project, when the host is the part that fails.
 *
 * The properties here were broken by the same shape of bug — the action wrote its
 * intent to the DB, then asked a host that said no, and nobody reconciled the two:
 *
 *   1. a failed stop must NOT leave the project marked disabled. It used to: the
 *      row said paused, every container kept serving, the health watch went quiet
 *      on it (it gates on `disabled_at`), and `enableProject` refuses to clear the
 *      flag until a start SUCCEEDS — so an unreachable box made it permanent.
 *   2. EVERY container stops, not just `deployment.containerId` — that column
 *      names one service on a compose project, so the rest stayed up.
 *   3. a container that is ALREADY stopped is success, not failure — but only that
 *      case, which is what separates this from the blanket try/catch that hid
 *      cause 1.
 *   4. a STATIC project has no container to ask: its `containerId` is a release
 *      directory, so both actions were sending a filesystem path to the container
 *      runtime and failing on the daemon's reply to it (see `dockerPathIdError`).
 *      The workload is the edge, so pause/resume are route removal and re-apply.
 *
 * The 503 mapping and the always-dispose guarantee belong to the shared helper and
 * are pinned in lib/with-deployment-runtime.test.ts.
 */

const h = vi.hoisted(() => ({
  project: {
    id: "proj_1",
    organizationId: "org_1",
    activeDeploymentId: "dep_1",
    disabledAt: null as Date | null,
    appTemplateId: null as string | null,
    // A server project by default; the static cases flip `hasServer` off, which is
    // the same signal resolveDeployRouting reads to pick "static-file-serve".
    hasServer: true,
    cloudWorkspaceId: null as string | null,
    outputDirectory: "dist",
  },
  containerId: "app-container" as string | null,
  serviceRows: [] as Array<{ containerId: string | null }>,
  domainRows: [] as Array<{
    id: string;
    hostname: string;
    serviceId: string | null;
    domainType: string;
    verified: boolean;
    targetPort: number | null;
    targetPath: string | null;
  }>,
  updates: [] as Array<Record<string, unknown>>,
  stopped: [] as string[],
  started: [] as string[],
  removedRoutes: [] as string[],
  stop: vi.fn(async (_id: string) => {}),
  start: vi.fn(async (_id: string) => {}),
  removeRoute: vi.fn(async (_hostname: string) => {}),
  reapplyLiveRoutes: vi.fn(async () => {}),
  disposed: 0,
}));

vi.mock("@repo/db", () => ({
  withAdvisoryLock: async (_key: string, fn: () => Promise<unknown>) => fn(),
  repos: {
    project: {
      findById: async () => ({ ...h.project }),
      update: async (_id: string, patch: Record<string, unknown>) => {
        h.updates.push(patch);
        if ("disabledAt" in patch) h.project.disabledAt = patch.disabledAt as Date | null;
      },
    },
    deployment: {
      findById: async () => ({
        id: "dep_1",
        organizationId: "org_1",
        containerId: h.containerId,
        status: "ready",
        meta: { deployTarget: "server", serverId: "srv_1" },
      }),
      updateStatus: async () => {},
    },
    service: { listByDeployment: async () => h.serviceRows },
    domain: { listByProject: async () => h.domainRows, update: async () => {} },
  },
}));

/**
 * What the Docker daemon ACTUALLY answers when a release directory is handed to a
 * container action — measured against dockerode 4.0.9 + Docker 29.2.1:
 *
 *   getContainer("/opt/openship/static/releases/dep_1").stop()
 *     → statusCode 301, "(HTTP code 301) unexpected -  "
 *
 * The leading slash doubles in `/containers/<id>/stop`, and the daemon's router
 * 301s the doubled path instead of routing it. That is neither `isAbsent` (404)
 * nor `isAlreadyInState` (304), so it propagates — which is why pausing a static
 * project failed with an opaque 301 and resuming it failed the same way. The fake
 * runtime reproduces it so the static cases below fail for the real reason.
 */
const dockerPathIdError = () =>
  Object.assign(new Error("(HTTP code 301) unexpected -  "), { statusCode: 301 });

/**
 * The shared runtime/platform helpers are the seam, stubbed to a fake transport.
 * Their OWN contract — always dispose, map an unreachable host to 503 — is pinned
 * in lib/with-deployment-runtime.test.ts against the real implementation; this
 * file is about what pause/resume ORCHESTRATE: what gets stopped, in what order
 * relative to the `disabled_at` write, and what happens when the host says no.
 */
vi.mock("../../lib/deployment-runtime", () => ({
  deploymentContainerIds: async (dep: { containerId: string | null }) => {
    const fromServices = h.serviceRows.map((r) => r.containerId).filter((id): id is string => !!id);
    if (fromServices.length > 0) return fromServices;
    return dep.containerId ? [dep.containerId] : [];
  },
  withDeploymentRuntime: async (
    _dep: unknown,
    fn: (runtime: unknown, serverId: string | null) => Promise<unknown>,
  ) => {
    try {
      return await fn(
        {
          stop: async (id: string) => {
            h.stopped.push(id);
            if (id.includes("/")) throw dockerPathIdError();
            await h.stop(id);
          },
          start: async (id: string) => {
            h.started.push(id);
            if (id.includes("/")) throw dockerPathIdError();
            await h.start(id);
          },
        },
        "srv_1",
      );
    } finally {
      h.disposed += 1;
    }
  },
  withDeploymentPlatform: async (
    _dep: unknown,
    fn: (resolved: {
      routing: unknown;
      executor: {
        exec: (command: string) => Promise<{ stdout: string; stderr: string; code: number }>;
      };
      effectiveTarget: "server";
      serverId: string | null;
    }) => Promise<unknown>,
  ) => {
    try {
      return await fn({
        routing: {
          removeRoute: async (hostname: string) => {
            h.removedRoutes.push(hostname);
            await h.removeRoute(hostname);
          },
        },
        executor: { exec: async () => ({ stdout: "", stderr: "", code: 0 }) },
        effectiveTarget: "server",
        serverId: "srv_1",
      });
    } finally {
      h.disposed += 1;
    }
  },
  resolveDeploymentRuntimeForRead: async () => {
    throw new Error("not used by pause/resume");
  },
}));

vi.mock("@repo/adapters", () => ({
  checkEdge: async () => ({ healthy: true, message: "" }),
  edgeProxy: async () => null,
  // Reached via lib/remote-state's `isAbsent`. Faithful to the real predicate's
  // 404 rule, which is the part that matters: an ABSENT container is a stop that
  // has nothing left to do, while an auth failure is not.
  isRuntimeNotFoundError: (err: unknown) =>
    (err as { statusCode?: number } | null)?.statusCode === 404,
  isRemoteConnectionError: () => false,
}));

vi.mock("../../lib/managed-edge-proxy", () => ({
  syncManagedEdgeRoutes: async () => ({ failures: [] }),
  edgeUnsyncedWarning: () => "",
}));
vi.mock("../../lib/edge-reconcile", () => ({
  reconcileServerEdge: async () => ({
    converted: false,
    updated: false,
    edgeDown: false,
  }),
}));
vi.mock("../../lib/routing-domains", () => ({
  resolveManagedHostname: () => ({ isManaged: false }),
}));
vi.mock("../../lib/ssh-manager", () => ({
  sshManager: {
    withExecutor: async (_serverId: string, fn: (executor: unknown) => Promise<unknown>) =>
      fn({ exec: async () => ({ stdout: "", stderr: "", code: 0 }) }),
  },
}));
vi.mock("../domains/routing-apply.service", () => ({ applyProjectRouting: async () => {} }));
vi.mock("../domains/project-route.service", () => ({
  reapplyProjectLiveRoutes: async (...args: unknown[]) => h.reapplyLiveRoutes(...(args as [])),
}));

const load = () => import("./project-runtime.service");

/** dockerode's shape for "you asked me to stop a stopped container". */
const notModified = () =>
  Object.assign(new Error("container already stopped"), { statusCode: 304 });

describe("project pause / resume", () => {
  beforeEach(() => {
    h.project.disabledAt = null;
    h.project.appTemplateId = null;
    h.project.hasServer = true;
    h.project.cloudWorkspaceId = null;
    h.containerId = "app-container";
    h.serviceRows = [];
    h.domainRows = [];
    h.updates = [];
    h.stopped = [];
    h.started = [];
    h.removedRoutes = [];
    h.stop.mockReset().mockResolvedValue(undefined);
    h.start.mockReset().mockResolvedValue(undefined);
    h.removeRoute.mockReset().mockResolvedValue(undefined);
    h.reapplyLiveRoutes.mockReset().mockResolvedValue(undefined);
    h.disposed = 0;
  });

  /**
   * A self-hosted static deploy as the pipeline leaves it: no server container, and
   * `containerId` pointing at the release directory the edge serves from.
   */
  const asStaticProject = () => {
    h.project.hasServer = false;
    h.containerId = "/opt/openship/static/releases/dep_1";
    h.domainRows = [
      {
        id: "dom_1",
        hostname: "site.example.com",
        serviceId: null,
        domainType: "custom",
        verified: true,
        targetPort: null,
        targetPath: "/opt/openship/static/releases/dep_1",
      },
      {
        id: "dom_2",
        hostname: "site.opsh.io",
        serviceId: null,
        domainType: "managed",
        verified: true,
        targetPort: null,
        targetPath: "/opt/openship/static/releases/dep_1",
      },
      // Belongs to a service, not the project — pausing the project must not
      // deregister it.
      {
        id: "dom_3",
        hostname: "svc.example.com",
        serviceId: "svc_1",
        domainType: "custom",
        verified: true,
        targetPort: 3000,
        targetPath: null,
      },
    ];
  };

  it("stops every container of a compose project, not just the deployment's own", async () => {
    h.serviceRows = [{ containerId: "svc-web" }, { containerId: "svc-db" }, { containerId: null }];
    const { disableProject } = await load();

    await disableProject("proj_1", "org_1");

    expect(h.stopped).toEqual(["svc-web", "svc-db"]);
    expect(h.project.disabledAt).toBeInstanceOf(Date);
  });

  it("rolls the disabled mark back when the host refuses the stop", async () => {
    h.stop.mockRejectedValue(
      new Error(
        "SSH key authentication failed for root@65.109.55.23. (All configured authentication methods failed)",
      ),
    );
    const { disableProject } = await load();

    await expect(disableProject("proj_1", "org_1")).rejects.toThrow(/authentication failed/);

    // Set, then unset — the intent must not outlive a stop that didn't happen.
    expect(h.updates.map((u) => u.disabledAt instanceof Date)).toEqual([true, false]);
    expect(h.project.disabledAt).toBeNull();
  });

  it("treats an already-stopped container as done", async () => {
    h.stop.mockRejectedValue(notModified());
    const { disableProject } = await load();

    await expect(disableProject("proj_1", "org_1")).resolves.toMatchObject({ success: true });
    expect(h.project.disabledAt).toBeInstanceOf(Date);
  });

  it("clears the mark only after the start succeeds, and starts every container", async () => {
    h.project.disabledAt = new Date();
    h.serviceRows = [{ containerId: "svc-web" }, { containerId: "svc-db" }];
    const { enableProject } = await load();

    await enableProject("proj_1", "org_1");

    expect(h.started).toEqual(["svc-web", "svc-db"]);
    expect(h.project.disabledAt).toBeNull();
  });

  it("leaves the project disabled when the resume fails", async () => {
    h.project.disabledAt = new Date();
    h.start.mockRejectedValue(new Error("EHOSTUNREACH"));
    const { enableProject } = await load();

    await expect(enableProject("proj_1", "org_1")).rejects.toThrow();
    expect(h.project.disabledAt).toBeInstanceOf(Date);
  });

  it("pauses a static project by removing its edge routes, asking no container", async () => {
    asStaticProject();
    const { disableProject } = await load();

    await expect(disableProject("proj_1", "org_1")).resolves.toMatchObject({ success: true });

    expect(h.removedRoutes).toEqual(["site.example.com", "site.opsh.io"]);
    expect(h.stopped).toEqual([]);
    expect(h.project.disabledAt).toBeInstanceOf(Date);
  });

  it("rolls the disabled mark back when a static project's route removal fails", async () => {
    asStaticProject();
    h.removeRoute.mockRejectedValue(new Error("nginx -t failed: reload aborted"));
    const { disableProject } = await load();

    await expect(disableProject("proj_1", "org_1")).rejects.toThrow(/reload aborted/);

    expect(h.updates.map((u) => u.disabledAt instanceof Date)).toEqual([true, false]);
    expect(h.project.disabledAt).toBeNull();
  });

  it("resumes a static project by re-applying its routes, asking no container", async () => {
    asStaticProject();
    h.project.disabledAt = new Date();
    const { enableProject } = await load();

    await expect(enableProject("proj_1", "org_1")).resolves.toMatchObject({ success: true });

    expect(h.reapplyLiveRoutes).toHaveBeenCalledTimes(1);
    expect(h.started).toEqual([]);
    expect(h.project.disabledAt).toBeNull();
  });

  it("leaves a static project paused when the routes can't be re-applied", async () => {
    asStaticProject();
    h.project.disabledAt = new Date();
    h.reapplyLiveRoutes.mockRejectedValue(new Error("EHOSTUNREACH"));
    const { enableProject } = await load();

    await expect(enableProject("proj_1", "org_1")).rejects.toThrow(/re-apply/i);
    expect(h.project.disabledAt).toBeInstanceOf(Date);
  });

  it("refuses to pause the Openship control plane", async () => {
    h.project.appTemplateId = "openship";
    const { disableProject } = await load();

    await expect(disableProject("proj_1", "org_1")).rejects.toThrow(/control plane/i);
    expect(h.stopped).toEqual([]);
  });
});
