import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createTransport: vi.fn(),
  ensurePlatformMailbox: vi.fn(),
  listMailServers: vi.fn(),
  getInstanceSettings: vi.fn(),
  firstSend: vi.fn(),
  repairedSend: vi.fn(),
}));

vi.mock("nodemailer", () => ({
  default: { createTransport: mocks.createTransport },
}));

vi.mock("@repo/db", () => ({
  repos: {
    mailServer: { list: mocks.listMailServers },
    instanceSettings: { get: mocks.getInstanceSettings },
  },
}));

vi.mock("@repo/platform/engine/config/env", () => ({
  env: {
    CLOUD_MODE: false,
    SMTP_HOST: undefined,
    SMTP_USER: undefined,
    SMTP_PASS: undefined,
    SMTP_FROM: undefined,
  },
}));

vi.mock("@repo/platform/engine/lib/cloud/client", () => ({
  cloudClient: vi.fn(),
}));

vi.mock("@repo/platform/engine/lib/encryption", () => ({
  decrypt: vi.fn(),
}));

vi.mock("@repo/platform/engine/modules/mail/admin/platform-mailbox.service", () => ({
  ensureOpenshipPlatformMailbox: mocks.ensurePlatformMailbox,
}));

describe("platform transport self-repair", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.OPENSHIP_HOST_SSH_HOST;
    mocks.listMailServers.mockResolvedValue([
      { serverId: "srv_mail", installedAt: new Date("2026-08-01") },
    ]);
    mocks.getInstanceSettings.mockResolvedValue(null);
    mocks.ensurePlatformMailbox
      .mockResolvedValueOnce({
        email: "openship@example.com",
        password: "stale-password",
        smtpHost: "mail.example.com",
        smtpPort: 465,
        secure: true,
        from: "Openship <openship@example.com>",
      })
      .mockResolvedValueOnce({
        email: "openship@example.com",
        password: "repaired-password",
        smtpHost: "mail.example.com",
        smtpPort: 465,
        secure: true,
        from: "Openship <openship@example.com>",
      });
    mocks.firstSend.mockRejectedValue(
      Object.assign(new Error("535 Authentication credentials invalid"), {
        code: "EAUTH",
        responseCode: 535,
      }),
    );
    mocks.repairedSend.mockResolvedValue({ messageId: "accepted" });
    mocks.createTransport
      .mockReturnValueOnce({ sendMail: mocks.firstSend })
      .mockReturnValueOnce({ sendMail: mocks.repairedSend });
  });

  it("rotates once and retries when a cached platform credential gets EAUTH", async () => {
    const { sendMail } = await import("@repo/platform/engine/lib/mail");

    await expect(
      sendMail({
        to: "owner@example.net",
        subject: "Alert",
        html: "<p>Alert</p>",
        preferSource: "platform",
      }),
    ).resolves.toBe(true);

    expect(mocks.ensurePlatformMailbox).toHaveBeenNthCalledWith(1, "srv_mail", {
      rotate: false,
    });
    expect(mocks.ensurePlatformMailbox).toHaveBeenNthCalledWith(2, "srv_mail", {
      rotate: true,
    });
    expect(mocks.firstSend).toHaveBeenCalledOnce();
    expect(mocks.repairedSend).toHaveBeenCalledOnce();
  });
});
