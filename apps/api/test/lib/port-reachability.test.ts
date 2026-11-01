import { describe, expect, it, vi } from "vitest";
import type { PortScanResult } from "@repo/adapters";

import { confirmPortScanReachability } from "@repo/platform/engine/lib/port-reachability";

const SCAN: PortScanResult = {
  scanned: true,
  source: "ss",
  totalCount: 2,
  exposedCount: 1,
  listeners: [
    {
      proto: "tcp",
      family: "ipv4",
      address: "0.0.0.0",
      port: 443,
      exposed: true,
      pid: 1,
      process: "nginx",
      service: "HTTPS",
    },
    {
      proto: "tcp",
      family: "ipv4",
      address: "127.0.0.1",
      port: 5432,
      exposed: false,
      pid: 2,
      process: "postgres",
      service: "PostgreSQL",
    },
  ],
};

describe("shared off-box port reachability", () => {
  it("enriches only exposed TCP listeners and preserves the Security scan contract", async () => {
    const probe = vi.fn(async () => ({ ok: true as const }));

    const result = await confirmPortScanReachability(SCAN, "203.0.113.10", { probe });

    expect(probe).toHaveBeenCalledWith("203.0.113.10", 443, 1_500);
    expect(result).toMatchObject({ reachabilityProbed: true, reachableCount: 1 });
    expect(result.listeners.find((listener) => listener.port === 443)?.reachable).toBe(true);
    expect(result.listeners.find((listener) => listener.port === 5432)?.reachable).toBeUndefined();
  });

  it("does not call localhost an off-box vantage point", async () => {
    const probe = vi.fn();

    const result = await confirmPortScanReachability(SCAN, "localhost", { probe });

    expect(result.reachabilityProbed).toBe(false);
    expect(probe).not.toHaveBeenCalled();
  });
});
