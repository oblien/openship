import { describe, it, expect, beforeEach, vi } from "vitest";

const h = vi.hoisted(() => {
  const transitions: Array<[string, string, Record<string, unknown> | undefined]> = [];
  const fakeExecutor: {
    runtimeName: "docker" | "bare" | "cloud";
    stopService: ReturnType<typeof vi.fn>;
    startService: ReturnType<typeof vi.fn>;
    isRunning: ReturnType<typeof vi.fn>;
  } = {
    runtimeName: "docker",
    stopService: vi.fn(async () => {}),
    startService: vi.fn(async () => {}),
    isRunning: vi.fn(async () => false),
  };
  const fakeDestination = { get: vi.fn(), head: vi.fn() };

  return {
    transitions,
    fakeExecutor,
    fakeDestination,
    buildApplyTargetResult: null as {
      executor: unknown;
      serviceHandle: Record<string, unknown>;
    } | null,
    currentRestore: null as Record<string, unknown> | null,
    currentRun: null as Record<string, unknown> | null,
    currentDestination: null as Record<string, unknown> | null,
    repos: {
      backupRestore: {
        findById: vi.fn(async (_id: string) => h.currentRestore),
        transition: vi.fn(async (id: string, status: string, patch?: Record<string, unknown>) => {
          transitions.push([id, status, patch]);
          if (h.currentRestore && h.currentRestore.id === id) {
            h.currentRestore.status = status;
            if (patch?.errorMessage !== undefined) {
              h.currentRestore.errorMessage = patch.errorMessage;
            }
            if (patch?.bytesRestored !== undefined) {
              h.currentRestore.bytesRestored = patch.bytesRestored;
            }
          }
        }),
      },
      backupRun: { findById: vi.fn(async () => h.currentRun) },
      backupDestination: { findById: vi.fn(async () => h.currentDestination) },
      service: { findById: vi.fn(async () => null) },
      project: { findById: vi.fn(async () => null) },
      deployment: { findById: vi.fn(async () => null) },
      mailServer: { get: vi.fn(async () => null) },
    },
  };
});

vi.mock("@repo/db", () => ({ repos: h.repos }));

vi.mock("@repo/adapters", () => ({
  resolveDestination: vi.fn(() => h.fakeDestination),
  resolveProducer: vi.fn(() => ({ restore: vi.fn() })),
  resolveExecutor: vi.fn(() => h.fakeExecutor),
}));

vi.mock("../backup-destinations/hydrate-server", () => ({
  toAdapterRow: vi.fn((row: unknown) => row),
}));

vi.mock("./restore.sse", () => ({
  restoreRunBus: { publish: vi.fn() },
}));

vi.mock("../../lib/notification-dispatcher", () => ({
  notification: { emit: vi.fn() },
}));

vi.mock("../../lib/encryption", () => ({
  decryptEnvMap: vi.fn((m: Record<string, string>) => m),
}));

vi.mock("../services/service-container", () => ({
  liveContainerIdForService: vi.fn(async () => null),
}));

vi.mock("../../lib/deployment-runtime", () => ({
  resolveDeploymentPlatform: vi.fn(),
  resolveTargetPlatform: vi.fn(),
}));

const { restoreOrchestrator } = await import("./restore.orchestrator");

const fakeCtx = {
  organizationId: "org1",
  userId: "usr1",
  user: { id: "usr1", email: "x", name: null },
  role: "owner" as const,
  membershipId: "mem1",
  sessionId: "sess1",
  sessionKind: "cookie" as const,
  clientIp: null,
  userAgent: null,
  traceId: "trace1",
  hono: null,
} as any;

const makeRestore = (status: string) => ({
  id: "rst_1",
  runId: "run1",
  destinationId: "dst1",
  organizationId: "org1",
  status,
  mode: "in_place",
  forkMailServerId: null,
});

const makeRun = (sourceKind: string, over: Record<string, unknown> = {}) => ({
  id: "run1",
  sourceKind,
  serviceId: sourceKind === "service" ? "svc1" : null,
  mailServerId: sourceKind === "mail_server" ? "ms1" : null,
  artifacts: [],
  ...over,
});

const makeDestination = () => ({
  id: "dst1",
  organizationId: "org1",
});

const makeServiceHandle = (containerId: string | null) => ({
  id: "svc1",
  projectId: "proj1",
  name: "hello",
  image: null,
  env: {},
  volumes: ["trialdata:/data"],
  containerId,
  projectSlug: "demo",
  namespaceVolumes: true,
});

beforeEach(() => {
  vi.clearAllMocks();
  h.transitions.length = 0;
  h.currentRestore = null;
  h.currentRun = null;
  h.currentDestination = null;
  h.buildApplyTargetResult = null;
  h.fakeExecutor.runtimeName = "docker";

  (restoreOrchestrator as any).buildApplyTarget = vi.fn(async () => h.buildApplyTargetResult);
});

describe("RestoreOrchestrator", () => {
  describe("runApply", () => {
    it("fails fast when a docker service has no live managed container", async () => {
      h.currentRestore = makeRestore("prepared");
      h.currentRun = makeRun("service");
      h.currentDestination = makeDestination();
      h.buildApplyTargetResult = {
        executor: h.fakeExecutor,
        serviceHandle: makeServiceHandle(null),
      };

      await (restoreOrchestrator as any).runApply("rst_1");

      const failed = h.transitions.find((t) => t[1] === "failed");
      expect(failed).toBeTruthy();
      expect((failed![2] as any).errorMessage).toMatch(/no live managed container/);
      expect(h.fakeExecutor.stopService).not.toHaveBeenCalled();
    });

    it("proceeds when the container exists on a docker service", async () => {
      h.currentRestore = makeRestore("prepared");
      h.currentRun = makeRun("service");
      h.currentDestination = makeDestination();
      h.buildApplyTargetResult = {
        executor: h.fakeExecutor,
        serviceHandle: makeServiceHandle("container123"),
      };

      await (restoreOrchestrator as any).runApply("rst_1");

      expect(h.transitions.map((t) => t[1])).toEqual(["applying", "succeeded"]);
      expect(h.fakeExecutor.stopService).toHaveBeenCalledTimes(1);
      expect(h.fakeExecutor.startService).toHaveBeenCalledTimes(1);
    });

    it("allows bare runtimes with no container", async () => {
      h.currentRestore = makeRestore("prepared");
      h.currentRun = makeRun("service");
      h.currentDestination = makeDestination();
      h.fakeExecutor.runtimeName = "bare";
      h.buildApplyTargetResult = {
        executor: h.fakeExecutor,
        serviceHandle: makeServiceHandle(null),
      };

      await (restoreOrchestrator as any).runApply("rst_1");

      expect(h.transitions.map((t) => t[1])).toEqual(["applying", "succeeded"]);
    });

    it("allows mail-server restores with no container", async () => {
      h.currentRestore = makeRestore("prepared");
      h.currentRun = makeRun("mail_server");
      h.currentDestination = makeDestination();
      h.fakeExecutor.runtimeName = "bare";
      h.buildApplyTargetResult = {
        executor: h.fakeExecutor,
        serviceHandle: makeServiceHandle(null),
      };

      await (restoreOrchestrator as any).runApply("rst_1");

      expect(h.transitions.map((t) => t[1])).toEqual(["applying", "succeeded"]);
    });
  });

  describe("cancel", () => {
    it("cancels an applying restore and best-effort starts the service", async () => {
      h.currentRestore = makeRestore("applying");
      h.currentRun = makeRun("service");
      h.currentDestination = makeDestination();
      h.buildApplyTargetResult = {
        executor: h.fakeExecutor,
        serviceHandle: makeServiceHandle("container123"),
      };

      await restoreOrchestrator.cancel(fakeCtx, "rst_1");

      expect(h.transitions.map((t) => t[1])).toContain("cancelled");

      // bestEffortStart is scheduled on setImmediate.
      await new Promise((resolve) => setImmediate(resolve));
      await vi.waitFor(() => expect(h.fakeExecutor.startService).toHaveBeenCalled());
    });

    it("still cancels a prepared restore", async () => {
      h.currentRestore = makeRestore("prepared");

      await restoreOrchestrator.cancel(fakeCtx, "rst_1");

      expect(h.transitions).toEqual([["rst_1", "cancelled", undefined]]);
    });

    it("refuses to cancel a terminal restore", async () => {
      h.currentRestore = makeRestore("succeeded");

      await expect(restoreOrchestrator.cancel(fakeCtx, "rst_1")).rejects.toThrow(
        "Cannot cancel a succeeded restore",
      );
    });
  });
});
