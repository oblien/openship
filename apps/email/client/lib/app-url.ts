/**
 * Single source of truth for the SPA's public origin.
 *
 * Zero is always served same-origin — the Hono server hosts both the SPA and
 * the API on the same port. At runtime the app URL is whatever the browser
 * loaded the page from (`window.location.origin`). No env, no build-time
 * baking, one build deploys anywhere.
 *
 * Dev still needs a fallback: when the Vite dev server runs the SPA on port
 * 3000, `window.location.origin` is correct for the SPA. The optional
 * `VITE_PUBLIC_APP_URL` env var is consulted only off-browser (SSR /
 * module-load on Node) where `window` doesn't exist.
 *
 * Without a runtime origin, `${undefined}/login` was stringified to the
 * relative URL `undefined/login` — e.g. after logout from `/mail/inbox` the
 * browser resolved it to `/mail/undefined/login`.
 */

function isBrowser(): boolean {
  return typeof window !== 'undefined' && !!window.location?.origin;
}

export function getAppUrl(): string {
  if (isBrowser()) return window.location.origin;
  const fromEnv =
    typeof import.meta !== 'undefined'
      ? (import.meta.env?.VITE_PUBLIC_APP_URL as string | undefined)
      : undefined;
  if (fromEnv && fromEnv !== 'undefined') return fromEnv;
  return '';
}

/** Build an absolute redirect target; falls back to a root-relative path. */
export function absoluteAppUrl(path: string): string {
  const origin = getAppUrl();
  const normalized = path.startsWith('/') ? path : `/${path}`;
  return origin ? `${origin}${normalized}` : normalized;
}
