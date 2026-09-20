import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Deploying to the local box must not SSH to the local box.
 *
 * On a compose install the api container shares the edge's routing mounts and can
 * reach the daemon over its own socket — that's the `localContainerEdgeProvider`
 * fast path. Which path we take used to be inferred from `!executor && !ssh`, and
 * that inference was wrong for the auto-registered "This Server" row: it targets
 * this machine but injects the pooled HOST executor, so routing went the long way
 * round, over SSH to `host.docker.internal`.
 *
 * The long way round is not merely slower — it introduces a dependency the fast
 * path doesn't have. With a default-deny host firewall the bridge is filtered, so
 * platform construction died on a handshake timeout and took every deploy with it
 * (#490), while the socket doing the actual work was fine throughout.
 */

vi.mock("./system/setup", () => ({ SystemManager: class {} }));
vi.mock("./runtime/bare", () => ({ BareRuntime: class {} }));

const LOCAL_EDGE = { marker: "local-container-edge" };

vi.mock("./system/proxy/ensure-container-edge", () => ({
  localContainerEdgeProvider: vi.fn(async () => LOCAL_EDGE),
  containerEdgeProvider: vi.fn(async () => ({ marker: "remote-container-edge" })),
}));

// No edge container on the far box, so the fallback is the bare/SSH path — which is
// what makes "did we go remote?" observable as a call on the executor.
vi.mock("./system/proxy/detect", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./system/proxy/detect")>()),
  resolveOurEdgeContainer: vi.fn(async () => null),
}));

import { createPlatform } from "./platform";

function stubExecutor() {
  return {
    exec: vi.fn(async () => ""),
    mkdir: vi.fn(async () => {}),
    writeFile: vi.fn(async () => {}),
    readFile: vi.fn(async () => ""),
    exists: vi.fn(async () => true),
    rm: vi.fn(async () => {}),
    streamExec: vi.fn(async () => ({ code: 0, output: "" })),
    transferIn: vi.fn(async () => {}),
    dispose: vi.fn(async () => {}),
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("local-host edge selection", () => {
  it("uses the shared container edge when the target is THIS machine", async () => {
    vi.stubEnv("OPENSHIP_EDGE_MODE", "docker");
    const executor = stubExecutor();

    const platform = await createPlatform({
      target: "selfhosted",
      runtime: "bare",
      executor: executor as never,
      localHost: true,
    });

    expect(platform.routing).toBe(LOCAL_EDGE);
    expect(platform.ssl).toBe(LOCAL_EDGE);
    // The assertion that actually pins #490: an injected executor no longer forces a
    // trip over the host channel, so nothing routing-related can be firewalled off.
    expect(executor.exec).not.toHaveBeenCalled();
  });

  it("still treats an injected executor as remote when localHost is not set", async () => {
    // The inference has to survive for real server targets, which pass an executor
    // and mean it.
    vi.stubEnv("OPENSHIP_EDGE_MODE", "docker");
    const executor = stubExecutor();

    const platform = await createPlatform({
      target: "selfhosted",
      runtime: "bare",
      executor: executor as never,
    });

    expect(platform.routing).not.toBe(LOCAL_EDGE);
    expect(executor.exec).toHaveBeenCalled();
  });

  it("never takes the local-edge path for an ssh target, whatever localHost says", async () => {
    vi.stubEnv("OPENSHIP_EDGE_MODE", "docker");
    const executor = stubExecutor();

    const platform = await createPlatform({
      target: "selfhosted",
      runtime: "bare",
      executor: executor as never,
      ssh: { host: "10.0.0.9", privateKey: "k" },
      localHost: true,
    });

    expect(platform.routing).not.toBe(LOCAL_EDGE);
  });
});
