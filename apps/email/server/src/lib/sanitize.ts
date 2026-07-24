/**
 * Sanitize untrusted HTML email bodies before rendering them in the
 * client. The client already strips remote images when the
 * `externalImages` preference is off; this layer handles XSS-class
 * threats (script tags, on* attributes, javascript: URLs).
 */

import sanitizeHtml from 'sanitize-html';

const ALLOWED_TAGS = [
  ...sanitizeHtml.defaults.allowedTags,
  'img',
  'style',
  'span',
  'div',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
];

export function sanitizeMailHtml(input: string): string {
  return sanitizeHtml(input, {
    allowedTags: ALLOWED_TAGS,
    allowedAttributes: {
      '*': ['style', 'class', 'id', 'align', 'width', 'height', 'bgcolor'],
      a: ['href', 'name', 'target', 'rel'],
      img: ['src', 'srcset', 'alt', 'title', 'width', 'height'],
    },
    allowedSchemes: ['http', 'https', 'mailto', 'cid', 'data'],
    allowProtocolRelative: false,
    transformTags: {
      a: (tagName, attribs) => ({
        tagName,
        attribs: { ...attribs, target: '_blank', rel: 'noopener noreferrer' },
      }),
    },
  });
}

/* ─── Remote content blocking ──────────────────────────────────────────── */
/*
 * With "load remote images" off, nothing in the message may cause a network
 * fetch — `<img src>` alone never covered that: `srcset`, `background:
 * url(…)`, `@import` and `image-set()` all fetch too, and each is enough to
 * collect a read receipt.
 *
 * Input contract: already through `sanitizeMailHtml`. sanitize-html balances
 * tags, deduplicates attributes, and re-encodes only `&amp; &lt; &gt; &quot;`
 * in attribute values — the attribute handling below relies on that.
 *
 * `<style>` bodies reach this code raw, so the comment and @import passes are
 * linear scanners: the natural regexes backtrack quadratically on crafted
 * input (`/*a/*a…`, `@import url(url(…`), a denial-of-service lever server-side.
 */

// data: is self-contained and cid: is already delivered — neither leaves the
// client, which is what keeps inline attachments rendering while blocked.
// Single definition so the img, srcset, and CSS passes can't drift.
const INLINE_SCHEMES = 'data:|cid:';
const INLINE_URL = new RegExp(`^(?:${INLINE_SCHEMES})`, 'i');

// `\75 rl(…)` and `@\69 mport` are valid spellings of `url(` / `@import`.
// Decode only escapes of ASCII alphanumerics: those are what spell a fetch
// construct, and decoding an escaped quote would corrupt its string.
const CSS_ESCAPE = /\\([0-9a-f]{1,6})(?:\r\n|[ \t\r\n\f])?|\\([^\r\n\f0-9a-f])/gi;

function decodeCssEscapes(css: string): string {
  return css.replace(CSS_ESCAPE, (match, hex?: string, ch?: string) => {
    // Range-check before fromCharCode: it masks to 16 bits, so a huge escape
    // like \10041 must not alias down to 'A'.
    const cp = hex !== undefined ? parseInt(hex, 16) : -1;
    const decoded = cp >= 0x30 && cp <= 0x7a ? String.fromCharCode(cp) : ch ?? '';
    return /^[0-9a-z]$/i.test(decoded) ? decoded : match;
  });
}

// A comment is whitespace to the CSS tokenizer, so replace with a space —
// otherwise `url(/*x*/https://…)` hides the fetch from the patterns below.
// An unterminated comment runs to end of input, per spec.
function stripCssComments(css: string): string {
  let out = '';
  let i = 0;
  while (true) {
    const open = css.indexOf('/*', i);
    if (open === -1) return out + css.slice(i);
    out += css.slice(i, open) + ' ';
    const close = css.indexOf('*/', open + 2);
    if (close === -1) return out;
    i = close + 2;
  }
}

// An import exists only to fetch, so drop the whole statement: to the first
// `;` (consumed) or `}` (kept, it closes the block) outside quotes/parens,
// so `@import "a;b"` leaves no trailing garbage.
function stripImports(css: string): string {
  const lower = css.toLowerCase();
  let out = '';
  let copyFrom = 0;
  let search = 0;
  while (true) {
    const at = lower.indexOf('@import', search);
    if (at === -1) return out + css.slice(copyFrom);
    // `-` continues a CSS ident: `@import-fake` is a different at-keyword.
    if (/[\w-]/.test(css[at + 7] ?? '')) {
      search = at + 7;
      continue;
    }
    out += css.slice(copyFrom, at);
    copyFrom = search = importEnd(css, at + 7);
  }
}

function importEnd(css: string, i: number): number {
  while (i < css.length) {
    const c = css[i];
    if (c === '"' || c === "'") {
      for (i++; i < css.length && css[i] !== c; i++);
      i++;
    } else if (c === '(') {
      for (i++; i < css.length && css[i] !== ')'; i++);
      i++;
    } else if (c === ';') {
      return i + 1;
    } else if (c === '}') {
      return i;
    } else {
      i++;
    }
  }
  return i;
}

// Non-inline url(…) → `none`, keeping the rest of the declaration valid:
// `background: red url(x) no-repeat` → `background: red none no-repeat`.
// The lookahead skips quotes/whitespace so `url("data:…")` counts as inline;
// the closing paren is optional because an unterminated url token at end of
// input still fetches.
const CSS_REMOTE_URL = new RegExp(String.raw`url\((?![\s'"]*(?:${INLINE_SCHEMES}))[^)]*\)?`, 'gi');

// Inside image-set(…) a bare string is a URL — `image-set("https://…" 1x)`
// fetches with no `url(` token — so rewrite non-inline strings in the span.
const CSS_IMAGE_SET = /(?<![\w-])(?:-webkit-)?image-set\([^;{}]*/gi;
const CSS_REMOTE_STRING = new RegExp(String.raw`(['"])(?!(?:${INLINE_SCHEMES}))[^'"]*\1`, 'gi');

// Returns undefined when the CSS fetches nothing, so callers keep the
// original text and don't report blocking for CSS that merely needed
// normalizing (comments, escapes). Every fetch construct — even comment-split
// or escaped — contains a literal `(`, `@`, or `\`, so their absence is a
// cheap proof there is nothing to block.
function stripRemoteCss(css: string): string | undefined {
  if (!/[(@\\]/.test(css)) return undefined;
  const normalized = decodeCssEscapes(stripCssComments(css));
  const out = stripImports(normalized)
    .replace(CSS_REMOTE_URL, 'none')
    .replace(CSS_IMAGE_SET, (span) => span.replace(CSS_REMOTE_STRING, '"data:,"'));
  return out === normalized ? undefined : out;
}

// The browser parses the decoded attribute text (`url(&quot;data:…&quot;)`
// is `url("data:…")` to the CSS engine), so match on the decoded form. Only
// the four entities sanitize-html emits need handling — see contract above.
const DECODE: Record<string, string> = { '&quot;': '"', '&amp;': '&', '&lt;': '<', '&gt;': '>' };
const ENCODE: Record<string, string> = { '"': '&quot;', '&': '&amp;', '<': '&lt;', '>': '&gt;' };

const STYLE_ELEMENT = /(<style\b[^>]*>)([\s\S]*?)(<\/style>)/gi;
const STYLE_ATTRIBUTE = /(\sstyle\s*=\s*)(?:"([^"]*)"|'([^']*)')/gi;

// srcset candidates can't be found by splitting on commas — data: URLs
// contain commas — so follow the HTML parse: URL = non-whitespace run after
// skipping whitespace/commas, descriptor runs to the next comma, and a URL
// ending in a comma has no descriptor.
function srcsetHasRemote(srcset: string): boolean {
  const space = (c: number) => c === 0x20 || (c >= 0x09 && c <= 0x0d);
  let i = 0;
  while (i < srcset.length) {
    while (i < srcset.length && (space(srcset.charCodeAt(i)) || srcset[i] === ',')) i++;
    if (i >= srcset.length) break;
    const start = i;
    while (i < srcset.length && !space(srcset.charCodeAt(i))) i++;
    const run = srcset.slice(start, i);
    const url = run.replace(/,+$/, '');
    if (url && !INLINE_URL.test(url)) return true;
    if (!run.endsWith(',')) while (i < srcset.length && srcset[i] !== ',') i++;
  }
  return false;
}

const BLOCKED_PIXEL =
  'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==';

// Returns undefined when the tag was already fetch-free. A srcset with any
// remote candidate is dropped whole — srcset outranks src in the browser, so
// leaving it would undo the src rewrite, and a srcset of placeholder pixels
// has no value once the src fallback takes over.
function blockImgTag(tag: string): string | undefined {
  let changed = false;
  const out = tag
    .replace(/\s+srcset\s*=\s*(?:"([^"]*)"|'([^']*)')/gi, (m, dq?: string, sq?: string) => {
      if (!srcsetHasRemote(dq ?? sq ?? '')) return m;
      changed = true;
      return '';
    })
    .replace(/(\bsrc\s*=\s*)("[^"]*"|'[^']*')/i, (m, pre: string, quoted: string) => {
      if (INLINE_URL.test(quoted.slice(1).trimStart())) return m;
      changed = true;
      return `${pre}"${BLOCKED_PIXEL}"`;
    });
  return changed ? out : undefined;
}

/**
 * Block every remote-fetching construct in a sanitized email body — `<img>`
 * src/srcset, and `url()`/`@import`/`image-set()` in `<style>` bodies and
 * `style` attributes. The one entry point for the "load remote images"
 * preference: new fetch surfaces belong here, not in the route. Only fetching
 * constructs are touched, so colours, fonts and layout survive and ordinary
 * mail renders unchanged. `blocked` drives the "remote content blocked"
 * notice.
 */
export function blockRemoteContent(html: string): { html: string; blocked: boolean } {
  let blocked = false;
  const mark = <T>(replacement: T): T => {
    blocked = true;
    return replacement;
  };

  const out = html
    .replace(/<img\b[^>]*>/gi, (tag) => {
      const rewritten = blockImgTag(tag);
      return rewritten === undefined ? tag : mark(rewritten);
    })
    .replace(STYLE_ELEMENT, (match, open: string, css: string, close: string) => {
      const stripped = stripRemoteCss(css);
      return stripped === undefined ? match : mark(`${open}${stripped}${close}`);
    })
    .replace(STYLE_ATTRIBUTE, (match, prefix: string, dq?: string, sq?: string) => {
      const decoded = (dq ?? sq ?? '').replace(/&(?:quot|amp|lt|gt);/g, (m) => DECODE[m]);
      const stripped = stripRemoteCss(decoded);
      if (stripped === undefined) return match;
      // Re-emitting double-quoted is safe: under the input contract any `"`
      // arrived entity-encoded and is re-encoded here.
      return mark(`${prefix}"${stripped.replace(/[&"<>]/g, (c) => ENCODE[c])}"`);
    });

  return { html: out, blocked };
}
