import { describe, expect, it } from "vitest";
import { selfHostedRegisterRedirect } from "./register-access";

describe("selfHostedRegisterRedirect", () => {
  it("redirects direct self-hosted registration to sign-in", () => {
    expect(selfHostedRegisterRedirect(true, "/register")).toBe("/login");
    expect(selfHostedRegisterRedirect(true, "/register/")).toBe("/login");
  });

  it("returns a self-hosted invitation flow to its token-bound claim page", () => {
    expect(
      selfHostedRegisterRedirect(true, "/register?returnTo=%2Faccept-invite%2Finv_A-b_1"),
    ).toBe("/accept-invite/inv_A-b_1");
  });

  it("does not accept other return targets as a registration bypass", () => {
    expect(
      selfHostedRegisterRedirect(
        true,
        "/register?returnTo=%2Fmcp%2Fauthorize%3Fclient_id%3Dclient_1",
      ),
    ).toBe("/login");
    expect(
      selfHostedRegisterRedirect(
        true,
        "/register?returnTo=https%3A%2F%2Fevil.example%2Faccept-invite%2Finv_1",
      ),
    ).toBe("/login");
  });

  it("leaves SaaS registration and unrelated routes alone", () => {
    expect(selfHostedRegisterRedirect(false, "/register")).toBeNull();
    expect(selfHostedRegisterRedirect(true, "/login")).toBeNull();
  });
});
