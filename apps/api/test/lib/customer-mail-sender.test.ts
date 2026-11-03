import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ send: vi.fn(), cloud: true, relay: vi.fn() }));
vi.mock("nodemailer", () => ({ default: { createTransport: () => ({ sendMail: h.send }) } }));
vi.mock("@repo/db", () => ({
  repos: { mailServer: { list: async () => [] }, instanceSettings: { get: async () => null } },
}));
vi.mock("@repo/platform/engine/config/env", () => ({
  env: {
    get CLOUD_MODE() {
      return h.cloud;
    },
    SMTP_HOST: "smtp.example.test",
    SMTP_PORT: 587,
    SMTP_USER: "sender",
    SMTP_PASS: "test-password",
    SMTP_FROM: "Configured Sender <sender@example.test>",
  },
}));
vi.mock("@repo/platform/engine/lib/cloud/client", () => ({ cloudClient: h.relay }));
vi.mock("@repo/platform/engine/lib/encryption", () => ({ decrypt: vi.fn() }));
import { sendMail } from "@repo/platform/engine/lib/mail";

beforeEach(() => {
  h.cloud = true;
  h.send.mockReset().mockResolvedValue({ messageId: "accepted" });
  h.relay.mockReset();
});

describe("Cloud customer mail sender identities", () => {
  const mail = {
    to: "customer@example.net",
    subject: "Welcome",
    html: "<p>Welcome</p>",
    text: "Welcome",
  };
  it("sends welcome mail from Support with a working reply address", async () => {
    await sendMail({
      ...mail,
      customerSender: "support",
      replyTo: "support@openship.io",
      messageId: "<stable@openship.io>",
    });
    expect(h.send).toHaveBeenCalledExactlyOnceWith({
      ...mail,
      from: "OpenShip Support <support@openship.io>",
      replyTo: "support@openship.io",
      messageId: "<stable@openship.io>",
    });
  });
  it("sends invoices from no-reply without changing ordinary system mail", async () => {
    await sendMail({ ...mail, customerSender: "billing" });
    expect(h.send).toHaveBeenLastCalledWith({
      ...mail,
      from: "OpenShip Billing <noreply@openship.io>",
    });
    await sendMail(mail);
    expect(h.send).toHaveBeenLastCalledWith({
      ...mail,
      from: "Configured Sender <sender@example.test>",
    });
  });
  it("never lets a connected installation select a Cloud customer sender", async () => {
    h.cloud = false;
    await expect(
      sendMail({
        ...mail,
        customerSender: "support",
        preferSource: "cloud",
        organizationId: "org",
      }),
    ).rejects.toThrow("Cloud-only");
    expect(h.send).not.toHaveBeenCalled();
    expect(h.relay).not.toHaveBeenCalled();
  });
});
