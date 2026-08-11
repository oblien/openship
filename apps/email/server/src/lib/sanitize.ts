/**
 * Sanitize untrusted HTML email bodies before rendering them in the
 * client. The read pane injects the result with `shadowRoot.innerHTML`
 * in the app origin with no CSP, so this module is the only thing
 * standing between an inbound message and script execution: it must
 * handle XSS-class threats (script tags, on* attributes, javascript:
 * URLs) and it must not disagree with the browser about tree shape.
 *
 * `blockRemoteImages` implements the "block remote images" preference,
 * which is a privacy control rather than an XSS one.
 */

import * as cheerio from 'cheerio';
import sanitizeHtml from 'sanitize-html';

const ALLOWED_TAGS = [
  ...sanitizeHtml.defaults.allowedTags,
  'img',
  'span',
  'div',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
];

/**
 * Re-parse with parse5 (via cheerio) and re-serialize before sanitizing.
 *
 * sanitize-html parses with htmlparser2, which disagrees with the HTML
 * spec on several constructs. The one that mattered: in RAWTEXT content
 * `</style/` is a valid end tag to a browser but not to htmlparser2, so
 * a sender could write `<style></style/><img src=x onerror=...>` and
 * htmlparser2 would treat the payload as inert CSS text and emit it
 * verbatim — while the browser closed <style> and ran it. Foreign
 * content (<svg>, <math>) and mis-nesting have the same failure mode.
 *
 * parse5 is spec-compliant, so normalizing first guarantees the
 * sanitizer inspects the same tree the browser will build. Keep this in
 * front of every sanitize call; dropping `style` from ALLOWED_TAGS
 * closes the known payload, this closes the class.
 */
function normalizeToSpecTree(input: string): string {
  return cheerio.load(input, null, false).html();
}

export function sanitizeMailHtml(input: string): string {
  return sanitizeHtml(normalizeToSpecTree(input), {
    allowedTags: ALLOWED_TAGS,
    allowedAttributes: {
      '*': ['style', 'class', 'id', 'align', 'width', 'height', 'bgcolor'],
      a: ['href', 'name', 'target', 'rel'],
      img: ['src', 'srcset', 'alt', 'title', 'width', 'height'],
    },
    // `cid:`/`data:` are how inline attachment images arrive, so they stay for
    // src. A link never needs them: `data:text/html` in an href is a navigable
    // XSS primitive (browsers block top-level data: today, but that is their
    // mitigation, not ours) and `cid:` in an href is meaningless.
    allowedSchemes: ['http', 'https', 'mailto', 'cid', 'data'],
    allowedSchemesByTag: { a: ['http', 'https', 'mailto'] },
    allowProtocolRelative: false,
    transformTags: {
      a: (tagName, attribs) => ({
        tagName,
        attribs: { ...attribs, target: '_blank', rel: 'noopener noreferrer' },
      }),
    },
  });
}

const TRANSPARENT_GIF =
  'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==';

// Anything that leaves the machine on render. `cid:` (inline attachment)
// and `data:` stay - they cost the sender no signal.
const REMOTE_URL = /^(?:https?:)?\/\//i;
const CSS_URL = /url\(\s*(['"]?)([^'")]*)\1\s*\)/gi;

function stripRemoteCssUrls(css: string): string {
  return css.replace(CSS_URL, (match, _quote, url: string) =>
    REMOTE_URL.test(url.trim()) ? 'none' : match,
  );
}

function hasRemoteCandidate(srcset: string): boolean {
  return srcset
    .split(',')
    .some((candidate) => REMOTE_URL.test((candidate.trim().split(/\s+/)[0] ?? '').trim()));
}

/**
 * Neutralize every remote fetch a message body can trigger, for the
 * "block remote images" preference. Regex over `<img src>` alone is not
 * enough - `srcset` and CSS `url()` in a style attribute both fetch, and
 * both used to load with the setting on and no warning banner, handing
 * the sender the reader's IP, user-agent and open time.
 *
 * Expects already-sanitized HTML: it re-parses, so it must not be the
 * thing deciding what tags are safe.
 */
export function blockRemoteImages(html: string): { html: string; blocked: boolean } {
  const $ = cheerio.load(html, null, false);
  let blocked = false;

  $('img').each((_i, el) => {
    const img = $(el);

    const src = img.attr('src');
    if (src && REMOTE_URL.test(src.trim())) {
      img.attr('src', TRANSPARENT_GIF);
      blocked = true;
    }

    const srcset = img.attr('srcset');
    if (srcset && hasRemoteCandidate(srcset)) {
      img.removeAttr('srcset');
      blocked = true;
    }
  });

  $('[style]').each((_i, el) => {
    const node = $(el);
    const style = node.attr('style') ?? '';
    const stripped = stripRemoteCssUrls(style);
    if (stripped !== style) {
      node.attr('style', stripped);
      blocked = true;
    }
  });

  return { html: $.html(), blocked };
}
