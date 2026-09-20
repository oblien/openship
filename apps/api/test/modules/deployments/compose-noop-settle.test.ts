import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The two halves of #498, driven through the REAL `executeComposePipeline` with a
 * canned `deployComposeServices` result:
 *
 *   (a) an all-carried result settles as a non-advancing `no_changes` row and
 *       destroys nothing — the containers listed under it are the live ones;
 *   (b) a result that actually deployed something advances the pointer AND records
 *       the primary service's container, never the topo-first dependency.
 *
 * Boundaries are faked the same way `deploy-outcome-vs-logs.test.ts` does it.
 * `deployComposeServices` is overridden while its pure siblings stay real
 * (importOriginal), so the pipeline's own no-op decision runs for real.
 */

const h = vi.hoisted(() => ({
  activePointer: [] as string[],
  statusWrites: [] as Array<{ id: string; status: string; extra?: Record<string, unknown> }>,
  sessionStatuses: [] as Array<{ id: string; status: string; detail?: Record<string, unknown> }>,
  containerIdWrites: [] as Array<string | undefined>,
  notifications: [] as string[],
  audits: [] as string[],
  destroyed: [] as string[],
  deployResult: null as unknown,
}));

vi.mock("@repo/db", () => ({
  repos: {
    deployment: {
      setContainerId: async (_id: string, containerId?: string) => {
        h.containerIdWrites.push(containerId);
      },
      updateStatus: async (id: string, status: string, extra?: Record<string, unknown>) => {
        h.statusWrites.push({ id, status, extra });
      },
      findReadyVersionByCommit: async () => 7,
      getNextReadyVersion: async () => 7,
      supersedePendingDecisions: async () => {},
      finishBuildSession: async () => {},
    },
    project: {
      setActiveDeployment: async (projectId: string, depId: string) => {
        h.activePointer.push(`${projectId}:${depId}`);
      },
      setCloudWorkspaceId: async () => {},
      update: async () => {},
    },
    service: { listByDeployment: async () => [] },
  },
}));

vi.mock("@repo/platform/engine/modules/deployments/session-manager", () => ({
  updateStatus: (id: string, status: string, detail?: Record<string, unknown>) => {
    h.sessionStatuses.push({ id, status, detail });
  },
  broadcastServiceStatus: () => {},
  broadcastInstallPhase: () => {},
  appendLog: () => {},
}));

vi.mock("@repo/platform/engine/lib/notification-dispatcher", () => ({
  notification: { emit: (e: { eventType: string }) => h.notifications.push(e.eventType) },
}));
vi.mock("../../../src/lib/audit", () => ({
  audit: { recordAsync: (_c: unknown, e: { eventType: string }) => h.audits.push(e.eventType) },
}));
vi.mock("@repo/platform/engine/lib/favicon-detector", () => ({ detectAndStoreFavicon: async () => {} }));
vi.mock("@repo/platform/engine/modules/mail/webmail/webmail-install.service", () => ({
  onWebmailDeployed: async () => {},
}));

// Not under test — a zero-image, zero-failure build.
vi.mock("@repo/platform/engine/modules/deployments/compose/build.service", () => ({
  buildComposeImages: async () => ({
    imageRefs: new Map<string, string>(),
    builtImageRefs: new Map<string, string>(),
    buildFailures: new Map<string, string>(),
    durationMs: 4200,
  }),
}));

vi.mock("@repo/platform/engine/modules/deployments/compose/deploy.service", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@repo/platform/engine/modules/deployments/compose/deploy.service")
  >()),
  deployComposeServices: async () => h.deployResult,
}));

const { executeComposePipeline } = await import("@repo/platform/engine/modules/deployments/compose/pipeline");
type PipelineOpts = Parameters<typeof executeComposePipeline>[0];

/** db first, app second — topoSort's dependency-first order, i.e. the order in
 *  which `services.find((s) => s.containerId)` answered "postgres". */
const services = [
  { serviceId: "db", serviceName: "db", containerId: "cid-db", status: "running", carried: true },
  { serviceId: "app", serviceName: "app", containerId: "cid-app", status: "running", carried: true },
];

function optsFor(): PipelineOpts {
  const dep = {
    id: "dep_1",
    projectId: "prj_1",
    organizationId: "org_1",
    branch: "main",
    commitSha: "abc123",
    status: "deploying",
    meta: null,
  };
  return {
    project: { id: "prj_1", name: "stack", slug: "stack", framework: "docker-compose" },
    dep,
    runtime: { name: "docker", destroy: async (id: string) => void h.destroyed.push(id) },
    routing: {},
    ssl: {},
    system: null,
    executor: null,
    usesManagedRouting: false,
    logger: { log: () => {} },
    ctx: {
      project: { id: "prj_1", name: "stack", slug: "stack", framework: "docker-compose" },
      dep,
      buildSessionId: "bld_1",
      persistLogs: () => [],
      provisioned: {},
    },
    snapshot: {},
    buildSessionId: "bld_1",
    buildEnvVars: {},
    buildResources: {},
    runtimeResources: {},
  } as never;
}

beforeEach(() => {
  h.activePointer = [];
  h.statusWrites = [];
  h.sessionStatuses = [];
  h.containerIdWrites = [];
  h.notifications = [];
  h.audits = [];
  h.destroyed = [];
  h.deployResult = null;
});

describe("executeComposePipeline — an all-carried redeploy must not take over", () => {
  it("settles no_changes without advancing the pointer, recording a container, or destroying anything", async () => {
    h.deployResult = {
      status: "ready",
      summary: {
        total: 2,
        successful: 2,
        deployed: 0,
        failed: 0,
        indeterminate: 0,
        mutated: false,
        failedServices: [],
      },
      services,
      primaryContainerId: undefined,
      portChecks: [],
    };

    await executeComposePipeline(optsFor());

    // THE bug: an empty release must not become the live pointer.
    expect(h.activePointer).toEqual([]);
    const settle = h.statusWrites.find((w) => w.status === "no_changes");
    expect(settle, "a no-op must record a no_changes row").toBeTruthy();
    expect(h.containerIdWrites).toEqual([]);
    expect(h.notifications).toEqual(["deployment.no_changes"]);
    expect(h.audits).toEqual(["deployment.no_changes"]);
    // The containers under this row are the LIVE ones. This is the guard against
    // a future reviewer folding onNoChanges into onFailure/onCancelled, both of
    // which destroy every service container the deployment lists.
    expect(h.destroyed).toEqual([]);
  });

  it("records the primary service's container, not the topo-first dependency", async () => {
    h.deployResult = {
      status: "ready",
      summary: {
        total: 2,
        successful: 2,
        deployed: 1,
        failed: 0,
        indeterminate: 0,
        mutated: false,
        failedServices: [],
      },
      services,
      primaryContainerId: "cid-app",
      portChecks: [{ serviceName: "app" }],
    };

    await executeComposePipeline(optsFor());

    expect(h.activePointer).toEqual(["prj_1:dep_1"]);
    expect(h.containerIdWrites).toEqual(["cid-app"]);
    expect(h.containerIdWrites).not.toContain("cid-db");
    expect(h.notifications).toContain("deployment.succeeded");
    expect(h.statusWrites.some((w) => w.status === "no_changes")).toBe(false);
  });

  it("a carried pass that reaped a container or persisted env is NOT a no-op", async () => {
    // `mutated` is the one term that can't be derived from the service results:
    // the de-listed-service reaper and the app-prepare env write both change real
    // state while every surviving service reads as carried.
    h.deployResult = {
      status: "ready",
      summary: {
        total: 2,
        successful: 2,
        deployed: 0,
        failed: 0,
        indeterminate: 0,
        mutated: true,
        failedServices: [],
      },
      services,
      primaryContainerId: "cid-app",
      portChecks: [],
    };

    await executeComposePipeline(optsFor());

    expect(h.statusWrites.some((w) => w.status === "no_changes")).toBe(false);
    expect(h.activePointer).toEqual(["prj_1:dep_1"]);
  });

  it("announces a partial-failure decision on the first terminal event", async () => {
    h.deployResult = {
      status: "ready",
      summary: {
        total: 2,
        successful: 1,
        deployed: 1,
        failed: 1,
        indeterminate: 0,
        mutated: true,
        failedServices: ["worker"],
      },
      services: [
        { serviceId: "app", serviceName: "app", containerId: "cid-app", status: "running" },
        { serviceId: "worker", serviceName: "worker", status: "failed", error: "exit 1" },
      ],
      primaryContainerId: "cid-app",
      warning: "Some services failed",
      portChecks: [],
    };

    await executeComposePipeline(optsFor());

    const terminal = h.sessionStatuses.find((entry) => entry.status === "ready");
    expect(terminal?.detail).toMatchObject({ decisionPending: true });
    expect(h.statusWrites.at(-1)?.extra).toMatchObject({
      meta: { composeDeployment: { decision: "pending" } },
    });
  });
});

// The application seams moved with the shared engine.
vi.mock("@repo/platform/engine/lib/audit-emitter", () => ({
  audit: { recordAsync: (_c: unknown, e: { eventType: string }) => h.audits.push(e.eventType) },
}));
