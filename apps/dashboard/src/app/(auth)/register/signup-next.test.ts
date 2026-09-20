import { describe, expect, it } from "vitest";
import { signUpNext } from "./signup-next";

/**
 * The reported symptom: "when signup, it redirect with error 401 as unauthorized,
 * why not go to the email verification".
 *
 * Root cause: on an instance requiring verification, better-auth's sign-up returns
 * `{ token: null, user }` with NO error, so the page's success branch pushed `/`
 * and the app bounced an unauthenticated visitor into a 401.
 */
describe("signUpNext", () => {
  const opts = { email: "a@b.co" };

  it("goes to verification when sign-up succeeds WITHOUT a session", () => {
    // The exact better-auth shape for requireEmailVerification.
    const next = signUpNext({ data: { token: null } }, opts);
    expect(next).toEqual({ kind: "verify", href: "/verify-email?email=a%40b.co" });
  });

  it("treats a missing token field the same as an explicit null", () => {
    expect(signUpNext({ data: {} }, opts).kind).toBe("verify");
    expect(signUpNext({}, opts).kind).toBe("verify");
  });

  it("follows the session only when a token was actually issued", () => {
    expect(signUpNext({ data: { token: "sess_1" } }, opts)).toEqual({
      kind: "session",
      href: "/",
    });
    expect(
      signUpNext({ data: { token: "sess_1" } }, { ...opts, postLoginUrl: "/cloud-authorize?x=1" }),
    ).toEqual({ kind: "session", href: "/cloud-authorize?x=1" });
  });

  it("still routes a verify-flavoured ERROR to the same screen", () => {
    // Some deployments express the requirement as an error rather than a null token.
    expect(signUpNext({ error: { message: "Please verify your email" } }, opts).kind).toBe(
      "verify",
    );
  });

  it("surfaces any other error instead of navigating", () => {
    expect(signUpNext({ error: { message: "Email already in use" } }, opts)).toEqual({
      kind: "error",
      message: "Email already in use",
    });
  });

  it("encodes the email so a + address survives the query string", () => {
    const next = signUpNext({ data: { token: null } }, { email: "a+tag@b.co" });
    // A bare + would decode to a space and the verify screen would post the wrong
    // address to the OTP endpoint.
    expect(next.kind === "verify" && next.href).toContain("a%2Btag%40b.co");
  });
});
