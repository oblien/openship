import { afterAll, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import type { SendMailOptions } from "@repo/platform/engine/lib/mail";

const h = vi.hoisted(() => ({ send: vi.fn(async (_mail: SendMailOptions) => true) }));
vi.mock("@repo/platform/engine/config/env", async (original) => {
  const actual = await original<typeof import("@repo/platform/engine/config/env")>();
  return {
    ...actual,
    env: {
      ...actual.env,
      CLOUD_MODE: true,
      GOOGLE_CLIENT_ID: "customer-mail-test",
      GOOGLE_CLIENT_SECRET: "customer-mail-test-secret",
    },
  };
});
vi.mock("@repo/platform/engine/lib/mail", () => ({
  sendMail: h.send,
  smtpEnabled: true,
  canSendMail: async () => true,
  requireEmailVerificationStrict: true,
}));

import { db, schema, closeDb, eq, repos } from "@repo/db";
import { auth } from "@repo/platform/engine/lib/auth";
import { CustomerEmailService } from "@repo/platform/engine/modules/customer-email/service";

afterAll(() => closeDb());
const request = (path: string, body: unknown) =>
  auth.handler(
    new Request(`http://localhost:4000/api/auth${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "http://localhost:3001" },
      body: JSON.stringify(body),
    }),
  );
const service = () =>
  new CustomerEmailService({
    enabled: () => true,
    repo: repos.cloudCustomerEmail,
    send: h.send,
    dashboardUrl: "https://app.openship.io",
  });

it("welcomes a real SaaS email signup only after the real OTP verification flow", async () => {
  const email = `signup-${randomUUID()}@example.com`;
  const signup = await request("/sign-up/email", {
    name: "Alex",
    email,
    password: "valid-test-password-1234!",
  });
  expect(signup.status, await signup.clone().text()).toBe(200);
  expect(h.send).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ to: email }));
  const initialMail = h.send.mock.calls.at(-1)![0] as { subject: string };
  const initialCode = initialMail.subject.match(/\b\d{6}\b/)![0];
  const [user] = await db.select().from(schema.user).where(eq(schema.user.email, email));
  expect(user!.emailVerified).toBe(false);
  expect(
    await db
      .select()
      .from(schema.cloudCustomerEmail)
      .where(eq(schema.cloudCustomerEmail.userId, user!.id)),
  ).toMatchObject([{ kind: "signup", status: "pending" }]);
  h.send.mockClear();
  expect(await service().flush()).toMatchObject({ sent: 0 });
  expect(h.send).not.toHaveBeenCalled();
  const verified = await request("/email-otp/verify-email", { email, otp: initialCode });
  expect(verified.status, await verified.clone().text()).toBe(200);
  h.send.mockClear();
  await service().flush();
  await service().flush();
  expect(h.send).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      to: email,
      subject: "Welcome to OpenShip",
      customerSender: "support",
      replyTo: "support@openship.io",
    }),
  );
}, 30_000);

it("welcomes a verified Google signup through the same outbox without repeating it on login", async () => {
  const email = `google-${randomUUID()}@example.com`;
  const subject = randomUUID();
  const keys = await generateKeyPair("RS256");
  const publicKey = { ...(await exportJWK(keys.publicKey)), kid: "google-test", alg: "RS256" };
  let nonce: string | null = null;
  // Only the external Google responses are simulated. Better Auth handles the
  // callback, state validation and signed ID token before running the real hook.
  const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url === "https://www.googleapis.com/oauth2/v3/certs")
      return Response.json({ keys: [publicKey] });
    if (url === "https://oauth2.googleapis.com/token") {
      const idToken = await new SignJWT({
        email,
        email_verified: true,
        name: "Google customer",
        ...(nonce ? { nonce } : {}),
      })
        .setProtectedHeader({ alg: "RS256", kid: "google-test" })
        .setIssuer("https://accounts.google.com")
        .setAudience("customer-mail-test")
        .setSubject(subject)
        .setIssuedAt()
        .setExpirationTime("5m")
        .sign(keys.privateKey);
      return Response.json({
        access_token: "google-test-access",
        token_type: "Bearer",
        id_token: idToken,
      });
    }
    throw new Error(`Unexpected provider request: ${url}`);
  });
  const login = async () => {
    const start = await request("/sign-in/social", {
      provider: "google",
      callbackURL: "http://localhost:3001/projects",
    });
    expect(start.status, await start.clone().text()).toBe(200);
    const authorization = new URL((await start.json()).url);
    nonce = authorization.searchParams.get("nonce");
    const state = authorization.searchParams.get("state");
    expect(state).toBeTruthy();
    const cookie = start.headers
      .getSetCookie()
      .map((value) => value.split(";")[0])
      .join("; ");
    const callback = await auth.handler(
      new Request(
        `http://localhost:4000/api/auth/callback/google?${new URLSearchParams({ code: "google-test-code", state: state! })}`,
        { headers: { Cookie: cookie } },
      ),
    );
    expect(callback.status).toBe(302);
    expect(callback.headers.get("location")).toBe("http://localhost:3001/projects");
  };
  try {
    h.send.mockClear();
    await login();
    const [user] = await db.select().from(schema.user).where(eq(schema.user.email, email));
    expect(user!.emailVerified).toBe(true);
    const queued = () =>
      db
        .select()
        .from(schema.cloudCustomerEmail)
        .where(eq(schema.cloudCustomerEmail.userId, user!.id));
    expect(await queued()).toMatchObject([{ kind: "signup", status: "pending" }]);
    expect(h.send).not.toHaveBeenCalled();
    expect(await service().flush()).toEqual({ sent: 1, failed: 0, canceled: 0 });
    await login();
    expect(await service().flush()).toEqual({ sent: 0, failed: 0, canceled: 0 });
    expect(await queued()).toMatchObject([{ kind: "signup", status: "sent" }]);
    expect(h.send).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        to: email,
        subject: "Welcome to OpenShip",
        customerSender: "support",
        replyTo: "support@openship.io",
      }),
    );
  } finally {
    fetch.mockRestore();
  }
}, 30_000);

it("keeps one OAuth account on repeat signup and privately explains how to sign in", async () => {
  const email = `existing-google-${randomUUID()}@example.com`;
  const id = randomUUID();
  await db
    .insert(schema.user)
    .values({ id, email, name: "Existing Google customer", emailVerified: true });
  await db
    .insert(schema.account)
    .values({ id: randomUUID(), accountId: randomUUID(), providerId: "google", userId: id });
  h.send.mockClear();
  for (const attempt of [1, 2]) {
    const signup = await request("/sign-up/email", {
      name: "Signup retry",
      email,
      password: `attempt-${attempt}-not-an-account-password!`,
    });
    expect(signup.status, await signup.clone().text()).toBe(200);
    expect((await signup.json()).token).toBeNull();
  }
  expect(await db.select().from(schema.user).where(eq(schema.user.email, email))).toHaveLength(1);
  expect(await db.select().from(schema.account).where(eq(schema.account.userId, id))).toMatchObject(
    [{ providerId: "google", password: null }],
  );
  expect(h.send).toHaveBeenCalledWith(
    expect.objectContaining({ to: email, subject: "Sign in to your OpenShip account" }),
  );
  const notice = h.send.mock.calls.at(-1)![0] as { text: string };
  expect(notice.text).toContain("already have");
  expect(notice.text).toContain("Google");
  const login = await request("/sign-in/email", {
    email,
    password: "attempt-2-not-an-account-password!",
  });
  expect(login.status).toBe(401);
  // A provider-only customer can add a password only after proving mailbox
  // ownership through the existing recovery flow, never from duplicate signup.
  h.send.mockClear();
  const reset = await request("/email-otp/request-password-reset", { email });
  expect(reset.status, await reset.clone().text()).toBe(200);
  const resetMail = h.send.mock.calls.at(-1)![0] as { subject: string };
  const otp = resetMail.subject.match(/\b\d{6}\b/)![0];
  const password = "verified-mailbox-owner-new-password-1234!";
  const changed = await request("/email-otp/reset-password", { email, otp, password });
  expect(changed.status, await changed.clone().text()).toBe(200);
  expect((await request("/sign-in/email", { email, password })).status).toBe(200);
  expect(await db.select().from(schema.account).where(eq(schema.account.userId, id))).toHaveLength(
    2,
  );
}, 30_000);

it("resends verification on an unverified signup retry without replacing its password", async () => {
  const email = `retry-signup-${randomUUID()}@example.com`;
  const password = "first-signup-password-1234!";
  const first = await request("/sign-up/email", { email, name: "Signup customer", password });
  expect(first.status).toBe(200);
  h.send.mockClear();
  const retry = await request("/sign-up/email", {
    email,
    name: "Second attempt",
    password: "different-retry-password-1234!",
  });
  expect(retry.status).toBe(200);
  expect(h.send).toHaveBeenCalledWith(expect.objectContaining({ to: email }));
  const mail = h.send.mock.calls.at(-1)![0] as { subject: string };
  const otp = mail.subject.match(/\b\d{6}\b/)![0];
  const verified = await request("/email-otp/verify-email", { email, otp });
  expect(verified.status, await verified.clone().text()).toBe(200);
  expect((await request("/sign-in/email", { email, password })).status).toBe(200);
  expect(
    (await request("/sign-in/email", { email, password: "different-retry-password-1234!" })).status,
  ).toBe(401);
  expect(await db.select().from(schema.user).where(eq(schema.user.email, email))).toHaveLength(1);
}, 30_000);

it("recovers an initial delivery failure by retrying signup with the same account", async () => {
  const email = `smtp-retry-${randomUUID()}@example.com`;
  const password = "original-signup-password-1234!";
  h.send.mockClear();
  h.send.mockResolvedValueOnce(false);
  const first = await request("/sign-up/email", { email, name: "SMTP retry", password });
  // Better Auth logs background delivery failures while keeping its generic response.
  expect(first.status).toBe(200);
  h.send.mockClear();
  const retry = await request("/sign-up/email", {
    email,
    name: "SMTP retry",
    password: "a-different-retry-password-1234!",
  });
  expect(retry.status, await retry.clone().text()).toBe(200);
  expect(h.send).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ to: email }));
  const mail = h.send.mock.calls.at(-1)![0] as { subject: string };
  const otp = mail.subject.match(/\b\d{6}\b/)![0];
  expect((await request("/email-otp/verify-email", { email, otp })).status).toBe(200);
  expect((await request("/sign-in/email", { email, password })).status).toBe(200);
  expect(await db.select().from(schema.user).where(eq(schema.user.email, email))).toHaveLength(1);
}, 30_000);
