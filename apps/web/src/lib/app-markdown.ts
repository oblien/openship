import { Marked, Renderer } from "marked";
import { safeAppContentUrl } from "./app-content-url";

const escape = (text: string) =>
  text.replace(
    /[&<>"']/g,
    (value) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[value]!,
  );

/** Markdown may arrive in the published catalog. Never execute its HTML or URLs. */
export function renderAppArticle(markdown: string): string {
  const renderer = new Renderer();
  renderer.html = ({ text }) => escape(text);
  renderer.link = function ({ href, tokens }) {
    const label = this.parser.parseInline(tokens);
    const url = safeAppContentUrl(href, true);
    return url
      ? `<a href="${escape(url)}"${url.startsWith("http") ? ' target="_blank" rel="noopener noreferrer"' : ""}>${label}</a>`
      : label;
  };
  renderer.image = ({ href, text }) => {
    const url = safeAppContentUrl(href, true);
    return url
      ? `<img src="${escape(url)}" alt="${escape(text)}" loading="lazy" decoding="async">`
      : escape(text);
  };
  renderer.heading = function ({ depth, tokens }) {
    const level = Math.max(2, depth);
    return `<h${level}>${this.parser.parseInline(tokens)}</h${level}>\n`;
  };
  return new Marked({ gfm: true, renderer }).parse(markdown, { async: false });
}
