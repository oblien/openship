/**
 * Pure path check mirroring the dashboard proxy's first-admin token injection
 * (#138). Kept as a unit so we don't need a Next.js request fixture.
 */

import { describe, expect, test } from "vitest";

/** Same predicate as apps/dashboard/.../proxy/[...path]/route.ts */
function isProxiedSignUp(method: string, pathSegments: string[]): boolean {
  return (
    method === "POST" &&
    pathSegments.length >= 3 &&
    pathSegments[0] === "api" &&
    pathSegments[1] === "auth" &&
    pathSegments[2] === "sign-up"
  );
}

describe("dashboard proxy sign-up injection path", () => {
  test("matches Better Auth email sign-up", () => {
    expect(isProxiedSignUp("POST", ["api", "auth", "sign-up", "email"])).toBe(true);
  });

  test("matches bare sign-up prefix", () => {
    expect(isProxiedSignUp("POST", ["api", "auth", "sign-up"])).toBe(true);
  });

  test("does not match GET or other auth routes", () => {
    expect(isProxiedSignUp("GET", ["api", "auth", "sign-up", "email"])).toBe(false);
    expect(isProxiedSignUp("POST", ["api", "auth", "sign-in", "email"])).toBe(false);
    expect(isProxiedSignUp("POST", ["api", "system", "bootstrap-admin"])).toBe(false);
  });
});
