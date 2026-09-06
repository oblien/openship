import { describe, expect, it } from "vitest";
import { loginNext } from "./login-next";

describe("loginNext", () => {
  const opts = {
    email: "person@example.com",
    twoFactorHref: "/two-factor?returnTo=%2Fsettings",
    postLoginUrl: "/settings",
  };

  it("uses the validated destination for an unchanged one-step login", () => {
    expect(loginNext({ data: {} }, opts)).toEqual({
      kind: "session",
      href: "/settings",
    });
    expect(loginNext({ data: {} }, { ...opts, postLoginUrl: null })).toEqual({
      kind: "session",
      href: "/",
    });
  });

  it("routes a pending two-factor login to the preserved challenge URL", () => {
    expect(loginNext({ data: { twoFactorRedirect: true } }, opts)).toEqual({
      kind: "two-factor",
      href: "/two-factor?returnTo=%2Fsettings",
    });
  });

  it("preserves the email-verification branch and encodes the email", () => {
    expect(
      loginNext(
        { error: { code: "EMAIL_NOT_VERIFIED", message: "Email not verified" } },
        { ...opts, email: "person+tag@example.com" },
      ),
    ).toEqual({
      kind: "verify-email",
      href: "/verify-email?email=person%2Btag%40example.com",
    });
    expect(
      loginNext({ error: { message: "Please verify your email" } }, opts).kind,
    ).toBe("verify-email");
  });

  it("surfaces ordinary Better Auth errors", () => {
    expect(loginNext({ error: { message: "Invalid credentials" } }, opts)).toEqual({
      kind: "error",
      message: "Invalid credentials",
    });
    expect(loginNext({ error: { code: "BAD_REQUEST" } }, opts)).toEqual({
      kind: "error",
      message: null,
    });
  });
});
