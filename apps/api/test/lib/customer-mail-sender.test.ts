import { afterEach, beforeEach, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  smtp: vi.fn(),
  relay: vi.fn(),
  target: "local",
  env: {
    CLOUD_MODE: true,
    OBLIEN_CLIENT_ID: "fixture-owner",
    OBLIEN_CLIENT_SECRET: "fixture-secret",
    OBLIEN_API_URL: "https://mail.example.test/v2",
    SMTP_HOST: "smtp.example.test",
    SMTP_PORT: 587,
    SMTP_USER: "sender",
    SMTP_PASS: "test-password",
    SMTP_FROM: "Local Sender <sender@example.test>",
  },
}));
vi.mock("@repo/core", async (original) => ({
  ...(await original<typeof import("@repo/core")>()),
  get runtimeTargetId() {
    return h.target;
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
  h.target = "local";
  h.env.CLOUD_MODE = true;
  h.env.OBLIEN_CLIENT_SECRET = "fixture-secret";
  h.smtp.mockReset();
  h.relay.mockReset();
});
afterEach(() => vi.restoreAllMocks());

it("keeps a failed Cloud submission on the API path even with working SMTP configured", async () => {
  const submit = vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("lost response"));
  const { sendMail } = await import("@repo/platform/engine/lib/mail");
  await expect(sendMail({ ...message, cloudOnly: true })).rejects.toThrow();
  expect(submit).toHaveBeenCalledOnce();
  const [url, options] = submit.mock.calls[0]!;
  expect(String(url)).toBe("https://mail.example.test/v2/mail/openship/messages");
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

it("keeps the production Cloud target off SMTP and the relay when Cloud mode is misconfigured", async () => {
  h.target = "cloud-saas";
  h.env.CLOUD_MODE = false;
  const submit = vi.spyOn(globalThis, "fetch");
  const { canSendMail, sendMail } = await import("@repo/platform/engine/lib/mail");
  expect(await canSendMail()).toBe(false);
  expect(await sendMail(message)).toBe(false);
  expect(await sendMail({ ...message, preferSource: "cloud", organizationId: "org" })).toBe(false);
  expect(submit).not.toHaveBeenCalled();
  expect(h.smtp).not.toHaveBeenCalled();
  expect(h.relay).not.toHaveBeenCalled();
});

it("uses local SMTP on self-hosted and rejects Cloud-only outbox messages", async () => {
  h.env.CLOUD_MODE = false;
  const { sendMail } = await import("@repo/platform/engine/lib/mail");
  expect(await sendMail(message)).toBe(true);
  expect(h.smtp).toHaveBeenCalledExactlyOnceWith({ ...message, from: h.env.SMTP_FROM });
  await expect(
    sendMail({
      ...message,
      cloudOnly: true,
      preferSource: "cloud",
      organizationId: "org",
    }),
  ).rejects.toThrow("Cloud-only");
  expect(h.relay).not.toHaveBeenCalled();
});
