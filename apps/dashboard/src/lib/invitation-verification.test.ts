import { expect, it } from "vitest";
import { buildAuthPageHref, emailVerificationHref } from "./cloud-auth";
import { signUpNext } from "@/app/(auth)/register/signup-next";

it("keeps the invitation through verification and back to login", () => {
  const params = new URLSearchParams({ returnTo: "/accept-invite/inv_1" });
  const next = signUpNext(
    { data: { token: null } },
    { email: "person+team@example.test", authParams: params },
  );
  expect(next.kind).toBe("verify");
  if (next.kind !== "verify") throw new Error("Expected verification");
  const verification = new URL(next.href, "https://ops.example.test");
  expect(verification.searchParams.get("email")).toBe("person+team@example.test");
  expect(buildAuthPageHref("/login", verification.searchParams)).toBe(
    "/login?returnTo=%2Faccept-invite%2Finv_1",
  );
});

it("carries the same invitation after sign-in requests email verification", () => {
  expect(
    emailVerificationHref(
      "person@example.test",
      new URLSearchParams({ returnTo: "/accept-invite/inv_1" }),
    ),
  ).toBe("/verify-email?returnTo=%2Faccept-invite%2Finv_1&email=person%40example.test");
});

it.each(["https://other.test", "//other.test", "/accept-invite/inv_1/extra"])(
  "never carries an unsafe verification redirect: %s",
  (returnTo) => {
    const href = emailVerificationHref("person@example.test", new URLSearchParams({ returnTo }));
    expect(new URL(href, "https://ops.example.test").searchParams.has("returnTo")).toBe(false);
  },
);
