import { describe, expect, it } from "vitest";

import { sanitizeMailHtml } from "../src/lib/sanitize";

describe("sanitizeMailHtml", () => {
  it("removes script tags even inside deeply nested allowed markup", () => {
    const input = "<div><section><p><script>alert(1)</script>safe</p></section></div>";

    expect(sanitizeMailHtml(input)).toBe("<div><section><p>safe</p></section></div>");
  });

  it("removes event handlers despite mixed casing and whitespace", () => {
    const input =
      '<div OnClIcK = "alert(1)" oNerror = "alert(2)" oNLoAd = "alert(3)" data-ok="yes">safe</div>';

    expect(sanitizeMailHtml(input)).toBe("<div>safe</div>");
  });

  it("removes the classic image XSS shape and keeps no event attributes", () => {
    const input =
      '<img src=x onerror=alert(1)><IMG sRc="javascript:alert(1)" OnErRoR = "alert(2)" alt="picture">';

    expect(sanitizeMailHtml(input)).toBe('<img src="x" /><img alt="picture" />');
  });

  it("closes unclosed hostile markup and normalizes mixed-case tags", () => {
    // sanitize-html repairs unclosed tags and lowercases tag names before output.
    expect(sanitizeMailHtml("<DiV><SpAn>unclosed")).toBe("<div><span>unclosed</span></div>");
  });

  it("removes javascript URLs from links", () => {
    expect(sanitizeMailHtml('<a href="javascript:alert(1)">x</a>')).toBe(
      '<a target="_blank" rel="noopener noreferrer">x</a>',
    );
  });

  it("removes mixed-case, entity-encoded, and control-whitespace javascript URLs", () => {
    const urls = [
      "JaVaScRiPt:alert(1)",
      "jav&#x61;script:alert(1)",
      ` java${String.fromCharCode(10)}script:alert(1) `,
      `java${String.fromCharCode(9)}script:alert(1)`,
      `jav${String.fromCharCode(0)}ascript:alert(1)`,
    ];

    for (const url of urls) {
      expect(sanitizeMailHtml(`<a href="${url}">x</a>`)).toBe(
        '<a target="_blank" rel="noopener noreferrer">x</a>',
      );
    }
  });

  it("keeps the configured http, https, mailto, cid, and data schemes", () => {
    const input =
      '<a href="http://example.com">http</a>' +
      '<a href="https://example.com">https</a>' +
      '<a href="mailto:a@example.com">mail</a>' +
      '<a href="cid:part1@example.com">cid</a>' +
      '<img src="cid:part1@example.com">' +
      '<img src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==">';

    expect(sanitizeMailHtml(input)).toBe(
      '<a href="http://example.com" target="_blank" rel="noopener noreferrer">http</a>' +
        '<a href="https://example.com" target="_blank" rel="noopener noreferrer">https</a>' +
        '<a href="mailto:a@example.com" target="_blank" rel="noopener noreferrer">mail</a>' +
        '<a href="cid:part1@example.com" target="_blank" rel="noopener noreferrer">cid</a>' +
        '<img src="cid:part1@example.com" />' +
        '<img src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==" />',
    );
  });

  it("drops protocol-relative URLs", () => {
    expect(sanitizeMailHtml('<a href="//example.com/path">x</a>')).toBe(
      '<a target="_blank" rel="noopener noreferrer">x</a>',
    );
  });

  it("overrides caller-supplied target and rel values", () => {
    const input = '<a href="https://example.com" target="_self" rel="nofollow">x</a>';

    expect(sanitizeMailHtml(input)).toBe(
      '<a href="https://example.com" target="_blank" rel="noopener noreferrer">x</a>',
    );
  });

  it("matches sanitize-html behavior for malformed and obfuscated URLs", () => {
    // An unquoted space ends the href value in sanitize-html's HTML parser;
    // the remaining text is not folded back into a javascript scheme.
    expect(sanitizeMailHtml("<a href=java script:alert(1)>x</a>")).toBe(
      '<a href="java" target="_blank" rel="noopener noreferrer">x</a>',
    );

    // sanitize-html decodes character entities before checking the scheme,
    // so this obfuscated javascript URL is removed.
    expect(
      sanitizeMailHtml(
        '<a href="&#x6a;&#x61;&#x76;&#x61;&#x73;&#x63;&#x72;&#x69;&#x70;&#x74;:alert(1)">x</a>',
      ),
    ).toBe('<a target="_blank" rel="noopener noreferrer">x</a>');

    // The current scheme check does not decode a percent-encoded colon. It
    // therefore preserves this value; keep this assertion tied to current
    // sanitize-html behavior rather than treating it as a new allow-list rule.
    expect(sanitizeMailHtml('<a href="JaVaScRiPt%3Aalert(1)">x</a>')).toBe(
      '<a href="JaVaScRiPt%3Aalert(1)" target="_blank" rel="noopener noreferrer">x</a>',
    );
  });

  it("retains style tags and inline style as current behavior", () => {
    // sanitize.ts intentionally allows style. sanitize-html warns that this
    // is inherently risky, and it currently retains javascript: in CSS text.
    const input =
      '<p style="color:red; background: url(javascript:alert(1))">x</p>' +
      "<style>.x { color: red }</style>";

    expect(sanitizeMailHtml(input)).toBe(
      '<p style="color:red;background:url(javascript:alert(1))">x</p>' +
        "<style>.x { color: red }</style>",
    );
  });

  it("handles empty input and plain text without throwing", () => {
    expect(sanitizeMailHtml("")).toBe("");
    expect(sanitizeMailHtml("plain text")).toBe("plain text");
    // Text containing an ampersand is escaped as HTML, even without tags.
    expect(sanitizeMailHtml("plain & text")).toBe("plain &amp; text");
  });
});
