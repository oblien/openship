import type Dockerode from "dockerode";
import { describe, expect, it, vi } from "vitest";

import { DockerRuntime, gracefulStopBeforeRemoval, toStopConfig } from "../src/runtime/docker";

/** Minimal container double that records stop calls and detects any extra inspect request. */
function fakeContainer(opts: {
  stopTimeout?: number | null;
  inspectRejects?: boolean;
  stopError?: Error;
}) {
  const stop = vi.fn(async () => {
    if (opts.stopError) throw opts.stopError;
  });
  const inspect = vi.fn(async () => {
    if (opts.inspectRejects) throw new Error("404 no such container");
    return { Config: { StopTimeout: opts.stopTimeout } };
  });
  return { stop, inspect, container: { stop, inspect } as unknown as Dockerode.Container };
}

/**
 * #388: a compose service that declares stop_signal / stop_grace_period had both
 * parsed only to warn "not modeled" and then dropped — so a container that needs
 * longer than Docker's 10s default to flush on shutdown got SIGKILLed mid-write.
 * They now map to the container's top-level StopSignal / StopTimeout (whole
 * seconds).
 */
describe("toStopConfig (#388)", () => {
  it("adds nothing when advanced is absent or declares neither key", () => {
    expect(toStopConfig(undefined)).toEqual({});
    expect(toStopConfig({})).toEqual({});
  });

  it("passes stop_signal through verbatim", () => {
    expect(toStopConfig({ stopSignal: "SIGINT" })).toEqual({ StopSignal: "SIGINT" });
  });

  it("rounds a compose duration grace period to whole seconds", () => {
    expect(toStopConfig({ stopGracePeriod: "30s" })).toEqual({ StopTimeout: 30 });
    expect(toStopConfig({ stopGracePeriod: "1m30s" })).toEqual({ StopTimeout: 90 });
    expect(toStopConfig({ stopGracePeriod: "30" })).toEqual({ StopTimeout: 30 }); // bare = seconds
  });

  it("never truncates a positive sub-second grace to an immediate kill", () => {
    // 200ms rounds to 0s naively; clamp up so "asked for a moment" isn't "kill now".
    expect(toStopConfig({ stopGracePeriod: "200ms" })).toEqual({ StopTimeout: 1 });
  });

  it("keeps an explicit zero grace as zero (kill immediately after the signal)", () => {
    expect(toStopConfig({ stopGracePeriod: "0s" })).toEqual({ StopTimeout: 0 });
  });

  it("preserves valid Compose signs and fractional shutdown durations", () => {
    expect(toStopConfig({ stopGracePeriod: "+90s" })).toEqual({ StopTimeout: 90 });
    expect(toStopConfig({ stopGracePeriod: ".5s" })).toEqual({ StopTimeout: 1 });
    expect(toStopConfig({ stopGracePeriod: "1.s" })).toEqual({ StopTimeout: 1 });
    expect(toStopConfig({ stopGracePeriod: "1d" })).toEqual({ StopTimeout: 86400 });
  });

  // "1m30" is not a whole duration. Scanning it for unit groups read one minute
  // and dropped the 30, a grace period shorter than the one written, applied
  // without a word. It now counts as unset, like any other unreadable value.
  it("never half-reads a grace period into a shorter one", () => {
    expect(toStopConfig({ stopGracePeriod: "1m30" })).toEqual({});
    expect(toStopConfig({ stopGracePeriod: "abc5s" })).toEqual({});
    expect(toStopConfig({ stopSignal: "SIGTERM", stopGracePeriod: "1m30" })).toEqual({
      StopSignal: "SIGTERM",
    });
  });

  it("carries both together and omits an unparseable grace", () => {
    expect(toStopConfig({ stopSignal: "SIGQUIT", stopGracePeriod: "1m" })).toEqual({
      StopSignal: "SIGQUIT",
      StopTimeout: 60,
    });
    expect(toStopConfig({ stopSignal: "SIGQUIT", stopGracePeriod: "soon" })).toEqual({
      StopSignal: "SIGQUIT",
    });
  });
});

/**
 * #986: removal must issue a graceful stop even when Compose did not specify
 * a timeout. Docker owns the default, explicit grace, and image stop signal.
 */
describe("gracefulStopBeforeRemoval (#986)", () => {
  it("stops a container that declared a positive grace period (opted in)", async () => {
    const c = fakeContainer({ stopTimeout: 60 });
    await gracefulStopBeforeRemoval(c.container);
    expect(c.stop).toHaveBeenCalledTimes(1);
  });

  it("stops a container with the default (unset) StopTimeout", async () => {
    const c = fakeContainer({ stopTimeout: null });
    await gracefulStopBeforeRemoval(c.container);
    expect(c.stop).toHaveBeenCalledExactlyOnceWith();
  });

  it("stops when the field is absent entirely", async () => {
    const stop = vi.fn(async () => {});
    const container = {
      stop,
      inspect: vi.fn(async () => ({ Config: {} })),
    } as unknown as Dockerode.Container;
    await gracefulStopBeforeRemoval(container);
    expect(stop).toHaveBeenCalledExactlyOnceWith();
  });

  it("leaves an explicit zero grace to Docker without overriding it", async () => {
    const c = fakeContainer({ stopTimeout: 0 });
    await gracefulStopBeforeRemoval(c.container);
    expect(c.stop).toHaveBeenCalledExactlyOnceWith();
  });

  it("does not depend on an extra inspect request to stop", async () => {
    const c = fakeContainer({ inspectRejects: true });
    await expect(gracefulStopBeforeRemoval(c.container)).resolves.toBeUndefined();
    expect(c.stop).toHaveBeenCalledExactlyOnceWith();
    expect(c.inspect).not.toHaveBeenCalled();
  });

  it.each([304, 404])("tolerates already-stopped or gone containers (%s)", async (statusCode) => {
    const c = fakeContainer({
      stopTimeout: 30,
      stopError: Object.assign(new Error("already stopped or gone"), { statusCode }),
    });
    await expect(gracefulStopBeforeRemoval(c.container)).resolves.toBeUndefined();
    expect(c.stop).toHaveBeenCalledTimes(1);
  });

  it.each([403, 500])(
    "propagates stop failures so removal cannot fall back to SIGKILL (%s)",
    async (statusCode) => {
      const error = Object.assign(new Error("stop failed"), { statusCode });
      const c = fakeContainer({ stopTimeout: 30, stopError: error });
      await expect(gracefulStopBeforeRemoval(c.container)).rejects.toBe(error);
    },
  );
});

describe("DockerRuntime.stop: confirmed shutdown", () => {
  it.each([undefined, 304, 404, 403, 409, 500, "ECONNRESET"])(
    "accepts only successful, already-stopped or absent daemon responses (%s)",
    async (code) => {
      const error = code === undefined
        ? undefined
        : Object.assign(new Error("stop response"),
            typeof code === "number" ? { statusCode: code } : { code });
      const c = fakeContainer({ stopError: error });
      const runtime = await DockerRuntime.create({
        dockerSocketPath: "/tmp/openship-test-absent.sock",
      });
      (runtime as unknown as { _docker: unknown })._docker = {
        getContainer: vi.fn(() => c.container),
      };
      if (code === undefined || code === 304 || code === 404) {
        await expect(runtime.stop("old-scheduler")).resolves.toBeUndefined();
      } else {
        await expect(runtime.stop("old-scheduler")).rejects.toBe(error);
      }
      expect(c.stop).toHaveBeenCalledExactlyOnceWith();
      expect(c.inspect).not.toHaveBeenCalled();
    },
  );
});
