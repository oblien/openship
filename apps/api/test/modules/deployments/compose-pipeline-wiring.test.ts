import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * WIRING test for the compose carry-forward state-desync fix — the pure-helper
 * suite (compose-carryforward-state-desync.test.ts) covers the decision
 * functions; this drives the REAL `executeComposePipeline` with a canned
 * `deployComposeServices` result and asserts the two things the bug was about:
 *
 *   (a) an all-carried result settles via onNoChanges and NEVER advances the
 *       project's active pointer (setActiveDeployment);
 *   (b) a one-deployed result advances AND records the exposed APP container,
 *       not the topo-first db.
 *
 * Boundaries are faked exactly like deploy-outcome-vs-logs.test.ts (that suite's
 * template): `@repo/db` captures the active-pointer + container-id writes, the
 * build step is a stub, and `deployComposeServices` is overridden while its pure
 * sibling helpers stay real (importOriginal).
 */

const h = vi.hoisted(() => ({
  activePointer: [] as string[],
  statusWrites: [] as Array<{ id: string; status: string; extra?: Record<string, unknown> }>,
  containerIdWrites: [] as Array<string | undefined>,
  notifications: [] as string[],
  audits: [] as string[],
  installPhases: [] as Array<{ id: string; status: string }>,
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

vi.mock("../../../src/modules/deployments/session-manager", () => ({
  updateStatus: () => {},
  broadcastServiceStatus: () => {},
  broadcastInstallPhase: (_id: string, phase: { id: string; status: string }) => {
    h.installPhases.push(phase);
  },
  appendLog: () => {},
}));

vi.mock("../../../src/lib/notification-dispatcher", () => ({
  notification: { emit: (e: { eventType: string }) => h.notifications.push(e.eventType) },
}));
vi.mock("../../../src/lib/audit", () => ({
  audit: { recordAsync: (_c: unknown, e: { eventType: string }) => h.audits.push(e.eventType) },
}));
vi.mock("../../../src/lib/favicon-detector", () => ({ detectAndStoreFavicon: async () => {} }));
vi.mock("../../../src/modules/mail/webmail/webmail-project.service", () => ({
  markWebmailInstalled: async () => {},
  mailServerIdFromWebmailSlug: () => null,
}));

// The build step is not under test — stub it to a zero-image, zero-failure build.
vi.mock("../../../src/modules/deployments/compose/build.service", () => ({
  buildComposeImages: async () => ({
    imageRefs: new Map<string, string>(),
    builtImageRefs: new Map<string, string>(),
    buildFailures: new Map<string, string>(),
    durationMs: 4200,
  }),
}));

// Override deployComposeServices, keep the pure sibling helpers real so the
// pipeline's no-op detection + parent-container resolution run for real.
vi.mock("../../../src/modules/deployments/compose/deploy.service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/modules/deployments/compose/deploy.service")>()),
  deployComposeServices: async () => h.deployResult,
}));

const { executeComposePipeline } = await import(
  "../../../src/modules/deployments/compose/pipeline"
);
type PipelineOpts = Parameters<typeof executeComposePipeline>[0];

// db first, then app: reproduces topoSort's dependency-first order, so
// `services.find(s => s.containerId)` alone would return the DATABASE.
const services = [
  { serviceId: "db", serviceName: "db", containerId: "cid-db", status: "running" },
  { serviceId: "app", serviceName: "app", containerId: "cid-app", status: "running" },
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
    runtime: { name: "docker" },
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
  h.containerIdWrites = [];
  h.notifications = [];
  h.audits = [];
  h.installPhases = [];
  h.deployResult = null;
});

describe("executeComposePipeline — the carry-forward state-desync wiring", () => {
  it("an all-carried result settles no-op and does NOT advance the active pointer", async () => {
    h.deployResult = {
      status: "ready",
      summary: { total: 2, successful: 2, deployed: 0, failed: 0, indeterminate: 0, failedServices: [] },
      services, // carried containers present, but nothing was (re)deployed
      primaryContainerId: undefined,
      portChecks: [],
    };

    await executeComposePipeline(optsFor());

    // THE bug: the empty release must not become the live pointer.
    expect(h.activePointer).toEqual([]);
    // Settled as a non-advancing terminal row, and the reason persisted.
    const settle = h.statusWrites.find((w) => w.status === "cancelled");
    expect(settle, "no-op must record a cancelled row").toBeTruthy();
    expect((settle!.extra?.meta as { noChanges?: boolean } | undefined)?.noChanges).toBe(true);
    // No parent container recorded, and consumers see the settle event.
    expect(h.containerIdWrites).toEqual([]);
    expect(h.notifications).toContain("deployment.cancelled");
    expect(h.audits).toContain("deployment.cancelled");
  });

  it("a one-deployed result advances AND records the exposed app container (not the db)", async () => {
    h.deployResult = {
      status: "ready",
      summary: { total: 2, successful: 2, deployed: 1, failed: 0, indeterminate: 0, failedServices: [] },
      services,
      primaryContainerId: "cid-app",
      portChecks: [{ serviceName: "app" }],
    };

    await executeComposePipeline(optsFor());

    // A real deploy advances the pointer…
    expect(h.activePointer).toEqual(["prj_1:dep_1"]);
    // …and records the APP container the public route points at, never the db.
    expect(h.containerIdWrites).toEqual(["cid-app"]);
    expect(h.containerIdWrites).not.toContain("cid-db");
    expect(h.notifications).toContain("deployment.succeeded");
    // And it never mis-fires the no-op settle.
    expect(h.statusWrites.some((w) => w.status === "cancelled")).toBe(false);
  });
});
