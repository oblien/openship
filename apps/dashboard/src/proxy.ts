import { NextRequest, NextResponse } from "next/server";

// Cookie presence only — never proof of a valid session. Server-side
// `getSession()` in (dashboard) layout is the real authoritative
// check; this middleware just short-circuits the obviously-unauthed
// case to skip the layout fetch.

const PUBLIC_ROUTES = [
  "/login",
  "/register",
  "/forgot-password",
  "/reset-password",
  "/verify-email",
  "/authorize",
  "/onboarding",
  // The MCP OAuth consent page. It must reach its own render even without a
  // session cookie, because it sends the user to /login with a `returnTo` that
  // comes BACK here and resumes the client's authorize. This middleware's
  // redirect uses `from`, which nothing reads (getPostAuthRedirect only honors
  // `returnTo`/`callback`), so intercepting it stranded the user on `/` and the
  // MCP client's flow never completed.
  "/mcp/authorize",
];

const SESSION_COOKIE_SUFFIX = ".session_token";

export function proxy(req: NextRequest) {
  const { pathname, search } = req.nextUrl;

  // Never redirect API routes. The page-auth redirect below is meant for
  // navigations; applying it to /api/* breaks single-host proxy mode
  // (NEXT_PUBLIC_API_PROXY=true), where the sign-in POST itself goes to
  // /api/proxy/api/auth/sign-in/email — with no session cookie yet, it
  // was being bounced to /login, making login impossible. API auth is
  // enforced by the API process, which returns 401 rather than a redirect.
  if (pathname.startsWith("/api/")) return NextResponse.next();

  const isPublic = PUBLIC_ROUTES.some((r) => pathname.startsWith(r));
  const hasCookie = req.cookies.getAll().some((c) => c.name.endsWith(SESSION_COOKIE_SUFFIX));

  if (!hasCookie && !isPublic) {
    const url = new URL("/login", req.url);
    url.searchParams.set("from", pathname);
    return NextResponse.redirect(url);
  }

  // Stamp the pathname+search onto a request header so server layouts
  // can read query params (layouts don't receive `searchParams` in App
  // Router). (auth)/layout.tsx uses this to honor a `callback=` on
  // /login when the user already has a SaaS session.
  const requestHeaders = new Headers(req.headers);
  requestHeaders.set("x-pathname-with-search", `${pathname}${search}`);

  // Mirror the locale cookie onto a request header. The root layout reads it
  // to render the right language/direction on the SERVER (no English→Arabic
  // flash on reload). `cookies()` / `headers().get("cookie")` can come back
  // empty in the SSR render path, but request cookies are always available
  // here in the proxy — so we inject a header the layout can read reliably.
  const locale = req.cookies.get("openship-locale")?.value;
  if (locale) requestHeaders.set("x-openship-locale", locale);

  return NextResponse.next({ request: { headers: requestHeaders } });
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\..*).*)"],
};
