import "./_setup-env";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HostListener, PortScanResult } from "@repo/adapters";

import {
  checkMailPortReachability,
  clearMailPortReachabilityCache,
  mailReachabilityFailureMessage,
} from "../../../src/modules/mail/mail-port-reachability.service";

const executor = {} as never;

function listener(port: number, exposed = true): HostListener {
  return {
    proto: "tcp",
    family: "ipv4",
    address: exposed ? "0.0.0.0" : "127.0.0.1",
    port,
    exposed,
    pid: 1,
    process: "master",
    service: null,
  };
}

function scan(listeners: HostListener[], scanned = true): PortScanResult {
  return {
    listeners,
    totalCount: listeners.length,
    exposedCount: listeners.filter((row) => row.exposed).length,
    source: "ss",
    scanned,
  };
}

const allListeners = [25, 465, 587, 993].map((port) => listener(port));

beforeEach(() => {
  clearMailPortReachabilityCache();
});

describe("mail public-port reachability", () => {
  it("requires both a public listener and an off-box TCP handshake", async () => {
    const probe = vi.fn(async (_host: string, ports: readonly number[]) =>
      ports.map((port) => ({ port, result: { ok: true as const } })),
    );

    const result = await checkMailPortReachability(executor, "mail.example.com", {
      dependencies: {
        scan: vi.fn(async () => scan(allListeners)),
        resolvePublicAddress: vi.fn(async () => "203.0.113.10"),
        probe,
      },
    });

    expect(result.status).toBe("ok");
    expect(result.ports).toHaveLength(4);
    expect(result.ports.every((port) => port.status === "reachable")).toBe(true);
    expect(probe).toHaveBeenCalledWith("203.0.113.10", [25, 465, 587, 993], {
      timeoutMs: 1_500,
      concurrency: 4,
      maxPorts: 4,
    });
  });

  it("diagnoses a dropped public connection as upstream blocking, not a stopped daemon", async () => {
    const result = await checkMailPortReachability(executor, "mail.example.com", {
      dependencies: {
        scan: vi.fn(async () => scan(allListeners)),
        resolvePublicAddress: vi.fn(async () => "203.0.113.10"),
        probe: vi.fn(async (_host, ports) =>
          ports.map((port) => ({
            port,
            result:
              port === 465
                ? { ok: false as const, reason: "timeout" as const, message: "no response" }
                : { ok: true as const },
          })),
        ),
      },
    });

    expect(result.status).toBe("fail");
    expect(result.ports.find((port) => port.port === 465)).toMatchObject({
      status: "blocked",
      listening: true,
      exposed: true,
      reachable: false,
      failure: "timeout",
    });
    expect(mailReachabilityFailureMessage(result)).toMatch(/provider firewall|security group/i);
  });

  it("does not fail overall when only inbound TCP 25 times out from the control plane", async () => {
    const result = await checkMailPortReachability(executor, "mail.example.com", {
      dependencies: {
        scan: vi.fn(async () => scan(allListeners)),
        resolvePublicAddress: vi.fn(async () => "203.0.113.10"),
        probe: vi.fn(async (_host, ports) =>
          ports.map((port) => ({
            port,
            result:
              port === 25
                ? {
                    ok: false as const,
                    reason: "timeout" as const,
                    message: "no response within 1500ms",
                  }
                : { ok: true as const },
          })),
        ),
      },
    });

    expect(result.status).toBe("ok");
    expect(result.ports.find((port) => port.port === 25)).toMatchObject({
      status: "blocked",
      listening: true,
      exposed: true,
      reachable: false,
      failure: "timeout",
    });
    expect(
      result.ports.filter((port) => port.port !== 25).every((port) => port.status === "reachable"),
    ).toBe(true);
    expect(result.detail).toMatch(/control plane|Amazon SES|Sending tab/i);
  });

  it("still fails when inbound TCP 25 is not listening on the host", async () => {
    const result = await checkMailPortReachability(executor, "mail.example.com", {
      dependencies: {
        scan: vi.fn(async () => scan(allListeners.filter((row) => row.port !== 25))),
        resolvePublicAddress: vi.fn(async () => "203.0.113.10"),
        probe: vi.fn(async (_host, ports) =>
          ports.map((port) => ({ port, result: { ok: true as const } })),
        ),
      },
    });

    expect(result.status).toBe("fail");
    expect(result.ports.find((port) => port.port === 25)?.status).toBe("not_listening");
  });

  it("does not waste an external probe on a port with no listener", async () => {
    const probe = vi.fn(async (_host: string, ports: readonly number[]) =>
      ports.map((port) => ({ port, result: { ok: true as const } })),
    );
    const result = await checkMailPortReachability(executor, "mail.example.com", {
      dependencies: {
        scan: vi.fn(async () => scan(allListeners.filter((row) => row.port !== 993))),
        resolvePublicAddress: vi.fn(async () => "203.0.113.10"),
        probe,
      },
    });

    expect(result.ports.find((port) => port.port === 993)?.status).toBe("not_listening");
    expect(probe.mock.calls[0]?.[1]).not.toContain(993);
    expect(mailReachabilityFailureMessage(result, [993])).toMatch(/Local mail listener problem/i);
    expect(mailReachabilityFailureMessage(result, [993])).not.toMatch(/provider firewall/i);
  });

  it("coalesces the 10-second health poll into one network sweep per minute", async () => {
    const scanHost = vi.fn(async () => scan(allListeners));
    const dependencies = {
      scan: scanHost,
      resolvePublicAddress: vi.fn(async () => "203.0.113.10"),
      probe: vi.fn(async (_host: string, ports: readonly number[]) =>
        ports.map((port) => ({ port, result: { ok: true as const } })),
      ),
    };

    const [first, second] = await Promise.all([
      checkMailPortReachability(executor, "mail.example.com", {
        cacheKey: "server-1",
        dependencies,
      }),
      checkMailPortReachability(executor, "mail.example.com", {
        cacheKey: "server-1",
        dependencies,
      }),
    ]);

    expect(first).toBe(second);
    expect(scanHost).toHaveBeenCalledTimes(1);
    expect(dependencies.probe).toHaveBeenCalledTimes(1);
  });

  it("keeps an unavailable public-DNS probe unknown rather than inventing a firewall outage", async () => {
    const result = await checkMailPortReachability(executor, "mail.example.com", {
      dependencies: {
        scan: vi.fn(async () => scan(allListeners)),
        resolvePublicAddress: vi.fn(async () => {
          throw new Error("Public DNS has no A or AAAA address");
        }),
        probe: vi.fn(),
      },
    });

    expect(result.status).toBe("unknown");
    expect(result.ports.every((port) => port.status === "unknown")).toBe(true);
    expect(result.detail).toMatch(/Public DNS/i);
  });
});
