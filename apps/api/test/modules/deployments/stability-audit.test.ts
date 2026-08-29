/**
 * The post-deploy stabilization audit is the piece that decides a deployment is
 * allowed to say "ready". Two properties are load-bearing:
 *
 *   - it is DECISIVE about the workload: a crash-looping container produces a
 *     finding whose message already carries the exit code and the last log lines,
 *     so nobody has to SSH to the box to learn why, and
 *   - it is ADVISORY about ITSELF: a runtime that can't be sampled (cloud, bare,
 *     an unreachable host) yields no findings at all, leaving those deploys
 *     exactly as they behaved before the audit existed. A probe that can't read
 *     the truth must never invent a failure.
 */
import { describe, expect, it, vi } from "vitest";
import { BuildLogger, type ContainerStabilitySample, type RuntimeAdapter } from "@repo/adapters";
import { verifyDeployedContainers } from "../../../src/modules/deployments/stability-audit.service";

/** Real timers, tiny window: the audit's own polling is exercised, instantly. */
const FAST = { windowMs: 60, pollMs: 5 };

function logger() {
  return new BuildLogger(() => {});
}

function sample(over: Partial<ContainerStabilitySample> = {}): ContainerStabilitySample {
  return {
    state: "running",
    exitCode: null,
    restartCount: 0,
    health: null,
    errorLine: null,
    oomKilled: false,
    restartPolicy: "always",
    ...over,
  };
}

/** Minimal runtime stub — only the members the audit actually touches. */
function runtimeStub(over: {
  capabilities?: string[];
  sampleStability?: (id: string) => Promise<ContainerStabilitySample>;
  getRuntimeLogs?: (id: string, tail?: number) => Promise<{ message: string }[]>;
}): RuntimeAdapter {
  const caps = new Set(over.capabilities ?? ["stabilityProbe"]);
  return {
    name: "docker",
    capabilities: caps,
    supports: (cap: string) => caps.has(cap),
    sampleStability: over.sampleStability,
    getRuntimeLogs: over.getRuntimeLogs ?? (async () => []),
  } as unknown as RuntimeAdapter;
}

const target = { serviceId: "svc_1", serviceName: "api", containerId: "c1" };

/** Replays a sample series, holding on the last entry. */
function series(...samples: ContainerStabilitySample[]) {
  let i = 0;
  return async () => samples[Math.min(i++, samples.length - 1)];
}

describe("verifyDeployedContainers — decisive about the workload", () => {
  it("reports a crash loop with its exit code and last log lines", async () => {
    const runtime = runtimeStub({
      sampleStability: series(
        sample({ restartCount: 0 }),
        sample({ state: "restarting", restartCount: 1, exitCode: 1 }),
        sample({ state: "restarting", restartCount: 2, exitCode: 1 }),
        sample({ restartCount: 3, exitCode: 1 }),
      ),
      getRuntimeLogs: async () => [
        { message: "Error: Cannot find module '/app/server.js'" },
        { message: "  at Module._resolveFilename" },
      ],
    });

    const [finding] = await verifyDeployedContainers(runtime, [target], logger(), FAST);

    expect(finding.verdict).toMatchObject({ status: "crash_loop", ok: false, exitCode: 1 });
    expect(finding.summary).toContain('"api" did not stay up');
    expect(finding.detail).toContain("Cannot find module");
    expect(finding.detail).toContain("Last log lines");
  });

  it("keeps the failure diagnosable when the logs can't be read", async () => {
    const runtime = runtimeStub({
      sampleStability: series(sample({ state: "exited", exitCode: 127, restartPolicy: "no" })),
      getRuntimeLogs: async () => {
        throw new Error("log stream closed");
      },
    });

    const [finding] = await verifyDeployedContainers(runtime, [target], logger(), FAST);

    expect(finding.verdict.status).toBe("exited");
    expect(finding.detail).toContain("code 127");
    expect(finding.detail).not.toContain("Last log lines");
  });

  it("passes a container that bounced once and settled, and says so", async () => {
    const runtime = runtimeStub({
      sampleStability: series(sample({ restartCount: 0 }), sample({ restartCount: 1 })),
    });

    const [finding] = await verifyDeployedContainers(runtime, [target], logger(), FAST);

    expect(finding.verdict.ok).toBe(true);
    expect(finding.verdict.warning).toContain("restarted 1 time");
  });
});

describe("verifyDeployedContainers — advisory about itself", () => {
  it("stays silent for a runtime with no stability probe (cloud / bare)", async () => {
    const probe = vi.fn();
    const runtime = runtimeStub({ capabilities: [], sampleStability: probe });
    expect(await verifyDeployedContainers(runtime, [target], logger())).toEqual([]);
    expect(probe).not.toHaveBeenCalled();
  });

  it("stays silent when the runtime doesn't implement the probe at all", async () => {
    expect(
      await verifyDeployedContainers(runtimeStub({ sampleStability: undefined }), [target], logger()),
    ).toEqual([]);
  });

  it("produces NO finding when the host became unreachable mid-watch", async () => {
    const runtime = runtimeStub({
      sampleStability: async () => {
        throw new Error("Channel open failure");
      },
    });
    // A dropped SSH channel is a gap in our knowledge, not a failed service:
    // reporting it as unstable would fail a deploy whose containers are fine.
    expect(
      await verifyDeployedContainers(runtime, [target], logger(), FAST),
    ).toEqual([]);
  });

  it("does nothing when there is nothing to watch", async () => {
    const probe = vi.fn();
    expect(await verifyDeployedContainers(runtimeStub({ sampleStability: probe }), [], logger())).toEqual(
      [],
    );
    expect(probe).not.toHaveBeenCalled();
  });

  it("judges each container on its own, so one bad service can't condemn the rest", async () => {
    const crashing = series(
      sample({ restartCount: 0 }),
      sample({ restartCount: 3, exitCode: 1, state: "restarting" }),
    );
    const runtime = runtimeStub({
      sampleStability: async (id) => (id === "c1" ? crashing() : sample()),
      getRuntimeLogs: async () => [{ message: "boom" }],
    });

    const findings = await verifyDeployedContainers(
      runtime,
      [target, { serviceId: "svc_2", serviceName: "db", containerId: "c2" }],
      logger(),
      FAST,
    );

    expect(findings.filter((f) => !f.verdict.ok).map((f) => f.target.serviceName)).toEqual(["api"]);
    expect(findings.find((f) => f.target.serviceName === "db")?.verdict.ok).toBe(true);
  });
});
