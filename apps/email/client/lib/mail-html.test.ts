import { afterEach, describe, expect, it } from "bun:test";
import { Window, type Element as TestElement } from "happy-dom";
import Color from "color";
import { sanitizeMailHtml, blockRemoteContent } from "../../server/src/lib/sanitize";
import { renderSanitizedMailHtml } from "./mail-html";

let browser: Window | undefined;

afterEach(async () => {
  await browser?.happyDOM.close();
});

function render(html: string, theme: "light" | "dark") {
  browser = new Window();
  browser.document.body.style.cssText =
    theme === "dark"
      ? "color:#fff;background:#171717;color-scheme:dark"
      : "color:#111;background:#fff;color-scheme:light";
  const host = browser.document.createElement("div");
  browser.document.body.append(host);
  const root = host.attachShadow({ mode: "open" });
  renderSanitizedMailHtml(
    root as unknown as ShadowRoot,
    blockRemoteContent(sanitizeMailHtml(html)).html,
  );
  return {
    root,
    style: (element: TestElement) => {
      const computed = browser!.getComputedStyle(element);
      return {
        color: computed.color ? Color(computed.color).hex() : "",
        backgroundColor: computed.backgroundColor ? Color(computed.backgroundColor).hex() : "",
        colorScheme: computed.colorScheme,
      };
    },
  };
}

describe("message colors are independent of the surrounding webmail theme", () => {
  for (const theme of ["light", "dark"] as const) {
    it(`keeps inherited headings readable on a white card in ${theme} webmail`, () => {
      const { root, style } = render(
        '<table style="background:#fff"><tr><td><h1>Openship Support</h1>' +
          '<p style="color:#374151">New support request</p></td></tr></table>',
        theme,
      );
      expect(style(root.querySelector("h1")!).color).toBe("#1A1A1A");
      expect(style(root.querySelector("p")!).color).toBe("#374151");
      expect(style(root.querySelector("table")!).backgroundColor).toBe("#FFFFFF");
      expect(style(root.querySelector(".mail-document")!).colorScheme).toBe("only light");
    });

    it(`preserves a sender's dark document and inline button colors in ${theme} webmail`, () => {
      const { root, style } = render(
        '<html><body style="color:#eee;background:#222"><h1>Dark message</h1>' +
          '<a href="https://example.com" style="color:#fff;background:#000">Read more</a></body></html>',
        theme,
      );
      const heading = root.querySelector("h1")!;
      expect(style(heading).color).toBe("#EEEEEE");
      expect(style(heading.parentElement!).backgroundColor).toBe("#222222");
      expect(style(root.querySelector("a")!).color).toBe("#FFFFFF");
      expect(style(root.querySelector("a")!).backgroundColor).toBe("#000000");
    });

    it(`pairs unstyled text with its own canvas in ${theme} webmail`, () => {
      const { root, style } = render("<p>Hello</p>", theme);
      expect(style(root.querySelector("p")!).color).toBe("#1A1A1A");
      expect(style(root.querySelector(".mail-document")!).backgroundColor).toBe("#FFFFFF");
    });
  }

  it("replaces the previous message without accumulating wrappers or styles", () => {
    const { root } = render("<h1>Previous</h1>", "dark");
    renderSanitizedMailHtml(root as unknown as ShadowRoot, "<p>Next</p>");
    expect(root.querySelectorAll("style")).toHaveLength(1);
    expect(root.querySelectorAll(".mail-document")).toHaveLength(1);
    expect(root.textContent).not.toContain("Previous");
    expect(root.querySelector("p")!.textContent).toBe("Next");
  });
});
