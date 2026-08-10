import { describe, it, expect } from "vitest";
import { SYSTEM } from "@repo/core";
import { resolveReadinessGate, runReadinessGate } from "../../../src/modules/deployments/readiness-gate";

/**
 * `active: false` is the load-bearing assertion in this file. build-pipeline reads
 * it to decide whether to hand runDeployPipeline a readiness AT ALL, and the
 * pipeline skips the step entirely when there isn't one. If any of these started
 * resolving to active, every deploy would go back to waiting up to a minute after
 * start for a verdict that can veto (and previously destroy) a working container.
 */
describe("resolveReadinessGate — off unless asked", () => {
  it("is inactive for null, undefined, and an empty object", () => {
    for (const value of [null, undefined, {}]) {
      const gate = resolveReadinessGate(value);
      expect(gate.active).toBe(false);
      expect(gate.probe.enabled).toBe(false);
      expect(gate.stabilization.enabled).toBe(false);
    }
  });

  it("treats explicit false the same as absent", () => {
    const gate = resolveReadinessGate({ enabled: false, stabilization: false });
    expect(gate.active).toBe(false);
  });

  // A config that carries tuning but never turns anything on is still off — the
  // knobs must not imply consent.
  it("stays inactive when only timings are declared", () => {
    const gate = resolveReadinessGate({ timeoutSeconds: 90, stabilizationSeconds: 30, path: "/healthz" });
    expect(gate.active).toBe(false);
  });

  it("goes active on the probe alone", () => {
    const gate = resolveReadinessGate({ enabled: true });
    expect(gate.active).toBe(true);
    expect(gate.probe.enabled).toBe(true);
    expect(gate.stabilization.enabled).toBe(false);
  });

  it("goes active on stabilization alone", () => {
    const gate = resolveReadinessGate({ stabilization: true });
    expect(gate.active).toBe(true);
    expect(gate.probe.enabled).toBe(false);
    expect(gate.stabilization.enabled).toBe(true);
  });
});

describe("resolveReadinessGate — failure action", () => {
  // Opting into a probe to get the log line must not opt you into a veto.
  it("defaults to warn even when a check is enabled", () => {
    expect(resolveReadinessGate({ enabled: true }).onFailure).toBe("warn");
    expect(resolveReadinessGate({ stabilization: true }).onFailure).toBe("warn");
  });

  it("honours an explicit fail", () => {
    expect(resolveReadinessGate({ enabled: true, onFailure: "fail" }).onFailure).toBe("fail");
  });

  it("falls back to warn for an unrecognised action", () => {
    const gate = resolveReadinessGate({ enabled: true, onFailure: "explode" as never });
    expect(gate.onFailure).toBe("warn");
  });
});

describe("resolveReadinessGate — timings", () => {
  it("falls back to the SYSTEM defaults", () => {
    const gate = resolveReadinessGate({ enabled: true, stabilization: true });
    expect(gate.probe.timeoutMs).toBe(SYSTEM.DEPLOYMENTS.READINESS_TIMEOUT_MS);
    expect(gate.probe.intervalMs).toBe(SYSTEM.DEPLOYMENTS.READINESS_INTERVAL_MS);
    expect(gate.stabilization.windowMs).toBe(SYSTEM.DEPLOYMENTS.STABILIZE_WINDOW_MS);
  });

  it("converts declared seconds to ms", () => {
    const gate = resolveReadinessGate({
      enabled: true,
      stabilization: true,
      timeoutSeconds: 90,
      stabilizationSeconds: 30,
    });
    expect(gate.probe.timeoutMs).toBe(90_000);
    expect(gate.stabilization.windowMs).toBe(30_000);
  });

  // A zero/negative timeout would make the probe fail instantly on every deploy,
  // which reads as "the app is broken". Fall back rather than honour it.
  it("ignores non-positive and non-finite timings", () => {
    for (const bad of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const gate = resolveReadinessGate({
        enabled: true,
        stabilization: true,
        timeoutSeconds: bad,
        stabilizationSeconds: bad,
      });
      expect(gate.probe.timeoutMs).toBe(SYSTEM.DEPLOYMENTS.READINESS_TIMEOUT_MS);
      expect(gate.stabilization.windowMs).toBe(SYSTEM.DEPLOYMENTS.STABILIZE_WINDOW_MS);
    }
  });
});

describe("resolveReadinessGate — probe target", () => {
  it("keeps an explicit path and port", () => {
    const gate = resolveReadinessGate({ enabled: true, path: "/healthz", port: 8080 });
    expect(gate.probe.path).toBe("/healthz");
    expect(gate.probe.port).toBe(8080);
  });

  // An undefined port is what lets the pipeline remap to the container's PUBLISHED
  // host port; an empty-string path must not become a "" path that changes the
  // probe from TCP-accept to HTTP.
  it("normalises a blank path and an unset port to undefined", () => {
    const gate = resolveReadinessGate({ enabled: true, path: "   " });
    expect(gate.probe.path).toBeUndefined();
    expect(gate.probe.port).toBeUndefined();
  });

  it("rejects a non-positive port rather than probing port 0", () => {
    expect(resolveReadinessGate({ enabled: true, port: 0 }).probe.port).toBeUndefined();
    expect(resolveReadinessGate({ enabled: true, port: -1 }).probe.port).toBeUndefined();
  });
});

/**
 * Per-service precedence for compose stacks. The compose pipeline resolves
 * `service.advanced.readiness ?? project.readiness` per service, so these pin the
 * ?? semantics that expression depends on — in particular that a service opting IN
 * doesn't leak to its peers, and a service declaring `{}` doesn't inherit.
 */
describe("resolveReadinessGate — per-service override precedence", () => {
  const effective = (
    serviceLevel: Parameters<typeof resolveReadinessGate>[0],
    projectLevel: Parameters<typeof resolveReadinessGate>[0],
  ) => resolveReadinessGate(serviceLevel ?? projectLevel);

  it("inherits the project's gate when the service declares none", () => {
    const gate = effective(undefined, { stabilization: true, onFailure: "fail" });
    expect(gate.active).toBe(true);
    expect(gate.stabilization.enabled).toBe(true);
    expect(gate.onFailure).toBe("fail");
  });

  it("a service's own gate REPLACES the project's, it does not merge", () => {
    // Service asks only for the probe; the project's stabilization must not leak in,
    // or "just probe this one service" would silently also watch it for restarts.
    const gate = effective({ enabled: true }, { stabilization: true, onFailure: "fail" });
    expect(gate.probe.enabled).toBe(true);
    expect(gate.stabilization.enabled).toBe(false);
    expect(gate.onFailure).toBe("warn");
  });

  it("a service declaring an empty object opts OUT of the project's gate", () => {
    // `{}` is present, so ?? keeps it — an explicit "nothing for me".
    const gate = effective({}, { stabilization: true, onFailure: "fail" });
    expect(gate.active).toBe(false);
  });

  it("is off when neither level declares anything", () => {
    expect(effective(undefined, undefined).active).toBe(false);
    expect(effective(undefined, null).active).toBe(false);
  });

  it("one service can veto while another only warns", () => {
    const vetoing = effective({ stabilization: true, onFailure: "fail" }, null);
    const warning = effective({ stabilization: true }, null);
    expect(vetoing.onFailure).toBe("fail");
    expect(warning.onFailure).toBe("warn");
  });
});

/**
 * runReadinessGate decides whether a deploy lives or dies, so each case here pins one
 * decision: was a check even run, and did its failure warn or veto. A throw is what
 * runDeployPipeline turns into a failed deploy + a revert.
 */
describe("runReadinessGate", () => {
  /** Collect what the gate did, so each test asserts one thing about it. */
  function harness(over: Partial<Parameters<typeof runReadinessGate>[0]> = {}) {
    const calls: string[] = [];
    const warnings: string[] = [];
    const logs: string[] = [];
    const run = (gateInput: Parameters<typeof resolveReadinessGate>[0]) =>
      runReadinessGate({
        gate: resolveReadinessGate(gateInput),
        stabilize: async () => {
          calls.push("stabilize");
          return null;
        },
        probe: async () => {
          calls.push("probe");
          return null;
        },
        onWarn: (detail) => warnings.push(detail),
        log: (message) => logs.push(message),
        ...over,
      });
    return { calls, warnings, logs, run };
  }

  it("runs nothing at all when the gate is inactive", async () => {
    const h = harness();
    await h.run(null);
    await h.run({});
    await h.run({ enabled: false, stabilization: false });
    expect(h.calls).toEqual([]);
    expect(h.warnings).toEqual([]);
  });

  it("runs only the checks that are enabled", async () => {
    const probeOnly = harness();
    await probeOnly.run({ enabled: true });
    expect(probeOnly.calls).toEqual(["probe"]);

    const stabilizeOnly = harness();
    await stabilizeOnly.run({ stabilization: true });
    expect(stabilizeOnly.calls).toEqual(["stabilize"]);

    const both = harness();
    await both.run({ enabled: true, stabilization: true });
    expect(both.calls).toEqual(["stabilize", "probe"]);
  });

  it("passes the resolved window to stabilize", async () => {
    const seen: number[] = [];
    const h = harness({
      stabilize: async (windowMs) => {
        seen.push(windowMs);
        return null;
      },
    });
    await h.run({ stabilization: true, stabilizationSeconds: 30 });
    expect(seen).toEqual([30_000]);
  });

  it("warns without throwing when onFailure is warn (the default)", async () => {
    const h = harness({ probe: async () => "never answered at 127.0.0.1:49160" });
    await expect(h.run({ enabled: true })).resolves.toBeUndefined();
    expect(h.warnings).toEqual(["never answered at 127.0.0.1:49160"]);
  });

  it("throws when onFailure is fail", async () => {
    const h = harness({ probe: async () => "never answered at 127.0.0.1:49160" });
    await expect(h.run({ enabled: true, onFailure: "fail" })).rejects.toThrow(
      "never answered at 127.0.0.1:49160",
    );
    expect(h.warnings).toEqual([]);
  });

  it("reports a passing check as neither warning nor throw", async () => {
    const h = harness();
    await expect(h.run({ enabled: true, stabilization: true, onFailure: "fail" })).resolves
      .toBeUndefined();
    expect(h.warnings).toEqual([]);
  });

  // A workload that's bouncing will never answer, so probing it just adds a full
  // timeout to a verdict that's already decided.
  it("skips the probe once stabilization has failed", async () => {
    const calls: string[] = [];
    await runReadinessGate({
      gate: resolveReadinessGate({ enabled: true, stabilization: true }),
      stabilize: async () => {
        calls.push("stabilize");
        return "did not stay up: crash loop";
      },
      probe: async () => {
        calls.push("probe");
        return null;
      },
      onWarn: () => {},
      log: () => {},
    });
    expect(calls).toEqual(["stabilize"]);
  });

  it("reports both failures when stabilization passes but the probe fails", async () => {
    const warnings: string[] = [];
    await runReadinessGate({
      gate: resolveReadinessGate({ enabled: true, stabilization: true }),
      stabilize: async () => null,
      probe: async () => "never answered",
      onWarn: (d) => warnings.push(d),
      log: () => {},
    });
    expect(warnings).toEqual(["never answered"]);
  });

  // An operator who turned the probe on should learn it didn't run, rather than
  // read a green deploy as "the probe passed".
  it("logs the reason when an enabled probe can't run here, and does not fail", async () => {
    const logs: string[] = [];
    await expect(
      runReadinessGate({
        gate: resolveReadinessGate({ enabled: true }),
        probe: undefined,
        probeSkippedReason: "skipped — the readiness probe only runs for local targets",
        onWarn: () => {},
        log: (m) => logs.push(m),
      }),
    ).resolves.toBeUndefined();
    expect(logs.join(" ")).toContain("only runs for local targets");
  });

  it("is a no-op when stabilization is enabled but there is nothing to watch", async () => {
    // Static file-serve: a release DIRECTORY, no process to sample.
    const warnings: string[] = [];
    await expect(
      runReadinessGate({
        gate: resolveReadinessGate({ stabilization: true, onFailure: "fail" }),
        stabilize: undefined,
        onWarn: (d) => warnings.push(d),
        log: () => {},
      }),
    ).resolves.toBeUndefined();
    expect(warnings).toEqual([]);
  });
});
