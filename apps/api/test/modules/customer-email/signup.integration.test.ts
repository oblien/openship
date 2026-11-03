import { afterAll, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import type { SendMailOptions } from "@repo/platform/engine/lib/mail";

const h = vi.hoisted(() => ({ send: vi.fn(async (_mail: SendMailOptions) => true) }));
vi.mock("@repo/platform/engine/config/env", async (original) => {
  const actual = await original<typeof import("@repo/platform/engine/config/env")>();
  return { ...actual, env: { ...actual.env, CLOUD_MODE: true } };
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

it("welcomes a real SaaS email signup only after the real OTP verification flow", async () => {
  const email = `signup-${randomUUID()}@example.com`;
  const signup = await request("/sign-up/email", {
    name: "Alex",
    email,
    password: "valid-test-password-1234!",
  });
  expect(signup.status, await signup.clone().text()).toBe(200);
  const [user] = await db.select().from(schema.user).where(eq(schema.user.email, email));
  expect(user!.emailVerified).toBe(false);
  expect(
    await db
      .select()
      .from(schema.cloudCustomerEmail)
      .where(eq(schema.cloudCustomerEmail.userId, user!.id)),
  ).toMatchObject([{ kind: "signup", status: "pending" }]);
  const service = () =>
    new CustomerEmailService({
      enabled: () => true,
      repo: repos.cloudCustomerEmail,
      send: h.send,
      dashboardUrl: "https://app.openship.io",
    });
  h.send.mockClear();
  expect(await service().flush()).toMatchObject({ sent: 0 });
  expect(h.send).not.toHaveBeenCalled();
  const otp = await request("/email-otp/send-verification-otp", {
    email,
    type: "email-verification",
  });
  expect(otp.status, await otp.clone().text()).toBe(200);
  const mail = h.send.mock.calls.at(-1)![0] as { subject: string };
  const code = mail.subject.match(/\b\d{6}\b/)![0];
  const verified = await request("/email-otp/verify-email", { email, otp: code });
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
