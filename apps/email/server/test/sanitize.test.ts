import { describe, it, expect } from 'bun:test';
import { sanitizeMailHtml, blockRemoteImages } from '../src/lib/sanitize';

const TRANSPARENT_GIF =
  'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==';

// Anything that would execute or re-target the read pane. The pane injects
// sanitizer output with shadowRoot.innerHTML in the app origin and there is
// no CSP, so a match here is script execution, not a cosmetic bug.
function assertInert(html: string) {
  expect(html).not.toMatch(/<script/i);
  expect(html).not.toMatch(/<iframe/i);
  expect(html).not.toMatch(/<object|<embed|<base\b|<form\b|<svg|<math/i);
  expect(html).not.toMatch(/\son\w+\s*=/i);
  expect(html).not.toMatch(/javascript:/i);
}

describe('sanitizeMailHtml', () => {
  // GHSA-3hcp-c4c7-6m8p. htmlparser2 does not close <style> at `</style/`
  // but browsers do, so everything after it used to reach the DOM
  // completely unsanitized.
  describe('RAWTEXT end-tag confusion (GHSA-3hcp-c4c7-6m8p)', () => {
    it('neutralizes the reported payload', () => {
      const out = sanitizeMailHtml('<p>hi</p><style></style/><img src=x onerror=alert(1)></style>');

      expect(out).toContain('hi');
      expect(out).not.toContain('onerror');
      assertInert(out);
    });

    const reopeners = ['</style/', '</STYLE/', '</style/ ', '</style//', '</style/attr=1'];

    for (const reopener of reopeners) {
      it(`does not let \`${reopener}\` reopen the markup context`, () => {
        const payloads = [
          `<style>${reopener}><img src=x onerror=alert(1)></style>`,
          `<style>${reopener}><script>alert(1)</script></style>`,
          `<style>${reopener}><svg onload=alert(1)></style>`,
          `<style>${reopener}><iframe src="javascript:alert(1)"></style>`,
          `<style>${reopener}><base href="https://evil.tld/"></style>`,
          `<style>${reopener}><form action="https://evil.tld/"><input></form></style>`,
        ];

        for (const payload of payloads) {
          assertInert(sanitizeMailHtml(payload));
        }
      });
    }

    it('drops <style> blocks entirely rather than emitting their contents', () => {
      const out = sanitizeMailHtml('<style>div{color:red}</style><p>body</p>');

      expect(out).not.toContain('color:red');
      expect(out).not.toMatch(/<style/i);
      expect(out).toContain('body');
    });
  });

  describe('ordinary XSS vectors', () => {
    const vectors = [
      '<script>alert(1)</script>',
      '<img src=x onerror=alert(1)>',
      '<svg onload=alert(1)>',
      '<a href="javascript:alert(1)">x</a>',
      '<iframe src="javascript:alert(1)"></iframe>',
      '<body onload=alert(1)>',
      '<base href="https://evil.tld/">',
      '<form action="https://evil.tld/"><input name=p></form>',
      '<math><mtext><table><mglyph><style><img src=x onerror=alert(1)>',
      '<noscript><p title="</noscript><img src=x onerror=alert(1)>">',
      '<template><img src=x onerror=alert(1)></template>',
      '<xmp><img src=x onerror=alert(1)></xmp>',
    ];

    for (const vector of vectors) {
      it(`strips ${vector.slice(0, 44)}`, () => {
        assertInert(sanitizeMailHtml(vector));
      });
    }
  });

  describe('legitimate mail content survives', () => {
    it('keeps text, headings and inline styles', () => {
      const out = sanitizeMailHtml(
        '<h1>Title</h1><p style="color:#333">Hello <strong>you</strong></p>',
      );

      expect(out).toContain('<h1>Title</h1>');
      expect(out).toContain('color:#333');
      expect(out).toContain('<strong>you</strong>');
    });

    it('forces target/rel on links', () => {
      const out = sanitizeMailHtml('<a href="https://example.com">x</a>');

      expect(out).toContain('target="_blank"');
      expect(out).toContain('rel="noopener noreferrer"');
    });

    it('keeps inline (cid: and data:) attachment images', () => {
      expect(sanitizeMailHtml('<img src="cid:logo@1" alt="logo">')).toContain('cid:logo@1');
      expect(sanitizeMailHtml(`<img src="${TRANSPARENT_GIF}">`)).toContain('data:image/gif');
    });
  });

  // Inline images need cid:/data:, links do not - and data:text/html in an
  // href is navigable markup.
  describe('link schemes', () => {
    it('keeps http, https and mailto hrefs', () => {
      for (const href of ['https://example.com/a', 'http://example.com/a', 'mailto:x@example.com']) {
        expect(sanitizeMailHtml(`<a href="${href}">x</a>`)).toContain(href);
      }
    });

    it('drops data: and cid: hrefs while keeping the link text', () => {
      for (const href of ['data:text/html,<script>alert(1)</script>', 'cid:logo@1']) {
        const out = sanitizeMailHtml(`<a href="${href}">click</a>`);

        expect(out).toContain('click');
        expect(out).not.toContain('href=');
        assertInert(out);
      }
    });

    it('drops protocol-relative hrefs', () => {
      expect(sanitizeMailHtml('<a href="//evil.tld/x">x</a>')).not.toContain('evil.tld');
    });
  });

  it('is stable under repeated sanitization', () => {
    const once = sanitizeMailHtml('<p>hi</p><style></style/><img src=x onerror=alert(1)></style>');

    expect(sanitizeMailHtml(once)).toBe(once);
  });
});

describe('blockRemoteImages', () => {
  it('replaces remote <img src> and flags it', () => {
    const { html, blocked } = blockRemoteImages('<img src="https://tracker.tld/px.gif">');

    expect(blocked).toBe(true);
    expect(html).not.toContain('tracker.tld');
    expect(html).toContain('data:image/gif;base64,');
  });

  // Each of these fetched from the sender's server with the setting ON,
  // and left hasBlockedImages false so no banner was shown.
  it('blocks srcset', () => {
    const { html, blocked } = blockRemoteImages('<img srcset="https://tracker.tld/px.gif 1x">');

    expect(blocked).toBe(true);
    expect(html).not.toContain('tracker.tld');
  });

  it('blocks srcset even when src is also present', () => {
    const { html, blocked } = blockRemoteImages(
      '<img src="https://tracker.tld/a.gif" srcset="https://tracker.tld/b.gif 2x">',
    );

    expect(blocked).toBe(true);
    expect(html).not.toContain('tracker.tld');
  });

  it('blocks protocol-relative sources', () => {
    const { blocked, html } = blockRemoteImages('<img src="//tracker.tld/px.gif">');

    expect(blocked).toBe(true);
    expect(html).not.toContain('tracker.tld');
  });

  it('blocks remote url() in a style attribute', () => {
    const { html, blocked } = blockRemoteImages(
      `<div style="background:url('https://tracker.tld/px.gif') no-repeat">x</div>`,
    );

    expect(blocked).toBe(true);
    expect(html).not.toContain('tracker.tld');
    expect(html).toContain('no-repeat');
  });

  it('blocks bare and double-quoted url() forms', () => {
    // The double-quoted url() has to sit in a single-quoted attribute -
    // nesting the same quote is invalid HTML and the parser truncates it.
    for (const el of [
      `<div style="background-image:url(https://tracker.tld/px.gif)">x</div>`,
      `<div style='background-image:url("https://tracker.tld/px.gif")'>x</div>`,
      `<div style="background-image:url(//tracker.tld/px.gif)">x</div>`,
    ]) {
      const { html, blocked } = blockRemoteImages(el);

      expect(blocked).toBe(true);
      expect(html).not.toContain('tracker.tld');
    }
  });

  it('leaves local content alone and does not flag it', () => {
    const { html, blocked } = blockRemoteImages(
      '<img src="cid:logo@1"><div style="color:red">x</div>',
    );

    expect(blocked).toBe(false);
    expect(html).toContain('cid:logo@1');
    expect(html).toContain('color:red');
  });

  it('does not flag a body with no images at all', () => {
    expect(blockRemoteImages('<p>plain text</p>').blocked).toBe(false);
  });

  // The <style>-block leaks from the advisory (@import, background url())
  // are gone because sanitizeMailHtml no longer emits <style> at all.
  it('drops <style>-based trackers upstream in the sanitizer', () => {
    for (const payload of [
      '<style>div{background-image:url(https://tracker.tld/px.gif)}</style>',
      '<style>@import url(https://tracker.tld/x.css)</style>',
    ]) {
      expect(sanitizeMailHtml(payload)).not.toContain('tracker.tld');
    }
  });
});
