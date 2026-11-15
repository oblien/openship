import { hasLocale } from "next-intl";
import { NextResponse, type NextRequest } from "next/server";
import { isLocalizedPath, routing, withoutLocale } from "./i18n/routing";

export default function proxy(request: NextRequest) {
  const first = request.nextUrl.pathname.split("/")[1];
  if (hasLocale(routing.locales, first)) {
    const pathname = withoutLocale(request.nextUrl.pathname);
    const socialImage = /\/(?:opengraph|twitter)-image(?:[-/]|$)/.test(pathname);
    if (first === routing.defaultLocale || (!isLocalizedPath(pathname) && !socialImage)) {
      const url = request.nextUrl.clone();
      url.pathname = pathname;
      return NextResponse.redirect(url);
    }
  }
  // English URLs are mapped by next.config rewrites. No browser-language or
  // cookie reads enter page rendering, and no absolute proxy rewrite is needed.
  return NextResponse.next();
}

export const config = {
  matcher: [
    "/((?!api(?:/|$)|docs(?:/|$)|docs-raw(?:/|$)|docs-og(?:/|$)|_next|_vercel|sitemaps|.*\\..*).*)",
  ],
};
