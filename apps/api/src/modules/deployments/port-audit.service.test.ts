import { describe, expect, it, vi } from "vitest";
import { auditPorts } from "@repo/platform/engine/modules/deployments/port-audit.service";
import type { BuildLogger, RuntimeAdapter } from "@repo/adapters";

// /proc/net/tcp row: LISTEN (0A) on 127.0.0.1:3000 only.
const LOOPBACK_ONLY_3000 =
  "   0: 0100007F:0BB8 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 12345 1 0000000000000000 100 0 0 10 0";

function runtimeListening(name: string, procNetTcp: string): RuntimeAdapter {
  return {
    name,
    inContainerExecutor: async () => ({
      exec: async (command: string) => (command.startsWith("cat /proc/net/tcp ") ? procNetTcp : ""),
    }),
  } as unknown as RuntimeAdapter;
}

describe("auditPorts with a loopback-only listener", () => {
  it("warns on Docker that the edge can't reach the port", async () => {
    const logger = { log: vi.fn() } as unknown as BuildLogger;

    const results = await auditPorts(
      runtimeListening("docker", LOOPBACK_ONLY_3000),
      "ctr_1",
      [3000],
      logger,
    );

    // Still a listener, so the dashboard's "nothing is listening" advisory stays quiet.
    expect(results).toEqual([{ port: 3000, listening: true, checked: true }]);
    expect(logger.log).toHaveBeenCalledWith(
      expect.stringContaining("only listening on loopback"),
      "warn",
    );
    expect(logger.log).not.toHaveBeenCalledWith("Port check: port 3000 is listening.\n", "info");
  });

  it("keeps the listening line on the bare runtime, where the edge dials the host's loopback", async () => {
    const logger = { log: vi.fn() } as unknown as BuildLogger;

    await auditPorts(runtimeListening("bare", LOOPBACK_ONLY_3000), "proc_1", [3000], logger);

    expect(logger.log).toHaveBeenCalledWith("Port check: port 3000 is listening.\n", "info");
  });
});
