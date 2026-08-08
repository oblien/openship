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

// `\75 rl(…)`, `@\69 mport` and `image\2dset(` are valid spellings of
// `url(` / `@import` / `image-set(`. Decode only escapes of ASCII
// alphanumerics and `-` — the characters that spell a fetch construct's
// ident; decoding an escaped quote would corrupt its string, and an escaped
// alnum or hyphen means the same character in an ident and in a string.
const CSS_ESCAPE = /\\([0-9a-f]{1,6})(?:\r\n|[ \t\r\n\f])?|\\([^\r\n\f0-9a-f])/gi;

function decodeCssEscapes(css: string): string {
  return css.replace(CSS_ESCAPE, (match, hex?: string, ch?: string) => {
    // Range-check before fromCharCode: it masks to 16 bits, so a huge escape
    // like \10041 must not alias down to 'A'.
    const cp = hex !== undefined ? parseInt(hex, 16) : -1;
    const decoded =
      cp === 0x2d || (cp >= 0x30 && cp <= 0x7a) ? String.fromCharCode(cp) : ch ?? '';
    return /^[0-9a-z-]$/i.test(decoded) ? decoded : match;
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
// so `@import "a;b"` leaves no trailing garbage. The scan skips string
// contents — `content:"@import"` is a string token, not an at-keyword.
function stripImports(css: string): string {
  const lower = css.toLowerCase();
  let out = '';
  let copyFrom = 0;
  let i = 0;
  while (i < css.length) {
    const c = css[i];
    if (c === '"' || c === "'") {
      for (i++; i < css.length && css[i] !== c; i++);
      i++;
    } else if (
      c === '@' &&
      lower.startsWith('@import', i) &&
      // `-` continues a CSS ident: `@import-fake` is a different at-keyword.
      !/[\w-]/.test(css[i + 7] ?? '')
    ) {
      out += css.slice(copyFrom, i);
      copyFrom = i = importEnd(css, i + 7);
    } else {
      i++;
    }
  }
  return out + css.slice(copyFrom);
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
// `#` is exempt because a fragment-only reference (`fill:url(#grad)`) is a
// same-document lookup, never a fetch. The closing paren is optional because
// an unterminated url token at end of input still fetches.
const CSS_REMOTE_URL = new RegExp(
  String.raw`url\((?![\s'"]*(?:${INLINE_SCHEMES}|#))[^)]*\)?`,
  'gi',
);

// Inside image-set(…) a bare string is a URL — `image-set("https://…" 1x)`
// fetches with no `url(` token — so rewrite non-inline strings in the span.
// The span must be found with a quote-aware scan to its balancing paren:
// `;`, `{`, `}` are ordinary characters inside a string token, so ending the
// span at one of them (as a regex must) truncates it before a remote
// candidate — `image-set("data:…;base64,…" 1x, "https://…" 2x)` would leak.
// Escape decoding above has already normalized `image\2dset(`.
function stripImageSets(css: string): string {
  const lower = css.toLowerCase();
  let out = '';
  let copyFrom = 0;
  let i = 0;
  while (i < css.length) {
    const c = css[i];
    if (c === '"' || c === "'") {
      for (i++; i < css.length && css[i] !== c; i++);
      i++;
      continue;
    }
    const prefixed = lower.startsWith('-webkit-image-set(', i);
    if (
      (prefixed || lower.startsWith('image-set(', i)) &&
      !/[\w-]/.test(css[i - 1] ?? '')
    ) {
      const open = i + (prefixed ? 18 : 10);
      const end = spanEnd(css, open);
      out += css.slice(copyFrom, open) + rewriteSpanStrings(css.slice(open, end));
      copyFrom = i = end;
      continue;
    }
    i++;
  }
  return out + css.slice(copyFrom);
}

// Index just past the paren balancing an open one at `i`, quote-aware;
// end of input if unbalanced.
function spanEnd(css: string, i: number): number {
  let depth = 1;
  while (i < css.length) {
    const c = css[i];
    if (c === '"' || c === "'") {
      for (i++; i < css.length && css[i] !== c; i++);
    } else if (c === '(') {
      depth++;
    } else if (c === ')' && --depth === 0) {
      return i + 1;
    }
    i++;
  }
  return i;
}

// Replace each non-inline string token in an image-set span with an inert
// data: URL. Sequential token scan, not a regex: a regex re-anchors on the
// closing quote of an exempt string and eats the text between two data:
// strings.
function rewriteSpanStrings(span: string): string {
  let out = '';
  let i = 0;
  while (i < span.length) {
    const q = span[i];
    if (q !== '"' && q !== "'") {
      out += q;
      i++;
      continue;
    }
    let close = i + 1;
    while (close < span.length && span[close] !== q) close++;
    const content = span.slice(i + 1, close);
    out += INLINE_URL.test(content) ? span.slice(i, close + 1) : '"data:,"';
    i = close + 1;
  }
  return out;
}

// Returns undefined when the CSS fetches nothing, so callers keep the
// original text and don't report blocking for CSS that merely needed
// normalizing (comments, escapes). Every fetch construct — even comment-split
// or escaped — contains a literal `(`, `@`, or `\`, so their absence is a
// cheap proof there is nothing to block.
function stripRemoteCss(css: string): string | undefined {
  if (!/[(@\\]/.test(css)) return undefined;
  const normalized = decodeCssEscapes(stripCssComments(css));
  const out = stripImageSets(stripImports(normalized).replace(CSS_REMOTE_URL, 'none'));
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
//
// Walks the tag's attributes sequentially rather than regexing `src=` out of
// the raw tag text: a decoy like `alt="x src='data:,'"` would otherwise
// satisfy a src pattern first (attribute values keep raw single quotes) and
// shield the real remote src from inspection.
function blockImgTag(tag: string): string | undefined {
  const attr = /([^\s"'<>\/=]+)(\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'`<>]*))?/g;
  attr.lastIndex = 4; // past `<img`
  let changed = false;
  let out = '';
  let copyFrom = 0;
  for (let m = attr.exec(tag); m !== null; m = attr.exec(tag)) {
    if (m[2] === undefined) continue;
    const name = m[1].toLowerCase();
    if (name !== 'src' && name !== 'srcset') continue;
    const rawValue = m[2].replace(/^\s*=\s*/, '');
    const value = /^["']/.test(rawValue) ? rawValue.slice(1, -1) : rawValue;
    if (name === 'src' && !INLINE_URL.test(value.trimStart())) {
      changed = true;
      out += tag.slice(copyFrom, m.index) + `src="${BLOCKED_PIXEL}"`;
      copyFrom = m.index + m[0].length;
    } else if (name === 'srcset' && srcsetHasRemote(value)) {
      changed = true;
      out += tag.slice(copyFrom, m.index).replace(/\s+$/, ' ');
      copyFrom = m.index + m[0].length;
    }
  }
  return changed ? out + tag.slice(copyFrom) : undefined;
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
