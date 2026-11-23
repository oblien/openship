import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  barePaths: { confPath: "/etc/openresty/nginx.conf" },
  options: { debug: false },
  executor: {},
  privileged: {},
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
  mocks.elevate.mockResolvedValue(mocks.privileged);
  mocks.container.mockResolvedValue(mocks.provider);
  mocks.detectPaths.mockResolvedValue(mocks.barePaths);
});

it("uses the serving container for edge pages and skips host path detection", async () => {
  mocks.detectContainer.mockResolvedValue({ name: "renamed-edge", running: true, exists: true });

  const result = await withOpenRestyRouting("server", async (routing) => routing, {
    useServingEdge: true,
  });

  expect(result).toBe(mocks.provider);
  expect(mocks.detectContainer).toHaveBeenCalledWith(mocks.privileged);
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
