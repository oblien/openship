import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  barePaths: { confPath: "/etc/openresty/nginx.conf" },
  options: { debug: false },
  executor: {},
  privileged: { exec: vi.fn() },
  runningContainer: vi.fn(),
  provider: {},
  container: vi.fn(),
  detectContainer: vi.fn(),
  detectPaths: vi.fn(),
  elevate: vi.fn(),
  reach: vi.fn(),
  cacheGet: vi.fn(),
  cacheSet: vi.fn(),
}));

vi.mock("@repo/adapters", () => ({
  NginxProvider: class {
    constructor(readonly options: unknown) {}
  },
  containerEdgeProvider: mocks.container,
  detectEdgeContainer: mocks.detectContainer,
  detectOpenRestyPaths: mocks.detectPaths,
  rootOrDegrade: mocks.elevate,
  resolveOurEdgeContainer: mocks.runningContainer,
}));
vi.mock("@repo/platform/engine/lib/ssh-manager", () => ({
  sshManager: {
    probeReachable: mocks.reach,
    withExecutor: async (_server: string, run: (executor: unknown) => unknown) => run(mocks.executor),
  },
}));
vi.mock("@repo/platform/engine/lib/cache-store/index", () => ({
  cacheStore: async () => ({ get: mocks.cacheGet, set: mocks.cacheSet }),
}));
vi.mock("@repo/platform/engine/lib/edge-provider-options", () => ({
  resolveEdgeProviderOptions: async () => mocks.options,
}));

import { withOpenRestyRouting } from "@repo/platform/engine/lib/openresty-paths";

beforeEach(() => {
  vi.resetAllMocks();
  mocks.reach.mockResolvedValue(true);
  mocks.runningContainer.mockResolvedValue(null);
  mocks.elevate.mockResolvedValue(mocks.privileged);
  mocks.container.mockResolvedValue(mocks.provider);
  mocks.detectPaths.mockResolvedValue(mocks.barePaths);
});

it("uses the serving container for edge pages and skips host path detection", async () => {
  mocks.runningContainer.mockResolvedValue("renamed-edge");
  mocks.detectContainer.mockResolvedValue({ name: "old-edge", running: false, exists: true });

  const result = await withOpenRestyRouting("server", async (routing) => routing, {
    useServingEdge: true,
  });

  expect(result).toBe(mocks.provider);
  expect(mocks.runningContainer).toHaveBeenCalledWith(mocks.privileged, { fresh: true });
  expect(mocks.detectContainer).not.toHaveBeenCalled();
  expect(mocks.container).toHaveBeenCalledWith(mocks.executor, "renamed-edge", mocks.options);
  expect(mocks.detectPaths).not.toHaveBeenCalled();
});

it("retains bare OpenResty support when the server has no edge container", async () => {
  mocks.detectContainer.mockResolvedValue({ name: null, running: false, exists: false });

  const result = await withOpenRestyRouting("server", async (routing) => routing, {
    useServingEdge: true,
  });

  expect(result).toMatchObject({
    options: { ...mocks.options, paths: mocks.barePaths, executor: mocks.privileged },
  });
  expect(mocks.container).not.toHaveBeenCalled();
});


it.each([
  { installed: { name: "old-edge", running: false, exists: true }, docker: "present" },
  { installed: null, docker: "present" },
])("rejects unavailable Docker edge without touching host configuration", async ({ installed, docker }) => {
  mocks.detectContainer.mockResolvedValue(installed);
  mocks.privileged.exec.mockResolvedValue(docker);
  const work = vi.fn();

  await expect(withOpenRestyRouting("server", work, { useServingEdge: true }))
    .rejects.toMatchObject({ code: "SERVER_EDGE_UNAVAILABLE" });
  expect(work).not.toHaveBeenCalled();
  expect(mocks.detectPaths).not.toHaveBeenCalled();
});

it("preserves Docker-less bare OpenResty servers", async () => {
  mocks.detectContainer.mockResolvedValue(null);
  mocks.privileged.exec.mockResolvedValue("absent");

  const result = await withOpenRestyRouting("server", async (routing) => routing, {
    useServingEdge: true,
  });

  expect(result).toMatchObject({ options: { paths: mocks.barePaths } });
});
