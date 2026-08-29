/**
 * The SPA shell, with branding substituted into its <head>.
 *
 * GH-568: `siteTitle` and `siteDescription` were write-only. PATCH accepted
 * them, `/branding.json` read them back, and the browser tab still said
 * "OpenShip Mail" - because the client is PREBUILT and those two values are
 * baked into `client/build/client/index.html` at image build time
 * (client/lib/site-config.ts supplies them to the root route's meta export).
 * The other four branding fields render client-side from `branding.get`, which
 * is why those worked and these two silently did not.
 *
 * Why this is done on the SERVER and not with `document.title = ...` on boot:
 * the issue asks for a correct <title> AND correct OpenGraph tags. OG tags
 * exist for link-preview crawlers (Slack, iMessage, WhatsApp, search), and
 * those fetch the HTML without executing JavaScript - a client-side assignment
 * is invisible to every one of them, and would also flash the wrong tab title
 * on each cold load. Substituting here is the only place that reaches both
 * audiences, and it costs a few regex replaces on a ~4 KB string.
 *
 * Caching: the template is read from disk ONCE (a running container's build
 * directory does not change), and the substitution re-runs per document
 * request against `getBranding()`, which is itself memoised and invalidated by
 * the fs.watch in branding.ts. An operator's PATCH therefore shows up on the
 * next page load with no second invalidation path to keep in sync. Documents
 * are a rounding error next to asset requests, which still go through
 * serveStatic untouched.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getBranding, type Branding } from './branding';

/**
 * Operator-supplied strings are interpolated into markup, so they are escaped
 * without exception. `branding-admin.ts` bounds their LENGTH but not their
 * content, and holding the PATCH token is not the same authority as "may run
 * script in every visitor's browser": an unescaped `"` in siteTitle closes the
 * attribute and a `<` opens a tag. Escaping the full attribute set (& < > " ')
 * is correct for both the attribute and text positions used below.
 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Which <head> slots carry branding, and where each takes its value from. */
type Slot = {
  readonly key: 'title' | 'description' | 'og:title' | 'og:description' | 'embed';
};

const SLOTS: readonly Slot['key'][] = [
  'title',
  'description',
  'og:title',
  'og:description',
  'embed',
];

/**
 * `embed` is what stops the client from undoing everything above.
 *
 * The SPA hydrates the whole document (entry.client.tsx `hydrateRoot(document,
 * …)`), and root.tsx's `meta` export re-renders the <head> from the build-time
 * `siteConfig`. React then CLAIMS the injected <title> and rewrites its text,
 * and appends duplicate description/og metas because it matches them by
 * `content`. Net effect without this: crawlers see the branded head, the
 * browser tab flips back to "OpenShip Mail" a moment after load.
 *
 * So the server hands the client the same values it just rendered, in the
 * document, and root.tsx reads them (client/lib/runtime-branding.ts). Client
 * output then equals server output - no revert, no duplicate tags, no flash,
 * and no extra round trip. An additional fetch would not have fixed it: the
 * first render still has to agree, or React rewrites the head before the
 * response arrives.
 */
const EMBED_ID = '__branding__';


/**
 * Match by TAG SHAPE, never by the default value. Matching `"OpenShip Mail"`
 * as a literal would stop working the moment client/lib/site-config.ts changes
 * - and a silent no-op is precisely the bug GH-568 reported, so this must not
 * be able to fail quietly.
 *
 * Two steps rather than one pattern, because attribute ORDER is not a contract:
 * React currently emits `name` before `content`, but a single regex spanning
 * both would report the tag missing the day that flips. So: locate the whole
 * tag by its identifying attribute, then rewrite `content` inside it.
 */
function replaceMetaContent(
  html: string,
  attr: 'name' | 'property',
  name: string,
  value: string,
): string | null {
  const tag = html.match(new RegExp(`<meta\\s+[^>]*${attr}=["']${name}["'][^>]*>`, 'i'))?.[0];
  if (!tag || !CONTENT_PATTERN.test(tag)) return null;
  return html.replace(tag, tag.replace(CONTENT_PATTERN, `$1${escapeHtml(value)}$2`));
}

const CONTENT_PATTERN = /(content=["'])[^"']*(["'])/i;
const TITLE_PATTERN = /(<title>)[^<]*(<\/title>)/i;

/**
 * The branding payload, as a JSON script block the client reads on first
 * render. `application/json` is inert - the browser never executes it - but the
 * TEXT still has to be escaped: an operator string containing `</script>` would
 * otherwise close the block and everything after it would be parsed as markup.
 * Escaping `<` to its < unicode escape is valid JSON, so JSON.parse is
 * unaffected, and it makes `</script`, `<!--` and `<![CDATA[` all unreachable.
 */
function brandingScriptTag(branding: Partial<Branding>): string {
  const json = JSON.stringify(branding).replace(/</g, '\\u003c');
  return `<script id="${EMBED_ID}" type="application/json">${json}</script>`;
}

/**
 * Pure substitution: no filesystem, no env, no module state - so it is
 * directly unit-testable, which is the whole reason it is separated from
 * `renderIndexHtml` below.
 *
 * `missing` names any slot whose tag was not found in the template. A caller
 * that ignores it degrades to the original silent no-op, so the server logs it
 * once at boot.
 */
export function injectBranding(
  html: string,
  branding: Pick<Branding, 'siteTitle' | 'siteDescription'> & Partial<Branding>,
): { html: string; missing: Slot['key'][] } {
  const { siteTitle, siteDescription } = branding;

  /** Each slot rewrites the document, or returns null if its tag is absent. */
  const apply: Record<Slot['key'], (html: string) => string | null> = {
    title: (h) =>
      TITLE_PATTERN.test(h)
        ? h.replace(TITLE_PATTERN, `$1${escapeHtml(siteTitle)}$2`)
        : null,
    description: (h) => replaceMetaContent(h, 'name', 'description', siteDescription),
    'og:title': (h) => replaceMetaContent(h, 'property', 'og:title', siteTitle),
    'og:description': (h) => replaceMetaContent(h, 'property', 'og:description', siteDescription),
    embed: (h) =>
      h.includes('</head>')
        ? h.replace('</head>', `${brandingScriptTag(branding)}</head>`)
        : null,
  };

  const missing: Slot['key'][] = [];
  let out = html;
  for (const key of SLOTS) {
    const next = apply[key](out);
    if (next === null) missing.push(key);
    else out = next;
  }
  return { html: out, missing };
}

let template: string | null = null;
let warnedMissing = false;

/**
 * The branded shell. Throws only if index.html is absent, which means the
 * image was assembled wrong - failing loudly is right there.
 */
export function renderIndexHtml(clientBuildDir: string): string {
  if (template === null) {
    template = readFileSync(join(clientBuildDir, 'index.html'), 'utf8');
  }
  const { html, missing } = injectBranding(template, getBranding());
  if (missing.length > 0 && !warnedMissing) {
    warnedMissing = true;
    console.warn(
      `[branding] index.html has no ${missing.join(', ')} tag - those values ` +
        `cannot be applied. The client build's <head> changed shape; see ` +
        `apps/email/server/src/lib/index-html.ts (GH-568).`,
    );
  }
  return html;
}
