import { describe, expect, it, vi, beforeEach } from "vitest";
import { Duplex } from "node:stream";

const withHostExecutor = vi.fn();
vi.mock("../../../src/lib/ssh-manager", () => ({
  sshManager: { withHostExecutor: (fn: unknown) => withHostExecutor(fn) },
}));

import { probeDeployedReadiness } from "../../../src/modules/deployments/readiness-probe";
import type { CommandExecutor, RuntimeAdapter } from "@repo/adapters";

/**
 * The two decisions this module owns, and why each has a test:
 *
 *   WHICH ADDRESS — a published candidate is reachable at `127.0.0.1:<hostPort>`, not at
 *   the app's own container port, and the message has to name the one actually dialed.
 *
 *   WHICH MACHINE DIALS — `127.0.0.1` only means the deployment from the DEPLOY TARGET.
 *   A remote-server deploy that dialed the orchestrator's loopback could false-negative
 *   (healthy deploy destroyed) or false-POSITIVE (an unrelated local service answers).
 *   GH-583 was the containerized-local case of the same mistake.
 *
 * Plus the invariant that keeps a broken probe from breaking deploys: a probe that could
 * not RUN reports `skipped`, never `failure`.
 */

function response(status: number): Duplex {
  let sent = false;
  return new Duplex({
    read() {
      if (sent) return;
      sent = true;
      this.push(`HTTP/1.1 ${status} Test\r\nContent-Length: 0\r\n\r\n`);
      this.push(null);
    },
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
}

/** A runtime whose container publishes `hostPort`. */
function runtimeWith(hostPort: number | undefined): RuntimeAdapter {
  return {
    name: "docker",
    getContainerInfo: async () => (hostPort === undefined ? null : { status: "running", hostPort }),
    supports: () => false,
  } as unknown as RuntimeAdapter;
}

function executorWith(forward: () => Promise<Duplex>): CommandExecutor {
  return { forwardPort: forward, exec: async () => "" } as unknown as CommandExecutor;
}

const PROBE = {
  enabled: true,
  path: "/ready",
  port: undefined,
  timeoutMs: 60,
  intervalMs: 1,
} as const;

beforeEach(() => {
  withHostExecutor.mockReset();
});

describe("probeDeployedReadiness", () => {
  it("dials the PUBLISHED host port and names it in the log, not the app's own port", async () => {
    const lines: string[] = [];
    const verdict = await probeDeployedReadiness({
      runtime: runtimeWith(20_000),
      containerId: "c1",
      primaryPort: 8080,
      probe: { ...PROBE },
      targetExecutor: executorWith(async () => response(200)),
      log: (message) => lines.push(message),
    });

    expect(verdict.failure).toBeNull();
    expect(lines.join("")).toContain("127.0.0.1:20000/ready");
    expect(lines.join("")).not.toContain(":8080/ready");
  });

  // THE remote-deploy fix. The deploy's own executor is the only machine for which
  // `127.0.0.1:<hostPort>` means the deployment.
  it("probes through the DEPLOY TARGET's executor, never the local host channel", async () => {
    const forward = vi.fn(async () => response(204));
    const verdict = await probeDeployedReadiness({
      runtime: runtimeWith(20_000),
      containerId: "c1",
      primaryPort: 8080,
      probe: { ...PROBE },
      targetExecutor: executorWith(forward),
      log: () => {},
    });

    expect(verdict.failure).toBeNull();
    expect(forward).toHaveBeenCalledWith("127.0.0.1", 20_000);
    expect(withHostExecutor).not.toHaveBeenCalled();
  });

  // …and only when there is no target executor does it borrow this box's channel.
  it("falls back to the pooled host channel when the target has no executor", async () => {
    withHostExecutor.mockImplementation((fn: (e: CommandExecutor) => Promise<unknown>) =>
      fn(executorWith(async () => response(200))),
    );

    const verdict = await probeDeployedReadiness({
      runtime: runtimeWith(20_000),
      containerId: "c1",
      primaryPort: 8080,
      probe: { ...PROBE },
      targetExecutor: null,
      log: () => {},
    });

    expect(verdict.failure).toBeNull();
    expect(withHostExecutor).toHaveBeenCalledOnce();
  });

  it("reports a failure that names the address and the app's port for a wrong-port hint", async () => {
    const verdict = await probeDeployedReadiness({
      runtime: runtimeWith(20_000),
      containerId: "c1",
      primaryPort: 8080,
      probe: { ...PROBE },
      targetExecutor: executorWith(async () => {
        throw new Error("ECONNREFUSED");
      }),
      log: () => {},
      subject: '"api"',
    });

    expect(verdict.skipped).toBeUndefined();
    expect(verdict.failure).toContain('"api" never answered at 127.0.0.1:20000/ready');
    expect(verdict.failure).toContain("different port than 8080");
  });

  // GH-583: a channel that refuses forwarding and a host with no curl means we could not
  // ASK. That must warn, never fail — failing here destroys deployments that were fine.
  it("returns skipped, not failure, when no mechanism can answer", async () => {
    const prohibited = Object.assign(
      new Error("(SSH) Channel open failure: administratively prohibited: open failed"),
      { reason: 1 },
    );
    const verdict = await probeDeployedReadiness({
      runtime: runtimeWith(20_000),
      containerId: "c1",
      primaryPort: 8080,
      probe: { ...PROBE },
      targetExecutor: {
        forwardPort: async () => {
          throw prohibited;
        },
        exec: async () => "OPENSHIP_PROBE_NO_CLIENT",
      } as unknown as CommandExecutor,
      log: () => {},
    });

    expect(verdict.failure).toBeNull();
    expect(verdict.skipped).toContain("refuses port forwarding");
    expect(verdict.skipped).toContain("openship up");
  });

  it("treats an unreachable dialing machine as skipped rather than a dead app", async () => {
    withHostExecutor.mockRejectedValue(new Error("host channel is not provisioned"));

    const verdict = await probeDeployedReadiness({
      runtime: runtimeWith(20_000),
      containerId: "c1",
      primaryPort: 8080,
      probe: { ...PROBE },
      targetExecutor: null,
      log: () => {},
    });

    expect(verdict.failure).toBeNull();
    expect(verdict.skipped).toContain("not provisioned");
  });
});
