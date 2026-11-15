import { afterEach, beforeEach, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({
  now: 0,
  active: "deployment",
  sample: vi.fn(),
  dispose: vi.fn(),
  open: vi.fn(),
}));
vi.mock("node:timers/promises", () => ({
  setTimeout: async (ms: number) => {
    h.now += ms;
  },
}));
vi.mock("@repo/db", () => ({
  repos: {
    project: {
      findById: async () => ({
        id: "project",
        organizationId: "org",
        serverId: "server",
        activeDeploymentId: h.active,
      }),
    },
    deployment: {
      findById: async () => ({ id: "deployment", projectId: "project", status: "ready" }),
    },
    service: {
      listByProject: async () => [
        { id: "app", name: "app" },
        { id: "worker", name: "worker" },
      ],
    },
  },
}));
vi.mock("@repo/platform/engine/modules/services/service-container", () => ({
  containerIdForService: async (_deployment: unknown, service: { id: string }) => service.id,
}));
vi.mock("@repo/platform/engine/modules/migration/migration-runtime", () => ({
  createMigrationDockerRuntime: h.open,
}));
import { verifyPlatformDeployment } from "@repo/platform/engine/modules/migration/platform-import-health";
const healthy = {
  state: "running",
  health: null,
  restartCount: 0,
  exitCode: null,
  errorLine: null,
  oomKilled: false,
  restartPolicy: "always",
};
beforeEach(() => {
  vi.resetAllMocks();
  h.now = 0;
  h.active = "deployment";
  vi.spyOn(Date, "now").mockImplementation(() => h.now);
  h.open.mockResolvedValue({ sampleStability: h.sample, dispose: h.dispose });
  h.sample.mockResolvedValue(healthy);
});
afterEach(() => {
  vi.restoreAllMocks();
});
it("observes every imported container through the normal stabilization check", async () => {
  await verifyPlatformDeployment("project", "deployment", new AbortController().signal);
  expect(new Set(h.sample.mock.calls.map(([id]) => id))).toEqual(new Set(["app", "worker"]));
  expect(h.sample.mock.calls.length).toBeGreaterThan(2);
  expect(h.dispose).toHaveBeenCalledOnce();
});
it("refuses a ready deployment whose sidecar is unhealthy", async () => {
  h.sample.mockImplementation(async (id: string) =>
    id === "worker" ? { ...healthy, health: "unhealthy" } : healthy,
  );
  await expect(
    verifyPlatformDeployment("project", "deployment", new AbortController().signal),
  ).rejects.toMatchObject({ code: "IMPORT_RUNTIME_UNHEALTHY" });
  expect(h.dispose).toHaveBeenCalledOnce();
});
it("refuses a ready deployment with a crash loop and keeps an operator replacement untouched", async () => {
  h.sample.mockImplementation(async () => ({
    ...healthy,
    state: "restarting",
    restartCount: h.now / 1000,
  }));
  await expect(
    verifyPlatformDeployment("project", "deployment", new AbortController().signal),
  ).rejects.toMatchObject({ code: "IMPORT_RUNTIME_UNHEALTHY" });
  h.open.mockClear();
  h.active = "operator-deployment";
  await expect(
    verifyPlatformDeployment("project", "deployment", new AbortController().signal),
  ).rejects.toMatchObject({ code: "IMPORT_TARGET_CHANGED" });
  expect(h.open).not.toHaveBeenCalled();
});
