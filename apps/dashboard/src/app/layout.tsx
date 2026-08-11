import type { Metadata } from "next";
import { cookies, headers } from "next/headers";
import "./globals.css";
import { ThemeProvider, ThemeScript } from "@/components/theme-provider";
import { ToastProvider } from "@/components/toast";
import { I18nProvider } from "@/components/i18n-provider";
import { AuthProvider } from "@/context/AuthContext";
import { NetworkErrorHandler } from "@/components/network-error-handler";
import { ModalProvider } from "@/context/ModalContext";
import { DesktopChrome } from "@/components/desktop-chrome";
import {
  defaultLocale,
  isRtl,
  loadDictionary,
  LOCALE_COOKIE,
  locales,
  type Locale,
} from "@/i18n";

/** Resolve the request locale server-side: explicit cookie first, then the
 *  browser's Accept-Language, else the default. Keeps SSR and first paint in
 *  the right language + direction (no English→Arabic flash on load). */
async function resolveRequestLocale(): Promise<Locale> {
  const hdrs = await headers();

  // The proxy (src/proxy.ts) mirrors the locale cookie onto this header — the
  // reliable path, since `cookies()` / the raw Cookie header can come back
  // empty in the SSR render. Fall back to cookies() (works in dev), then
  // Accept-Language, then the default.
  const cookieStore = await cookies();
  const fromCookie =
    hdrs.get("x-openship-locale") ?? cookieStore.get(LOCALE_COOKIE)?.value;
  if (fromCookie && (locales as readonly string[]).includes(fromCookie)) {
    return fromCookie as Locale;
  }

  const accept = hdrs.get("accept-language") ?? "";
  const pref = accept.split(",")[0]?.split("-")[0]?.trim().toLowerCase();
  if (pref && (locales as readonly string[]).includes(pref)) return pref as Locale;
  return defaultLocale;
}

/**
 * Render every route on-demand, never at build time. The dashboard resolves its
 * deploy/auth mode from the API (`GET /health/env`) and reads request `headers()`
 * on render — neither is available during `next build` (the API isn't running in
 * the Docker builder), and the deploy-info resolver correctly refuses to guess.
 * Forcing dynamic here skips static prerendering app-wide so the image builds
 * without a live API; nothing in this auth-gated dashboard is statically cacheable
 * anyway. Do NOT remove — it's what lets the container build succeed.
 */
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Openship",
  description: "Manage your deployments, domains, and infrastructure.",
  icons: {
    icon: [
      { url: '/favicon.ico' },
      { url: '/favicon-16x16.png', sizes: '16x16', type: 'image/png' },
      { url: '/favicon-32x32.png', sizes: '32x32', type: 'image/png' },
    ],
    apple: [
      { url: '/apple-touch-icon.png', sizes: '180x180', type: 'image/png' },
    ],
    other: [
      { url: '/android-chrome-192x192.png', sizes: '192x192', type: 'image/png' },
      { url: '/android-chrome-512x512.png', sizes: '512x512', type: 'image/png' },
    ],
  },
  manifest: '/site.webmanifest',
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // Desktop runs the API on a dynamic free port. Mirror the server-side
  // OPENSHIP_LOCAL_API_URL into the browser so the client bundle's API base
  // (a module-load constant that can't read a runtime env) targets it. Read
  // per-request thanks to `force-dynamic` above.
  const localApiOrigin = process.env.OPENSHIP_LOCAL_API_URL;

  const locale = await resolveRequestLocale();
  const dir = isRtl(locale) ? "rtl" : "ltr";
  // English is the bundled base (no prop needed); for other locales load the
  // dictionary server-side so the very first render is already translated.
  const initialDictionary =
    locale === defaultLocale ? undefined : await loadDictionary(locale);

  return (
    <html lang={locale} dir={dir} suppressHydrationWarning>
      <head>
        <ThemeScript />
        {/* Set <html lang/dir> from the locale cookie BEFORE paint, so a reload
            in Arabic mirrors immediately even if SSR fell back to default —
            mirrors ThemeScript's no-flash approach. React reconciles the text. */}
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var m=document.cookie.match(/(?:^|;\\s*)${LOCALE_COOKIE}=([^;]+)/);var l=m?decodeURIComponent(m[1]):(localStorage.getItem('${LOCALE_COOKIE}')||'');if(l==='ar'){document.documentElement.lang='ar';document.documentElement.dir='rtl';}else if(l==='en'){document.documentElement.lang='en';document.documentElement.dir='ltr';}}catch(e){}})();`,
          }}
        />
        {localApiOrigin ? (
          <script
            dangerouslySetInnerHTML={{
              __html: `window.__OPENSHIP_API_ORIGIN__=${JSON.stringify(localApiOrigin)}`,
            }}
          />
        ) : null}
      </head>
      <body>
        <ThemeProvider>
          <AuthProvider>
            <I18nProvider initialLocale={locale} initialDictionary={initialDictionary}>
              <ToastProvider>
                <ModalProvider>
                  <DesktopChrome />
                  <NetworkErrorHandler />
                  {children}
                </ModalProvider>
              </ToastProvider>
            </I18nProvider>
          </AuthProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
