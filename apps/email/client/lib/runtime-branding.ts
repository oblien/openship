/**
 * Branding as it was when the server rendered this document.
 *
 * GH-568: `siteConfig` is a BUILD-time constant, and root.tsx's `meta` export
 * used it directly. Because the SPA hydrates the whole document, React
 * re-rendered the <head> from those constants and undid the values the server
 * had just substituted - the tab reverted to "OpenShip Mail" moments after
 * load, and duplicate description/og metas were appended.
 *
 * The server therefore embeds the branding it used in the document itself
 * (apps/email/server/src/lib/index-html.ts writes
 * `<script id="__branding__" type="application/json">`), and this module reads
 * it. First client render then produces exactly the head the server sent.
 *
 * Why not fetch `/branding.json` here: the first render has to agree with the
 * server HTML or React rewrites the head before any response could arrive.
 * Reading an already-present element is synchronous, so there is no window in
 * which the two disagree - and no extra request on every page load. Components
 * that need branding to stay live after mount (the login page's own strings)
 * keep using the `branding.get` query; this is only for the document head,
 * which is fixed for the lifetime of the document anyway.
 */

import { siteConfig } from './site-config';

export type RuntimeBranding = {
  siteTitle: string;
  siteDescription: string;
  showPoweredBy: boolean;
};

const FALLBACK: RuntimeBranding = {
  siteTitle: siteConfig.title,
  siteDescription: siteConfig.description,
  showPoweredBy: true,
};

let cached: RuntimeBranding | null = null;

/**
 * Memoised for the lifetime of the document. The embedded value cannot change
 * without a navigation, and `meta` runs on every route change - re-parsing on
 * each one would be wasted work.
 *
 * Falls back to the build-time defaults whenever the element is absent or
 * unparseable: the vite dev server serves index.html straight from disk with no
 * server-side substitution, and the react-router prerender pass runs with no
 * `document` at all. Both must keep working.
 */
export function runtimeBranding(): RuntimeBranding {
  if (cached) return cached;
  if (typeof document === 'undefined') return FALLBACK;

  const raw = document.getElementById('__branding__')?.textContent;
  if (!raw) return FALLBACK;

  try {
    const parsed = JSON.parse(raw) as Partial<RuntimeBranding>;
    cached = {
      siteTitle: parsed.siteTitle || FALLBACK.siteTitle,
      siteDescription: parsed.siteDescription || FALLBACK.siteDescription,
      // Only an explicit `false` hides the vendor row.
      showPoweredBy: parsed.showPoweredBy !== false,
    };
    return cached;
  } catch {
    return FALLBACK;
  }
}
