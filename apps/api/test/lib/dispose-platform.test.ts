import { afterEach, describe, expect, it, vi } from "vitest";
import type { Platform } from "@repo/adapters";

/**
 * The only thing mocked, and only because there is no other way to BE the singleton:
 * `initPlatform` builds a real platform whose runtime may bind a socket, and what the
 * ownership tests assert is object identity, not construction. Everything else in the
 * barrel is passed through by reference, so `DockerRuntime instanceof` and friends still
 * work for the rest of this file. With `shared` left null the mock is indistinguishable
 * from the real `peekPlatform` before startup, which is the state every other test here
 * runs in.
 */
const singleton = vi.hoisted(() => ({ shared: null as unknown }));
vi.mock("@repo/adapters", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  peekPlatform: () => singleton.shared,
}));

import { disposePlatform, disposeRuntime } from "../../src/lib/deployment-runtime";

/**
 * `disposePlatform` is THE release step — fourteen call sites, most of them in a
 * `finally`. Two things about it are decisions rather than mechanics, and both fail
 * silently if they regress:
 *
 *   - the runtime IS released. An SSH-backed runtime binds a loopback Docker bridge
 *     in its constructor path, so a resolve that never disposes leaks a listening
 *     socket plus an ssh child. Nothing observes that until the box runs out of file
 *     descriptors, hours later and nowhere near the cause.
 *   - the executor is NOT. `Platform.executor` also declares `dispose()` (it is
 *     required on `CommandExecutor`, unlike the runtime's optional one), but it is the
 *     pooled per-server executor `sshManager` owns and that concurrent deploys,
 *     routing applies and cert issuance on that box all share. Disposing it here
 *     would tear the transport out from under all of them — and the `.ssl`-only paths
 *     in domain-ssl.ts specifically depend on surviving this call.
 *
 * The type-level half of the guard lives at `PLATFORM_DISPOSAL`: a layer that gains a
 * `dispose()` is a missing-key error there. These pin the behaviour that table encodes.
 */

function fakePlatform(): {
  platform: Platform;
  spies: Record<"runtime" | "executor" | "routing" | "ssl" | "system", ReturnType<typeof vi.fn>>;
} {
  const spies = {
    runtime: vi.fn(async () => {}),
    executor: vi.fn(async () => {}),
    routing: vi.fn(async () => {}),
    ssl: vi.fn(async () => {}),
    system: vi.fn(async () => {}),
  };
  const platform = {
    target: "selfhosted",
    runtime: { name: "docker", dispose: spies.runtime },
    // routing/ssl/system declare no dispose today. They carry one here anyway, so a
    // disposer that stopped consulting the decision table and just walked the object
    // would be caught rather than merely unproven.
    routing: { dispose: spies.routing },
    ssl: { dispose: spies.ssl },
    system: { dispose: spies.system },
    executor: { dispose: spies.executor },
    localHost: false,
  } as unknown as Platform;
  return { platform, spies };
}

describe("disposePlatform", () => {
  it("releases the runtime and nothing else", () => {
    const { platform, spies } = fakePlatform();

    disposePlatform(platform);

    expect(spies.runtime).toHaveBeenCalledTimes(1);
    expect(spies.executor).not.toHaveBeenCalled();
    expect(spies.routing).not.toHaveBeenCalled();
    expect(spies.ssl).not.toHaveBeenCalled();
    expect(spies.system).not.toHaveBeenCalled();
  });

  // `resolveTargetPlatform` returns a bare `Platform`, `resolveDeploymentPlatform`
  // wraps it next to the effective target and server id. Both shapes are passed to
  // this function across the call sites; neither may be the one that silently no-ops.
  it("accepts either shape the resolvers hand back", () => {
    const bare = fakePlatform();
    const wrapped = fakePlatform();

    disposePlatform(bare.platform);
    disposePlatform({ platform: wrapped.platform, effectiveTarget: "server", serverId: "srv_1" });

    expect(bare.spies.runtime).toHaveBeenCalledTimes(1);
    expect(wrapped.spies.runtime).toHaveBeenCalledTimes(1);
  });

  // Every call site disposes unconditionally, in a `finally`, without first asking
  // what it got — a resolve that failed leaves the variable null.
  it("is a no-op for null and undefined", () => {
    expect(() => disposePlatform(null)).not.toThrow();
    expect(() => disposePlatform(undefined)).not.toThrow();
  });

  // Synchronous invocation matters: several call sites dispose and then immediately
  // return, so a disposer that only started closing on a later tick would race the
  // caller's own teardown.
  it("invokes dispose synchronously rather than on a later tick", () => {
    const { platform, spies } = fakePlatform();

    disposePlatform(platform);

    expect(spies.runtime).toHaveBeenCalled();
  });
});

/**
 * The third decision, and the one the two above cannot cover: WHOSE runtime it is.
 *
 * `resolveDeploymentPlatform` hands back `basePlatform` — the `getPlatform()` singleton —
 * unchanged whenever the effective target is cloud and no org-scoped platform is needed,
 * which on the SaaS is every such request. `withDeploymentPlatform`'s `finally` then passes
 * the singleton to the disposer, so one request's teardown would close the transport the
 * whole process is serving from. It is invisible today only because a cloud runtime has no
 * `dispose()` — exactly the assumption `PLATFORM_DISPOSAL` exists to stop us making.
 */
describe("disposePlatform — ownership", () => {
  afterEach(() => {
    singleton.shared = null;
  });

  it("refuses to dispose the process-wide platform's own layers", () => {
    const { platform, spies } = fakePlatform();
    singleton.shared = platform;

    disposePlatform(platform);
    disposePlatform({ platform, effectiveTarget: "cloud", serverId: null });
    // The narrow entry point too: `withDeploymentRuntime` disposes the runtime alone, so
    // guarding only the platform-shaped call would leave the same layer reachable.
    disposeRuntime(platform.runtime);

    expect(spies.runtime).not.toHaveBeenCalled();
  });

  it("still disposes a freshly resolved platform while a singleton exists", () => {
    const shared = fakePlatform();
    const fresh = fakePlatform();
    singleton.shared = shared.platform;

    disposePlatform(fresh.platform);

    expect(fresh.spies.runtime).toHaveBeenCalledTimes(1);
    expect(shared.spies.runtime).not.toHaveBeenCalled();
  });

  /**
   * A platform that merely SHARES the singleton's non-disposable fields is still its own
   * object, and must still be released. This is what keeps the guard an ownership check
   * rather than a resemblance check — `resolveTargetPlatform` builds fresh platforms that
   * legitimately carry the same pooled executor.
   */
  it("keys on the disposed layer, not on the platform looking similar", () => {
    const shared = fakePlatform();
    const fresh = fakePlatform();
    (fresh.platform as { executor: unknown }).executor = shared.platform.executor;
    singleton.shared = shared.platform;

    disposePlatform(fresh.platform);

    expect(fresh.spies.runtime).toHaveBeenCalledTimes(1);
  });

  // Before startup and in every unit test there is no singleton, and "no singleton" must
  // mean "not it" — an ownership check that threw would turn every teardown into an error.
  it("disposes normally when no platform has been initialized", () => {
    const { platform, spies } = fakePlatform();

    expect(() => disposePlatform(platform)).not.toThrow();
    expect(spies.runtime).toHaveBeenCalledTimes(1);
  });
});

describe("disposeRuntime", () => {
  // A bare or cloud runtime has nothing to release. This is what lets callers
  // dispose unconditionally instead of branching on the runtime kind.
  it("tolerates a runtime that declares no dispose", () => {
    expect(() => disposeRuntime({ name: "bare" } as never)).not.toThrow();
    expect(() => disposeRuntime(null)).not.toThrow();
  });

  // Best-effort by contract: a transport already dead can't be closed politely, and
  // a teardown failure must never replace the caller's real error — nor surface as an
  // unhandled rejection, which in the API process is a crash-level log.
  it("swallows a dispose that rejects", async () => {
    const boom = vi.fn(async () => {
      throw new Error("bridge already gone");
    });
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);

    expect(() => disposeRuntime({ dispose: boom } as never)).not.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 0));
    process.off("unhandledRejection", unhandled);

    expect(boom).toHaveBeenCalledTimes(1);
    expect(unhandled).not.toHaveBeenCalled();
  });

  // Not awaited, deliberately: closing a bridge can block on a dead socket, and no
  // caller's `finally` may hang on that.
  it("does not wait for dispose to settle", () => {
    let settled = false;
    disposeRuntime({ dispose: async () => new Promise<void>((r) => setTimeout(() => ((settled = true), r()), 5)) } as never);

    expect(settled).toBe(false);
  });
});
