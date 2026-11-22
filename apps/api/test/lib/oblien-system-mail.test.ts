import { afterAll, afterEach, expect, it, vi } from "vitest";
import { closeDb } from "@repo/db";
import { auth } from "@repo/platform/engine/lib/auth";
import { canSendMail, sendMail } from "@repo/platform/engine/lib/mail";

vi.mock("@repo/platform/engine/config/env", async (original) => {
  const actual = await original<typeof import("@repo/platform/engine/config/env")>();
  return {
    ...actual,
    env: {
      ...actual.env,
      CLOUD_MODE: true,
      SMTP_HOST: undefined,
      SMTP_USER: undefined,
      SMTP_PASS: undefined,
      SMTP_FROM: "Openship <noreply@example.test>",
      SMTP_SUPPORT_FROM: "Support <help@example.test>",
      OBLIEN_API_URL: "https://mail.example.test/v2",
      OBLIEN_MAIL_NAMESPACE: "openship-system",
      OBLIEN_MAIL_KEY: "fixture-send-only-key",
    },
  };
});

afterEach(() => vi.restoreAllMocks());
afterAll(() => closeDb());

function provider() {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (url, options) => {
    expect(String(url)).toBe("https://mail.example.test/v2/mail/openship-system/messages");
    expect(options?.method).toBe("POST");
    const headers = new Headers(options?.headers);
    expect(headers.get("Authorization")).toBe("Bearer fixture-send-only-key");
    expect(headers.has("X-Client-Secret")).toBe(false);
    return Response.json(
      { success: true, data: { id: "receipt", state: "queued" } },
      { status: 202 },
    );
  });
}

function authRequest(path: string, body: object) {
  return auth.handler(
    new Request(`http://localhost:4000/api/auth${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "http://localhost:3001" },
      body: JSON.stringify(body),
    }),
  );
}

it("resets a Cloud password with the code submitted through the SDK without SMTP", async () => {
  const send = provider();
  const email = "recovery@example.test";
  expect(await canSendMail()).toBe(true);
  const signup = await authRequest("/sign-up/email", {
    email,
    name: "Recovery",
    password: "first-password-1234!",
  });
  expect(signup.status).toBe(200);
  const reset = await authRequest("/email-otp/request-password-reset", { email });
  expect(reset.status).toBe(200);
  expect(send).toHaveBeenCalledTimes(2);
  const [signupRequest, resetRequest] = send.mock.calls.map(([, options]) => options!);
  const key = new Headers(resetRequest!.headers).get("Idempotency-Key");
  expect(key).toBeTruthy();
  expect(key).not.toBe(new Headers(signupRequest!.headers).get("Idempotency-Key"));
  const mail = JSON.parse(String(resetRequest!.body));
  const code = mail.subject.match(/\b\d{6}\b/)?.[0];
  expect(code).toBeTruthy();
  expect(mail).toMatchObject({
    from: "noreply@example.test",
    to: [email],
    text: expect.stringContaining(code),
    html: expect.stringContaining(code),
  });
  const changed = await authRequest("/email-otp/reset-password", {
    email,
    otp: code,
    password: "replacement-password-1234!",
  });
  expect(changed.status).toBe(200);
}, 30_000);

it("keeps the outbox identity and payload on retry, including the sender alias and reply address", async () => {
  const send = provider().mockRejectedValueOnce(new TypeError("Connection closed"));
  const mail = {
    to: "customer@example.net",
    subject: "Welcome",
    html: "<p>Welcome</p>",
    customerSender: "support" as const,
    replyTo: "replies@example.test",
    messageId: "<customer-record@openship.io>",
    organizationId: "customer-org",
  };
  await expect(sendMail(mail)).rejects.toThrow();
  await expect(sendMail(mail)).resolves.toBe(true);
  const [first, retry] = send.mock.calls.map(([, options]) => options!);
  const key = new Headers(first!.headers).get("Idempotency-Key");
  expect(key).toBeTruthy();
  expect(new Headers(retry!.headers).get("Idempotency-Key")).toBe(key);
  expect(retry!.body).toBe(first!.body);
  expect(JSON.parse(String(retry!.body))).toEqual({
    from: "help@example.test",
    replyTo: [mail.replyTo],
    to: [mail.to],
    subject: mail.subject,
    html: mail.html,
  });
});

it.each(["unknown", "failed", "suppressed"])(
  "does not report a %s receipt as successful",
  async (state) => {
    provider().mockResolvedValueOnce(
      Response.json({ success: true, data: { id: "receipt", state } }),
    );
    await expect(
      sendMail({ to: "user@example.net", subject: "Verify", html: "<p>Code</p>" }),
    ).rejects.toThrow("Cloud email submission could not be confirmed");
  },
);
