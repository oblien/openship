import { afterAll, afterEach, expect, it, vi } from "vitest";
import { closeDb, repos } from "@repo/db";
import { deliverOrganizationInvitation } from "@repo/platform/engine/lib/organization-lifecycle";
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
      SMTP_FROM: "Ignored SMTP sender <local@example.test>",
      OBLIEN_API_URL: "https://mail.example.test/v2",
      OBLIEN_CLIENT_ID: "fixture-owner",
      OBLIEN_CLIENT_SECRET: "fixture-secret",
    },
  };
});

afterEach(() => vi.restoreAllMocks());
afterAll(() => closeDb());

function provider() {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (url, options) => {
    expect(String(url)).toBe("https://mail.example.test/v2/mail/openship/messages");
    expect(options?.method).toBe("POST");
    const headers = new Headers(options?.headers);
    expect(headers.get("X-Client-ID")).toBe("fixture-owner");
    expect(headers.get("X-Client-Secret")).toBe("fixture-secret");
    expect(headers.has("Authorization")).toBe(false);
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
    from: "noreply@openship.io",
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

it("keeps reset responses private when the SDK rejects a password reset", async () => {
  const send = provider();
  const email = "outage@example.test";
  const signup = await authRequest("/sign-up/email", {
    email,
    name: "Outage",
    password: "first-password-1234!",
  });
  expect(signup.status).toBe(200);
  send.mockResolvedValueOnce(
    Response.json({ success: false, error: "provider unavailable" }, { status: 503 }),
  );
  const reset = await authRequest("/email-otp/request-password-reset", { email });
  const unknown = await authRequest("/email-otp/request-password-reset", {
    email: "unknown@example.test",
  });
  expect(reset.status).toBe(200);
  expect(unknown.status).toBe(reset.status);
  expect(await reset.json()).toEqual(await unknown.json());
  expect(send).toHaveBeenCalledTimes(2);
}, 30_000);

it("delivers a Cloud invitation through Oblien without loading instance SMTP settings", async () => {
  const send = provider();
  const settings = vi.spyOn(repos.instanceSettings, "get");
  const createdAt = new Date();
  const organization = { id: "org", name: "Team", slug: "team", createdAt };
  const user = {
    id: "owner",
    name: "Owner",
    email: "owner@example.test",
    emailVerified: true,
    createdAt,
    updatedAt: createdAt,
  };
  const email = "invitee@example.test";
  const id = "invitation";
  const role = "member";
  await deliverOrganizationInvitation({
    id,
    email,
    role,
    organization,
    inviter: {
      id: "membership",
      organizationId: organization.id,
      userId: user.id,
      role: "owner",
      createdAt,
      user,
    },
    invitation: {
      id,
      email,
      role,
      organizationId: organization.id,
      inviterId: user.id,
      createdAt,
      expiresAt: new Date(Date.now() + 3600_000),
      status: "pending",
    },
  });
  expect(settings).not.toHaveBeenCalled();
  expect(send).toHaveBeenCalledOnce();
  expect(JSON.parse(String(send.mock.calls[0]![1]?.body))).toMatchObject({
    from: "noreply@openship.io",
    to: [email],
    text: expect.stringContaining(id),
  });
});

it("keeps the outbox identity and payload on retry, including the no-reply sender and reply address", async () => {
  const send = provider().mockRejectedValueOnce(new TypeError("Connection closed"));
  const mail = {
    to: "customer@example.net",
    subject: "Welcome",
    html: "<p>Welcome</p>",
    cloudOnly: true as const,
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
    from: "noreply@openship.io",
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
