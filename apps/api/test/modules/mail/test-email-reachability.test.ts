import "./_setup-env";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  close: vi.fn(),
  createTransport: vi.fn(),
  verify: vi.fn(),
  checkReachability: vi.fn(),
}));

vi.mock("nodemailer", () => ({
  default: { createTransport: h.createTransport },
}));

vi.mock("@repo/platform/engine/lib/ssh-manager", () => ({
  sshManager: {
    withExecutor: async (_serverId: string, run: (executor: unknown) => unknown) => run({}),
  },
}));

vi.mock("@repo/platform/engine/modules/mail/mail-state", () => ({
  readState: vi.fn(async () => ({ domain: "example.com" })),
}));

vi.mock("@repo/platform/engine/modules/mail/admin/platform-mailbox.service", () => ({
  ensureOpenshipPlatformMailbox: vi.fn(async () => ({
    email: "openship@example.com",
    password: "secret",
    smtpHost: "mail.example.com",
    smtpPort: 465,
    secure: true,
  })),
}));

vi.mock("../../../src/modules/mail/admin/test-mailbox.service", () => ({
  ensureOpenshipTestMailbox: vi.fn(),
}));

vi.mock("@repo/platform/engine/modules/mail/mail-port-reachability.service", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolvePublicMailAddress: vi.fn(async () => "203.0.113.10"),
  checkMailPortReachability: h.checkReachability,
}));

import { sendTestEmail } from "../../../src/modules/mail/admin/test-email.service";

beforeEach(() => {
  vi.clearAllMocks();
  h.createTransport.mockReturnValue({
    verify: h.verify,
    sendMail: vi.fn(),
    close: h.close,
  });
  h.checkReachability.mockResolvedValue({
    hostname: "mail.example.com",
    address: "203.0.113.10",
    checkedAt: 0,
    status: "fail",
    ports: [
      {
        key: "smtps",
        port: 465,
        label: "SMTP submission (TLS)",
        status: "blocked",
        listening: true,
        exposed: true,
        reachable: false,
        failure: "timeout",
      },
    ],
  });
});

describe("test email timeout diagnosis (GH-755)", () => {
  it("names the provider firewall when Postfix listens but public port 465 is dropped", async () => {
    h.verify.mockRejectedValue(
      Object.assign(new Error("Connection timeout"), { code: "ETIMEDOUT" }),
    );

    await expect(sendTestEmail("server-1", { to: "owner@example.net" })).rejects.toThrow(
      /provider firewall|security group/i,
    );

    expect(h.checkReachability).toHaveBeenCalledWith(
      {},
      "mail.example.com",
      expect.objectContaining({ force: true, cacheKey: "mail-health:server-1" }),
    );
    expect(h.close).toHaveBeenCalledTimes(1);
  });
});
