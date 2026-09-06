import { describe, expect, it } from "vitest";
import { twoFactorNext } from "./two-factor-next";

describe("twoFactorNext", () => {
  it("uses the validated destination only after a token is issued", () => {
    expect(twoFactorNext({ data: { token: "sess_1" } }, "/cloud-authorize?state=abc")).toEqual({
      kind: "session",
      href: "/cloud-authorize?state=abc",
    });
    expect(twoFactorNext({ data: { token: "sess_1" } }, null)).toEqual({
      kind: "session",
      href: "/",
    });
  });

  it.each([
    ["INVALID_CODE", "Invalid authenticator code"],
    ["INVALID_BACKUP_CODE", "Invalid backup code"],
  ])("keeps factor error %s on the challenge", (code, message) => {
    expect(twoFactorNext({ error: { code, message } }, "/settings")).toEqual({
      kind: "error",
      code,
      message,
    });
  });

  it("reports a missing or expired pending challenge separately", () => {
    expect(
      twoFactorNext(
        {
          error: {
            code: "INVALID_TWO_FACTOR_COOKIE",
            message: "Invalid two factor cookie",
          },
        },
        "/settings",
      ),
    ).toEqual({ kind: "expired" });
  });

  it("never treats a tokenless success as an authenticated session", () => {
    expect(twoFactorNext({ data: {} }, "/settings")).toEqual({
      kind: "error",
      code: null,
      message: null,
    });
    expect(twoFactorNext({}, null)).toEqual({
      kind: "error",
      code: null,
      message: null,
    });
  });
});
