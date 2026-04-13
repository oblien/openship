import { NextRequest, NextResponse } from "next/server";

/**
 * Lightweight middleware — checks cookie existence only.
 *
 * Does NOT validate the session (no fetch to API).
 * Actual session validation happens server-side in the
 * (dashboard) layout via `getSession()`.
 *
 * This gives instant redirects for obviously-unauthenticated users
 * (no cookie at all) without adding latency or API dependency.
 */

const PUBLIC_ROUTES = [
  "/login",
  "/register",
  "/forgot-password",
  "/reset-password",
  "/verify-email",
  "/authorize",
  "/onboarding",
];

/** Better Auth session cookie — prefix varies by API mode */
const SESSION_COOKIE_SUFFIX = ".session_token";

export function proxy(req: NextRequest) {
  const { pathname, searchParams } = req.nextUrl;
  const isPublic = PUBLIC_ROUTES.some((r) => pathname.startsWith(r));
  const hasCookie = req.cookies.getAll().some((c) => c.name.endsWith(SESSION_COOKIE_SUFFIX));

  // No cookie + protected route → redirect to login
  if (!hasCookie && !isPublic) {
    const url = new URL("/login", req.url);
    url.searchParams.set("from", pathname);
    return NextResponse.redirect(url);
  }

  // Already authenticated + hitting /login with a callback → skip login form.
  // Self-hosted "Connect to Cloud" opens /login?callback=... on SaaS;
  // if user is already logged in there, forward straight to the handoff.
  if (hasCookie && pathname === "/login" && searchParams.has("callback")) {
    const callback = searchParams.get("callback")!;
    const flow = searchParams.get("flow");

    if (flow === "desktop-cloud") {
      // Desktop PKCE flow → forward to /authorize with all params
      const url = new URL("/authorize", req.url);
      searchParams.forEach((v, k) => url.searchParams.set(k, v));
      return NextResponse.redirect(url);
    }

    // Self-hosted connect flow → go straight to handoff endpoint
    const apiUrl = process.env.NEXT_PUBLIC_API_URL || "";
    const handoffUrl = `${apiUrl}/api/cloud/connect-handoff?redirect=${encodeURIComponent(callback)}`;
    return NextResponse.redirect(handoffUrl);
  }

  // Cookie + public route → let auth layout handle the redirect
  // (it validates the session server-side; stale cookies won't loop)

  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\..*).*)"],
};
