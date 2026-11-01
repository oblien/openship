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
    expect(res.headers.get("location")).toBe("http://localhost:3001/login");
  });

  it("retains the selected app and draft query through login", () => {
    const destination = "/apps/new/open-webui?projectId=proj_draft&deployment=dep_failed";
    const response = proxy(new NextRequest(`https://app.openship.io${destination}`));
    const login = new URL(response.headers.get("location")!);
    expect(login.pathname).toBe("/login");
    expect(login.searchParams.get("returnTo")).toBe(destination);
  });

  it("overwrites a spoofed request path before the session layout reads it", () => {
    const response = proxy(new NextRequest("https://app.openship.io/apps/new/minio", {
      headers: { cookie: "better-auth.session_token=test", "x-pathname-with-search": "//evil.test" },
    }));
    expect(response.headers.get("x-middleware-request-x-pathname-with-search")).toBe("/apps/new/minio");
  });

  it("retains the selected app if the cookie disappears at organization selection", () => {
    const destination = "/apps/new/convex";
    const response = proxy(new NextRequest(`https://app.openship.io/select-organization?${new URLSearchParams({ returnTo: destination })}`));
    expect(new URL(response.headers.get("location")!).searchParams.get("returnTo")).toBe(destination);
  });

  it("retains the landing-page purchase destination through login", () => {
    const destination = "/billing/plans?newServer=1&plan=starter";
    const response = proxy(new NextRequest(`https://app.openship.io${destination}`));
    expect(new URL(response.headers.get("location")!).searchParams.get("returnTo")).toBe(destination);
  });

  it.each([
    "/auth/callback/install?state=install-nonce",
    "/auth/callback/close?error=unable_to_link_account",
    "/auth/callback/github-app?installation_id=42&state=install-nonce",
  ])("lets GitHub callback %s render without a dashboard cookie", (path) => {
    const response = proxy(new NextRequest(`https://app.openship.io${path}`));
    expect(response.headers.get("location")).toBeNull();
    expect(response.headers.get("x-middleware-request-x-pathname-with-search")).toBe(path);
  });
});
