/**
 * Sanitize untrusted HTML email bodies before rendering them in the
 * client. The read pane injects the result with `shadowRoot.innerHTML`
 * in the app origin with no CSP, so this module is the only thing
 * standing between an inbound message and script execution: it must
 * handle XSS-class threats (script tags, on* attributes, javascript:
 * URLs) and it must not disagree with the browser about tree shape.
 *
 * `blockRemoteContent` implements the "block remote images" preference,
 * which is a privacy control rather than an XSS one.
 */

import * as cheerio from 'cheerio';
import { generate, ident, parse, walk, type CssNode } from 'css-tree';
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

// Relative URLs also fetch, and CSS can escape any part of a URL. Only these
// schemes are self-contained; css-tree decodes CSS strings/URLs before this test.
const INLINE_URL = /^(?:data:|cid:)/i;
const isInlineUrl = (url: string) => INLINE_URL.test(url.replace(/^[\u0000-\u0020]+/, ''));

function stripRemoteCss(css: string): string {
  try {
    const ast = parse(css, { context: 'declarationList', parseCustomProperty: true });
    if (ast.type !== 'DeclarationList') return '';
    let blocked = false;
    ast.children.forEach((declaration, declarationItem, declarations) => {
      if (declaration.type !== 'Declaration') {
        declarations.remove(declarationItem);
        blocked = true;
        return;
      }
      let unparsed = false;
      walk(declaration.value, (node, item, list) => {
        if (node.type === 'Raw') unparsed = true;
        if (!item || !list) return;
        const replace = (replacement: CssNode) => {
          list.replace(item, list.createItem(replacement));
          blocked = true;
          return walk.skip;
        };
        if (node.type === 'Url' && !isInlineUrl(node.value) && !node.value.startsWith('#')) {
          return replace({ type: 'Identifier', name: 'none' });
        }
        if (node.type !== 'Function') return;
        const name = ident.decode(node.name).toLowerCase();
        // Escaped function names are Function nodes, not necessarily Url nodes.
        if (name === 'url' || name === 'src') {
          const args = node.children.toArray();
          if (args.length === 1 && args[0].type === 'String' && isInlineUrl(args[0].value)) {
            list.replace(item, list.createItem({ type: 'Url', value: args[0].value }));
            return walk.skip;
          }
          return replace({ type: 'Identifier', name: 'none' });
        }
        // Substitution can turn a seemingly inert custom-property string into an
        // image-set URL after this pass. Unresolved values cannot be certified
        // fetch-free on the server. Literal colors, spacing and layout survive.
        if (name === 'var' || name === 'attr') {
          return replace({ type: 'Identifier', name: 'none' });
        }
        if (name === 'image-set' || name === '-webkit-image-set' || name === 'image') {
          // Direct string arguments are image URLs. Nested type("image/png")
          // strings are MIME metadata, so do not rewrite those.
          node.children.forEach((argument) => {
            if (argument.type === 'String' && !isInlineUrl(argument.value)) {
              argument.value = 'data:,';
              blocked = true;
            }
          });
        }
      });
      if (unparsed) {
        declarations.remove(declarationItem);
        blocked = true;
      }
    });
    return blocked ? generate(ast) : css;
  } catch {
    // Do not pass syntax through when the parser cannot establish its meaning.
    return '';
  }
}

function hasRemoteCandidate(srcset: string): boolean {
  // A data URL may contain commas. Follow the HTML candidate boundary: a URL
  // is a non-whitespace run; descriptors extend to the next comma. Adapted from
  // #222, with the already-parsed attribute supplied by cheerio.
  const space = (code: number) => code === 0x20 || (code >= 0x09 && code <= 0x0d);
  let i = 0;
  while (i < srcset.length) {
    while (i < srcset.length && (space(srcset.charCodeAt(i)) || srcset[i] === ',')) i++;
    const start = i;
    while (i < srcset.length && !space(srcset.charCodeAt(i))) i++;
    const run = srcset.slice(start, i);
    const url = run.replace(/,+$/, '');
    if (url && !isInlineUrl(url)) return true;
    if (!run.endsWith(',')) while (i < srcset.length && srcset[i] !== ',') i++;
  }
  return false;
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
export function blockRemoteContent(html: string): { html: string; blocked: boolean } {
  const $ = cheerio.load(html, null, false);
  let blocked = false;

  $('img').each((_i, el) => {
    const img = $(el);

    const src = img.attr('src');
    if (src && !isInlineUrl(src)) {
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
    const stripped = stripRemoteCss(style);
    if (stripped !== style) {
      node.attr('style', stripped);
      blocked = true;
    }
  });

  return { html: $.html(), blocked };
}
