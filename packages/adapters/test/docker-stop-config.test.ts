import type Dockerode from "dockerode";
import { describe, expect, it, vi } from "vitest";

import { gracefulStopForGrace, toStopConfig } from "../src/runtime/docker";

/** Minimal container double — records whether stop() was issued. Cast to the
 *  dockerode Container surface the helper actually touches (inspect + stop). */
function fakeContainer(opts: {
  stopTimeout?: number | null;
  inspectRejects?: boolean;
  stopRejects?: boolean;
}) {
  const stop = vi.fn(async () => {
    if (opts.stopRejects) throw new Error("304 / already stopped");
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
 * #388: setting StopTimeout/StopSignal is inert unless a *graceful* stop is
 * issued — recreate/teardown force-removes (SIGKILL). gracefulStopForGrace gives
 * a container that opted into a grace period a clean stop before the caller's
 * force-remove, and stays out of the way for everyone else (no redeploy latency).
 */
describe("gracefulStopForGrace (#388)", () => {
  it("stops a container that declared a positive grace period (opted in)", async () => {
    const c = fakeContainer({ stopTimeout: 60 });
    await gracefulStopForGrace(c.container);
    expect(c.stop).toHaveBeenCalledTimes(1);
  });

  it("does NOT stop a container with the default (unset) StopTimeout — fast path preserved", async () => {
    const c = fakeContainer({ stopTimeout: null });
    await gracefulStopForGrace(c.container);
    expect(c.stop).not.toHaveBeenCalled();
  });

  it("does NOT stop when the field is absent entirely", async () => {
    const stop = vi.fn(async () => {});
    const container = { stop, inspect: vi.fn(async () => ({ Config: {} })) } as unknown as Dockerode.Container;
    await gracefulStopForGrace(container);
    expect(stop).not.toHaveBeenCalled();
  });

  it("does NOT graceful-stop an explicit zero grace (operator asked to kill immediately)", async () => {
    const c = fakeContainer({ stopTimeout: 0 });
    await gracefulStopForGrace(c.container);
    expect(c.stop).not.toHaveBeenCalled();
  });

  it("swallows an inspect failure (gone / racing removal) and never stops", async () => {
    const c = fakeContainer({ inspectRejects: true });
    await expect(gracefulStopForGrace(c.container)).resolves.toBeUndefined();
    expect(c.stop).not.toHaveBeenCalled();
  });

  it("swallows a stop failure (already stopped) so the caller's force-remove still runs", async () => {
    const c = fakeContainer({ stopTimeout: 30, stopRejects: true });
    await expect(gracefulStopForGrace(c.container)).resolves.toBeUndefined();
    expect(c.stop).toHaveBeenCalledTimes(1);
  });
});
