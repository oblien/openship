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

const PUBLIC_ROUTES = ["/login", "/register", "/forgot-password", "/reset-password", "/verify-email"];

/** Better Auth stores session in this cookie by default */
const SESSION_COOKIE = "better-auth.session_token";

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  const isPublic = PUBLIC_ROUTES.some((r) => pathname.startsWith(r));
  const hasCookie = req.cookies.has(SESSION_COOKIE);

  // No cookie + protected route → redirect to login
  if (!hasCookie && !isPublic) {
    const url = new URL("/login", req.url);
    url.searchParams.set("from", pathname);
    return NextResponse.redirect(url);
  }

  // Has cookie + auth route → redirect to dashboard
  if (hasCookie && isPublic) {
    return NextResponse.redirect(new URL("/", req.url));
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\..*).*)"],
};
