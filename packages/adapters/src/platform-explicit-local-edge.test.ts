import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  localProvider: { kind: "local-edge" },
  remoteProvider: { kind: "remote-edge" },
  localCalls: [] as string[],
  remoteCalls: [] as string[],
  dockerCreates: 0,
}));

vi.mock("./system/setup", () => ({ SystemManager: class {} }));
vi.mock("./runtime/bare", () => ({
  BareRuntime: class {
    constructor(readonly options: unknown) {}
  },
}));
vi.mock("./runtime/docker", () => ({
  DockerRuntime: {
    create: vi.fn(async () => {
      h.dockerCreates++;
      return { name: "docker" };
    }),
  },
}));
vi.mock("./system/proxy/ensure-container-edge", () => ({
  localContainerEdgeProvider: vi.fn(async (container: string) => {
    h.localCalls.push(container);
    return h.localProvider;
  }),
  containerEdgeProvider: vi.fn(async (_executor: unknown, container: string) => {
    h.remoteCalls.push(container);
    return h.remoteProvider;
  }),
}));
vi.mock("./system/proxy/detect", () => ({
  resolveOurEdgeContainer: vi.fn(async () => "remote-edge"),
}));

import { createPlatform } from "./platform";

const executor = {
  exec: vi.fn(async () => ""),
  mkdir: vi.fn(async () => undefined),
  writeFile: vi.fn(async () => undefined),
  readFile: vi.fn(async () => ""),
  exists: vi.fn(async () => false),
  rm: vi.fn(async () => undefined),
  streamExec: vi.fn(async () => ({ code: 0, output: "" })),
  transferIn: vi.fn(async () => undefined),
  dispose: vi.fn(async () => undefined),
};

beforeEach(() => {
  h.localCalls = [];
  h.remoteCalls = [];
  h.dockerCreates = 0;
  vi.stubEnv("OPENSHIP_EDGE_MODE", "docker");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("createPlatform — explicit local edge topology", () => {
  it.each(["bare", "docker"] as const)(
    "uses mounted local-edge files independently from the %s workload executor",
    async (runtime) => {
      const platform = await createPlatform({
        target: "selfhosted",
        runtime,
        executor: executor as never,
        docker: runtime === "docker" ? { transport: "socket" } : undefined,
        localEdgeContainer: "openship-edge",
      });

      expect(platform.executor).toBe(executor);
      expect(platform.routing).toBe(h.localProvider);
      expect(platform.ssl).toBe(h.localProvider);
      expect(h.localCalls).toEqual(["openship-edge"]);
      expect(h.remoteCalls).toEqual([]);
      expect(h.dockerCreates).toBe(runtime === "docker" ? 1 : 0);
    },
  );

  it("retains remote edge discovery when the topology is not explicitly local", async () => {
    const platform = await createPlatform({
      target: "selfhosted",
      runtime: "bare",
      executor: executor as never,
    });

    expect(platform.routing).toBe(h.remoteProvider);
    expect(h.localCalls).toEqual([]);
    expect(h.remoteCalls).toEqual(["remote-edge"]);
  });
});
