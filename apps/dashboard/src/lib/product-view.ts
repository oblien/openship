/**
 * Which product SHELL the dashboard draws for THIS user, this request.
 *
 *   "platform" → the full deploy platform rail (Projects, Apps, Deployments, …)
 *   "mail"     → Openship Mail: the rail becomes the mail control plane
 *
 * Two inputs, resolved server-side so the very first painted HTML is already the
 * right rail:
 *
 *   - `instanceMode` — what the SERVER says this box is, from `/health/env`
 *     `productMode` (apps/api/src/lib/product-mode.ts). Brands the instance.
 *   - `cookie` — a per-user override. Wins in BOTH directions: an operator on a
 *     mail-branded box can pop out to the full platform (the webmail project
 *     lives in /projects, and a failed webmail deploy has to be debuggable), and
 *     someone on a platform box can opt into the mail rail without touching
 *     instance settings.
 *
 * The mail rail is nav + branding only. Nothing here gates a route — see the
 * header of apps/api/src/lib/product-mode.ts for why that has to stay true.
 */

export const PRODUCT_VIEWS = ["platform", "mail"] as const;
export type ProductView = (typeof PRODUCT_VIEWS)[number];

/** Cookie name, 1-year `lax` like LOCALE_COOKIE (`src/i18n/index.ts`). Mirrored
 *  onto `x-openship-product-view` by src/proxy.ts, because `cookies()` can come
 *  back empty in the SSR render path. */
export const PRODUCT_VIEW_COOKIE = "openship-product-view";

export const PRODUCT_VIEW_HEADER = "x-openship-product-view";

export function isProductView(value: unknown): value is ProductView {
  return PRODUCT_VIEWS.includes(value as ProductView);
}

/**
 * The product name to show in chrome: "OpenShip" or "OpenShip Mail". "Mail" is a
 * product suffix, not a translatable word (cf. Google Mail / Yahoo Mail), so it's
 * appended to the single `brand` string rather than forked across 9 dictionaries.
 *
 * Lives HERE, not in i18n-provider.tsx, because `generateMetadata` in
 * app/layout.tsx calls it to build the document title. Every export of a
 * `"use client"` module is a client reference the server cannot invoke — being a
 * pure function doesn't exempt it. Moving this back next to `useBrandName` throws
 * "Attempted to call brandNameFor() from the server" on every page load.
 */
export function brandNameFor(brand: string, view: ProductView): string {
  return view === "mail" ? `${brand} Mail` : brand;
}

export type ResolveProductViewInput = {
  /** Raw cookie/header value — anything, including undefined or junk. */
  cookie?: string | null;
  /** `productMode` from /health/env. */
  instanceMode?: string | null;
  /** False on the multi-tenant SaaS. */
  selfHosted: boolean;
};

export function resolveProductView({
  cookie,
  instanceMode,
  selfHosted,
}: ResolveProductViewInput): ProductView {
  // Cloud: the whole /api/mail mount is localOnly, so a mail rail there is a
  // column of links that all 403. The API already forces productMode
  // "platform", but a stale cookie in a browser that previously hit a
  // self-hosted box on the same host would still ask for the mail rail.
  if (!selfHosted) return "platform";

  if (isProductView(cookie)) return cookie;
  if (isProductView(instanceMode)) return instanceMode;
  return "platform";
}

/** Write the per-user override. Client-only; the caller reloads so the server
 *  layout re-resolves (see `setProductView` in PlatformContext). */
export function writeProductViewCookie(view: ProductView) {
  document.cookie = `${PRODUCT_VIEW_COOKIE}=${view};path=/;max-age=31536000;samesite=lax`;
}

/** Drop the per-user override, so this browser follows the instance default
 *  again. Same path/attributes as the write, or the cookie survives. */
export function clearProductViewCookie() {
  document.cookie = `${PRODUCT_VIEW_COOKIE}=;path=/;max-age=0;samesite=lax`;
}

/** The override this browser currently has, or null when it follows the
 *  instance. Client-only — SSR reads the mirrored header instead. */
export function readProductViewCookie(): ProductView | null {
  if (typeof document === "undefined") return null;
  const m = document.cookie.match(
    new RegExp(`(?:^|;\\s*)${PRODUCT_VIEW_COOKIE}=([^;]*)`),
  );
  const raw = m ? decodeURIComponent(m[1]) : null;
  return isProductView(raw) ? raw : null;
}
