/** Render server-sanitized HTML only. This function is not an HTML sanitizer. */
export function renderSanitizedMailHtml(root: ShadowRoot, html: string) {
  const document = root.ownerDocument;
  const style = document.createElement("style");
  // Shadow roots isolate selectors, but still inherit text colors from the app.
  // Give the message its own paired defaults; sender inline styles take priority.
  style.textContent = `
    :host, :host * {
      font-family: 'Gellix', 'SF Arabic', -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
    }
    :host > .mail-document {
      display: flow-root;
      color: #1a1a1a;
      background-color: #fff;
      color-scheme: only light;
    }
  `;
  const content = document.createElement("div");
  content.className = "mail-document";
  content.innerHTML = html;
  root.replaceChildren(style, content);
}
