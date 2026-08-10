import "./_setup-env";
import { beforeEach, describe, expect, test, vi } from "vitest";

/**
 * Mail's cert step must issue through the SAME `platform.ssl` as every other
 * certificate in the system, and must never shell out to a host `certbot`.
 *
 * It used to run `certbot certonly --standalone` itself, with a comment claiming it
 * was "the same ACME mechanism the rest of openship uses" — it imitated
 * `NginxProvider.provisionCert` rather than calling it. Two things were wrong:
 * the duplicate could drift, and it ran on the HOST, which broke outright once the
 * edge became a container (certbot lives inside the image; the host has none, and
 * `installCertbot` correctly declined to add a second one).
 */
const mocks = vi.hoisted(() => ({
  provisionCert: vi.fn(async () => ({
    domain: "mail.example.com",
    expiresAt: "2030-01-01T00:00:00.000Z",
    issuer: "R11",
    verified: true,
    reason: "issued" as const,
  })),
  resolveTargetPlatform: vi.fn(),
}));

vi.mock("../../../src/lib/deployment-runtime", () => ({
  resolveTargetPlatform: mocks.resolveTargetPlatform,
}));

import { stepRequestSSL } from "../../../src/modules/mail/mail.service";

function fakeExecutor() {
  const commands: string[] = [];
  return {
    commands,
    executor: { exec: async (c: string) => { commands.push(c); return ""; } } as never,
  };
}

const TARGET = { serverId: "srv_1", organizationId: "org_1" };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolveTargetPlatform.mockResolvedValue({ ssl: { provisionCert: mocks.provisionCert } } as never);
});

describe("step 12 — issuance goes through platform.ssl", () => {
  test("delegates to provisionCert for mail.<domain> and never execs certbot", async () => {
    const { executor, commands } = fakeExecutor();

    const result = await stepRequestSSL(executor, "example.com", () => {}, TARGET);

    expect(result.success).toBe(true);
    expect(mocks.provisionCert).toHaveBeenCalledWith("mail.example.com", expect.anything());
    // The whole point: no host certbot invocation, on any box.
    expect(commands.some((c) => c.includes("certbot"))).toBe(false);
  });

  test("resolves the platform for the server the wizard is driving", async () => {
    const { executor } = fakeExecutor();

    await stepRequestSSL(executor, "example.com", () => {}, TARGET);

    // Org-scoped: resolveTargetPlatform verifies serverId ∈ org.
    expect(mocks.resolveTargetPlatform).toHaveBeenCalledWith("server", "bare", "srv_1", "org_1");
  });

  test("surfaces the summarized certbot cause when issuance throws", async () => {
    mocks.provisionCert.mockRejectedValueOnce(
      new Error("Port 80 for mail.example.com isn't reachable from the internet — a firewall…"),
    );
    const { executor } = fakeExecutor();

    const result = await stepRequestSSL(executor, "example.com", () => {}, TARGET);

    expect(result.success).toBe(false);
    expect(result.message).toContain("isn't reachable from the internet");
  });

  test("an unverified result fails the step rather than reporting a cert", async () => {
    // provisionCert can return {verified:false} without throwing (reason "missing" /
    // "read_error"); step 13 would then symlink a cert that isn't there.
    mocks.provisionCert.mockResolvedValueOnce({
      domain: "mail.example.com",
      expiresAt: "",
      issuer: "certbot",
      verified: false,
      reason: "missing",
    } as never);
    const { executor } = fakeExecutor();

    const result = await stepRequestSSL(executor, "example.com", () => {}, TARGET);

    expect(result.success).toBe(false);
    expect(result.message).toContain("missing");
  });

  // Carried over from the deleted mail-ssl-acme.test.ts. `provisionCert` shell-quotes
  // its argv, so this is defence in depth rather than the only gate — but the guard is
  // cheap and the value is operator input that reaches a root shell on a managed box.
  test("refuses a domain that isn't shell-safe before it reaches the provider", async () => {
    const { executor, commands } = fakeExecutor();

    const result = await stepRequestSSL(executor, "evil;rm -rf /", () => {}, TARGET);

    expect(result.success).toBe(false);
    expect(mocks.resolveTargetPlatform).not.toHaveBeenCalled();
    expect(commands).toHaveLength(0);
  });
});
