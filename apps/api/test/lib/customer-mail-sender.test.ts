import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  send: vi.fn(),
  cloud: true,
  relay: vi.fn(),
  supportFrom: undefined as string | undefined,
  billingFrom: undefined as string | undefined,
}));
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
    get SMTP_SUPPORT_FROM() {
      return h.supportFrom;
    },
    get SMTP_BILLING_FROM() {
      return h.billingFrom;
    },
  },
}));
vi.mock("@repo/platform/engine/lib/cloud/client", () => ({ cloudClient: h.relay }));
vi.mock("@repo/platform/engine/lib/encryption", () => ({ decrypt: vi.fn() }));
import { sendMail } from "@repo/platform/engine/lib/mail";

beforeEach(() => {
  h.cloud = true;
  h.supportFrom = undefined;
  h.billingFrom = undefined;
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
  it("uses the configured sender for welcome mail and keeps replies directed to Support", async () => {
    await sendMail({
      ...mail,
      customerSender: "support",
      replyTo: "support@openship.io",
      messageId: "<stable@openship.io>",
    });
    expect(h.send).toHaveBeenCalledExactlyOnceWith({
      ...mail,
      from: "Configured Sender <sender@example.test>",
      replyTo: "support@openship.io",
      messageId: "<stable@openship.io>",
    });
  });
  it("uses the configured sender for invoices without changing ordinary system mail", async () => {
    await sendMail({ ...mail, customerSender: "billing" });
    expect(h.send).toHaveBeenLastCalledWith({
      ...mail,
      from: "Configured Sender <sender@example.test>",
    });
    await sendMail(mail);
    expect(h.send).toHaveBeenLastCalledWith({
      ...mail,
      from: "Configured Sender <sender@example.test>",
    });
  });
  it("uses explicitly configured customer aliases without changing system mail", async () => {
    h.supportFrom = "OpenShip Support <support@example.test>";
    h.billingFrom = "OpenShip Billing <billing@example.test>";
    for (const [customerSender, from] of [
      ["support", h.supportFrom],
      ["billing", h.billingFrom],
    ] as const) {
      await sendMail({ ...mail, customerSender });
      expect(h.send).toHaveBeenLastCalledWith({ ...mail, from });
    }
    await sendMail(mail);
    expect(h.send).toHaveBeenLastCalledWith({
      ...mail,
      from: "Configured Sender <sender@example.test>",
    });
  });
  it("treats blank customer aliases as unconfigured", async () => {
    h.supportFrom = " ";
    h.billingFrom = "";
    for (const customerSender of ["support", "billing"] as const) {
      await sendMail({ ...mail, customerSender });
      expect(h.send).toHaveBeenLastCalledWith({
        ...mail,
        from: "Configured Sender <sender@example.test>",
      });
    }
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
