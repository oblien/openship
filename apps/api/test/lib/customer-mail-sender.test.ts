import { afterEach, beforeEach, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  smtp: vi.fn(),
  relay: vi.fn(),
  env: {
    CLOUD_MODE: true,
    OBLIEN_CLIENT_ID: "fixture-owner",
    OBLIEN_CLIENT_SECRET: "fixture-secret",
    OBLIEN_API_URL: "https://mail.example.test/v2",
    OBLIEN_MAIL_NAMESPACE: "openship-staging",
    SMTP_HOST: "smtp.example.test",
    SMTP_PORT: 587,
    SMTP_USER: "sender",
    SMTP_PASS: "test-password",
    SMTP_FROM: "Local Sender <sender@example.test>",
  },
}));
vi.mock("nodemailer", () => ({ default: { createTransport: () => ({ sendMail: h.smtp }) } }));
vi.mock("@repo/db", () => ({
  repos: { mailServer: { list: async () => [] }, instanceSettings: { get: async () => null } },
}));
vi.mock("@repo/platform/engine/config/env", () => ({ env: h.env }));
vi.mock("@repo/platform/engine/lib/cloud/client", () => ({ cloudClient: h.relay }));
vi.mock("@repo/platform/engine/lib/encryption", () => ({ decrypt: vi.fn() }));

const message = { to: "customer@example.test", subject: "Welcome", html: "<p>Welcome</p>" };

beforeEach(() => {
  vi.resetModules();
  h.env.CLOUD_MODE = true;
  h.env.OBLIEN_CLIENT_SECRET = "fixture-secret";
  h.smtp.mockReset();
  h.relay.mockReset();
});
afterEach(() => vi.restoreAllMocks());

it("keeps a failed Cloud submission on the API path even with working SMTP configured", async () => {
  const submit = vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("lost response"));
  const { sendMail } = await import("@repo/platform/engine/lib/mail");
  await expect(sendMail({ ...message, customerSender: "billing" })).rejects.toThrow();
  expect(submit).toHaveBeenCalledOnce();
  const [url, options] = submit.mock.calls[0]!;
  expect(String(url)).toBe("https://mail.example.test/v2/mail/openship-staging/messages");
  expect(JSON.parse(String(options?.body)).from).toBe("noreply@openship.io");
  expect(h.smtp).not.toHaveBeenCalled();
});

it("reports Cloud mail unavailable when owner credentials are missing even with SMTP configured", async () => {
  h.env.OBLIEN_CLIENT_SECRET = "";
  const { canSendMail, sendMail } = await import("@repo/platform/engine/lib/mail");
  expect(await canSendMail()).toBe(false);
  expect(await sendMail(message)).toBe(false);
  expect(h.smtp).not.toHaveBeenCalled();
});

it("uses local SMTP on self-hosted and rejects Cloud-only outbox messages", async () => {
  h.env.CLOUD_MODE = false;
  const { sendMail } = await import("@repo/platform/engine/lib/mail");
  expect(await sendMail(message)).toBe(true);
  expect(h.smtp).toHaveBeenCalledExactlyOnceWith({ ...message, from: h.env.SMTP_FROM });
  await expect(
    sendMail({
      ...message,
      customerSender: "support",
      preferSource: "cloud",
      organizationId: "org",
    }),
  ).rejects.toThrow("Cloud-only");
  expect(h.relay).not.toHaveBeenCalled();
});
