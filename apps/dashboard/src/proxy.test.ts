import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { proxy } from "./proxy";

describe("dashboard proxy middleware", () => {
  it("allows unauthenticated access to /accept-invite without redirecting to /login", () => {
    const req = new NextRequest("http://localhost:3001/accept-invite/inv_12345");
    const res = proxy(req);
    expect(res.headers.get("location")).toBeNull();
  });

  it("allows Better Auth's error page without a session", () => {
    const req = new NextRequest(
      "http://localhost:3001/auth/error?error=invalid_client&error_description=Unknown+client",
    );
    const res = proxy(req);

    expect(res.headers.get("location")).toBeNull();
  });

  it("redirects unauthenticated access to private dashboard route to /login", () => {
    const req = new NextRequest("http://localhost:3001/projects");
    const res = proxy(req);
    expect(res.headers.get("location")).toBe("http://localhost:3001/login?from=%2Fprojects");
  });
});
