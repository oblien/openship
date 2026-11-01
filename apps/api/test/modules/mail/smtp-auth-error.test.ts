import { describe, expect, it } from "vitest";
import { isSmtpAuthFailure } from "@repo/platform/engine/modules/mail/smtp-auth-error";

describe("isSmtpAuthFailure", () => {
  it.each([
    { code: "EAUTH" },
    { responseCode: 535 },
    new Error("535 5.7.8 Authentication credentials invalid"),
    { cause: new Error("authentication failed") },
  ])("recognizes Nodemailer and SMTP auth failures", (error) => {
    expect(isSmtpAuthFailure(error)).toBe(true);
  });

  it("does not treat network or delivery failures as credential drift", () => {
    expect(isSmtpAuthFailure(new Error("connect ETIMEDOUT mail.example.com:465"))).toBe(false);
    expect(isSmtpAuthFailure({ responseCode: 550, message: "mailbox unavailable" })).toBe(false);
  });
});
