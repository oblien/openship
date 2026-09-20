import { beforeEach, describe, expect, it, vi } from "vitest";

import { probeOutput } from "./environment.fixtures";
import { SystemManager } from "./setup";
import type { SetupState, SetupStateStore } from "./state";
import type { CommandExecutor } from "../types";

/**
 * The staleness contract of the cached state, from both entry points.
 *
 * `checkFeature` served its cached fast path with no regard for freshness while
 * `isReady` re-verified — and since nothing outside this class calls
 * isReady()/verify(), a box reached only through ensureFeature/requireFeature kept
 * answering "docker is healthy" from a stamp written the day it was provisioned,
 * forever, so ensureFeature's self-heal never ran.
 *
 * Also pinned here: the partial-check trap. `lastVerifiedAt` is ONE stamp for the
 * whole state, so a check of one component must not refresh the freshness of the
 * components it never probed.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

function memoryStore(initial: SetupState | null): SetupStateStore & {
  writes: SetupState[];
  current: () => SetupState | null;
} {
  let state = initial;
  const writes: SetupState[] = [];
  return {
    writes,
    current: () => state,
    get: async () => (state ? structuredClone(state) : null),
    set: async (next) => {
      state = structuredClone(next);
      writes.push(structuredClone(next));
    },
    clear: async () => {
      state = null;
    },
  };
}

/**
 * A box that answers every probe with `answers`, or "" (nothing installed).
 *
 * The host probe is matched first, as in edge-check.test.ts: it is one `sh` script
 * carrying `uname`/`command -v` lines that a needle written for anything else would
 * otherwise capture.
 */
function box(answers: Array<[string, string]> = []): CommandExecutor & {
  exec: ReturnType<typeof vi.fn>;
} {
  const exec = vi.fn(async (cmd: string) => {
    if (cmd.includes("opsh_begin")) return probeOutput();
    for (const [needle, out] of answers) if (cmd.includes(needle)) return out;
    return "";
  });
  return { exec } as unknown as CommandExecutor & { exec: ReturnType<typeof vi.fn> };
}

/** Every required component healthy — docker + git + a serving edge container. */
function healthyBox() {
  return box([
    ["docker --version", "Docker version 29.7.1, build abc1234"],
    ["docker info", "29.7.1"],
    ["docker ps --filter name=openship-edge", "openship-edge"],
    ["docker inspect", "running"],
    // A kernel socket table with :80 (0x50) in LISTEN (0A) — what "serving" reads as.
    [
      "/proc/net/tcp",
      "  0: 00000000:0050 00000000:0000 0A 00000000:00000000 0 0 1 1 ffff 100 0 0 10 0",
    ],
    ["openresty -v", "nginx version: openresty/1.27.1.1"],
    ["git --version", "git version 2.43.0"],
  ]);
}

async function waitForWrite(store: { writes: SetupState[] }): Promise<void> {
  for (let i = 0; i < 200; i += 1) {
    if (store.writes.length > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("no state was ever persisted - the background re-verify never ran");
}

function healthy(installed = true) {
  return { installed, healthy: true, running: true, version: "1.0.0" };
}

function stateWith(opts: {
  verifiedAgeMs: number;
  components?: Record<string, ReturnType<typeof healthy>>;
  setupComplete?: boolean;
}): SetupState {
  const stamp = new Date(Date.now() - opts.verifiedAgeMs).toISOString();
  return {
    setupComplete: opts.setupComplete ?? true,
    mode: "docker",
    components: opts.components ?? {
      docker: healthy(),
      git: healthy(),
      edge: healthy(),
    },
    lastVerifiedAt: stamp,
    updatedAt: stamp,
  };
}

describe("SystemManager.checkFeature — cached fast path", () => {
  let executor: ReturnType<typeof box>;

  beforeEach(() => {
    executor = box();
  });

  it("serves a FRESH cache without touching the box or re-verifying", async () => {
    const store = memoryStore(stateWith({ verifiedAgeMs: 60_000 }));
    const manager = new SystemManager("docker", { executor, stateStore: store });
    const verify = vi.spyOn(manager, "verify");

    const readiness = await manager.checkFeature("deploy");

    expect(readiness.ready).toBe(true);
    expect(executor.exec).not.toHaveBeenCalled();
    expect(verify).not.toHaveBeenCalled();
  });

  it("kicks the re-verify when the cache is STALE (and still answers from cache)", async () => {
    const store = memoryStore(stateWith({ verifiedAgeMs: 3 * DAY_MS }));
    const manager = new SystemManager("docker", { executor, stateStore: store });
    const verify = vi
      .spyOn(manager, "verify")
      .mockResolvedValue({ components: [], ready: true, missing: [] });

    const readiness = await manager.checkFeature("deploy");

    // Cached answer is still served — the gate must not block on a probe.
    expect(readiness.ready).toBe(true);
    expect(executor.exec).not.toHaveBeenCalled();
    expect(verify).toHaveBeenCalledTimes(1);
  });

  it("kicks at most ONE re-verify while it is in flight (a deploy gates several features)", async () => {
    const store = memoryStore(stateWith({ verifiedAgeMs: 3 * DAY_MS }));
    const manager = new SystemManager("docker", { executor, stateStore: store });
    let release: (() => void) | undefined;
    const verify = vi.spyOn(manager, "verify").mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ components: [], ready: true, missing: [] });
        }),
    );

    await manager.checkFeature("deploy");
    await manager.checkFeature("routing");
    await manager.isReady();

    expect(verify).toHaveBeenCalledTimes(1);

    // Once it settles, a later stale call may kick again.
    release?.();
    await Promise.resolve();
    await Promise.resolve();
    await manager.checkFeature("deploy");
    expect(verify).toHaveBeenCalledTimes(2);
  });

  it("isReady serves a stale cache and kicks the same re-verify", async () => {
    const store = memoryStore(stateWith({ verifiedAgeMs: 3 * DAY_MS }));
    const manager = new SystemManager("docker", { executor, stateStore: store });
    const verify = vi
      .spyOn(manager, "verify")
      .mockResolvedValue({ components: [], ready: true, missing: [] });

    await expect(manager.isReady()).resolves.toBe(true);
    expect(verify).toHaveBeenCalledTimes(1);
  });

  it("falls through to a real check when the cache says a prerequisite is unhealthy, and persists nothing", async () => {
    const store = memoryStore(
      stateWith({
        verifiedAgeMs: 60_000,
        components: {
          docker: { installed: false, healthy: false, running: false, version: "" },
          git: healthy(),
          edge: healthy(),
        },
      }),
    );
    const manager = new SystemManager("docker", { executor, stateStore: store });

    const readiness = await manager.checkFeature("deploy");

    expect(readiness.ready).toBe(false);
    expect(readiness.missing.map((c) => c.name)).toEqual(["docker"]);
    expect(executor.exec).toHaveBeenCalled();
    // A one-feature check must not write the global state (see the trap below).
    expect(store.writes).toHaveLength(0);
  });
});

describe("SystemManager component dependencies", () => {
  it("requires Docker for bare-mode setup because Edge is a container", () => {
    const manager = new SystemManager("bare", { executor: box() });
    expect(manager.getRequired()).toEqual(["docker", "git", "edge"]);
  });

  it("reports Docker as a routing prerequisite instead of checking Edge alone", async () => {
    const manager = new SystemManager("bare", { executor: box() });

    const readiness = await manager.checkFeature("routing");

    expect(readiness.ready).toBe(false);
    expect(readiness.missing.map((component) => component.name)).toEqual(["docker", "edge"]);
  });
});

describe("SystemManager state freshness stamp", () => {
  /**
   * The trap: `lastVerifiedAt` is global. A partial check that stamped it would
   * declare docker/edge freshly verified on the strength of an rsync probe, and
   * that permanently silences the 24h re-verify for every component.
   */
  it("a PARTIAL check records the component but does not refresh freshness", async () => {
    const before = stateWith({ verifiedAgeMs: 3 * DAY_MS });
    const store = memoryStore(before);
    const manager = new SystemManager("docker", {
      executor: box([["rsync --version", "rsync  version 3.2.7  protocol version 31"]]),
      stateStore: store,
    });

    await manager.ensureComponents(["rsync"]);

    const after = store.current();
    expect(after?.components.rsync?.healthy).toBe(true);
    expect(after?.lastVerifiedAt).toBe(before.lastVerifiedAt);
  });

  it("a check covering every required component DOES refresh freshness", async () => {
    const before = stateWith({ verifiedAgeMs: 3 * DAY_MS });
    const store = memoryStore(before);
    const manager = new SystemManager("docker", { executor: box(), stateStore: store });

    await manager.checkRequired();

    const after = store.current();
    expect(after?.lastVerifiedAt).not.toBe(before.lastVerifiedAt);
    // Nothing answered a probe, so the box is no longer set up.
    expect(after?.setupComplete).toBe(false);
  });
});

/**
 * End to end, with no spies: a stale box gated through checkFeature re-verifies
 * itself and then stops. Pre-fix this test could not pass — nothing ever wrote.
 */
describe("SystemManager — the stale box heals itself", () => {
  it("re-verifies behind the gate, then serves a fresh cache", async () => {
    const before = stateWith({ verifiedAgeMs: 3 * DAY_MS });
    const store = memoryStore(before);
    const manager = new SystemManager("docker", {
      executor: healthyBox(),
      stateStore: store,
    });

    const readiness = await manager.checkFeature("deploy");
    expect(readiness.ready).toBe(true);

    await waitForWrite(store);
    const after = store.current();
    expect(after?.setupComplete).toBe(true);
    expect(after?.lastVerifiedAt).not.toBe(before.lastVerifiedAt);

    const verify = vi.spyOn(manager, "verify");
    await manager.checkFeature("deploy");
    expect(verify).not.toHaveBeenCalled();
  });
});
