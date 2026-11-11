import { format } from "date-fns";
import type { ParsedMessage, Sender } from "@/types";
import { cleanHtml } from "./email-utils";

type PrintMessage = Pick<
  ParsedMessage,
  "subject" | "sender" | "to" | "cc" | "bcc" | "receivedOn" | "tags" | "decodedBody" | "attachments"
>;

const PRINT_STYLES = `
* {
  margin: 0;
  padding: 0;
  box-sizing: border-box;
}

body {
  font-family: 'Gellix', 'SF Arabic', -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
  line-height: 1.5;
  color: #333;
  background: white;
  padding: 20px;
  font-size: 12px;
}

.email-container {
  max-width: 100%;
  margin: 0 auto;
  background: white;
}

.email-header {
  margin-bottom: 25px;
}

.email-title {
  font-size: 18px;
  font-weight: bold;
  color: #000;
  margin-bottom: 15px;
  word-wrap: break-word;
}

.email-meta {
  margin-bottom: 20px;
}

.meta-row {
  margin-bottom: 5px;
  display: flex;
  align-items: flex-start;
}

.meta-label {
  font-weight: bold;
  min-width: 60px;
  color: #333;
  margin-right: 10px;
}

.meta-value {
  flex: 1;
  word-wrap: break-word;
  color: #333;
}

.separator {
  width: 100%;
  height: 1px;
  background: #ddd;
  margin: 20px 0;
}

.email-body {
  margin: 20px 0;
  background: white;
}

.email-content {
  word-wrap: break-word;
  overflow-wrap: break-word;
  font-size: 12px;
  line-height: 1.6;
}

.email-content img {
  max-width: 100% !important;
  height: auto !important;
  display: block;
  margin: 10px 0;
}

.email-content table {
  width: 100%;
  border-collapse: collapse;
  margin: 10px 0;
}

.email-content td, .email-content th {
  padding: 6px;
  text-align: left;
  font-size: 11px;
}

.email-content a {
  color: #0066cc;
  text-decoration: underline;
}

.attachments-section {
  margin-top: 25px;
  background: white;
}

.attachments-title {
  font-size: 14px;
  font-weight: bold;
  color: #000;
  margin-bottom: 10px;
}

.attachment-item {
  margin-bottom: 5px;
  font-size: 11px;
  padding: 3px 0;
}

.attachment-name {
  font-weight: 500;
  color: #333;
}

.attachment-size {
  color: #666;
  font-size: 10px;
}

.labels-section {
  margin: 10px 0;
}

.label-badge {
  display: inline-block;
  padding: 2px 6px;
  background: #f5f5f5;
  color: #333;
  font-size: 10px;
  margin-right: 5px;
  margin-bottom: 3px;
}

@media print {
  body {
    margin: 0;
    padding: 15px;
    font-size: 11px;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }

  .email-container {
    max-width: none;
    width: 100%;
  }


  .separator {
    background: #000 !important;
  }

  .email-content a {
    color: #000 !important;
  }

  .label-badge {
    background: #f0f0f0 !important;
    border: 1px solid #ccc;
  }

  .no-print {
    display: none !important;
  }

  /* Remove any default borders */
  * {
    border: none !important;
    box-shadow: none !important;
  }

  /* Ensure clean page breaks */
  .email-header {
    page-break-after: avoid;
  }

  .attachments-section {
    page-break-inside: avoid;
  }
}

@page {
  margin: 0.5in;
  size: A4;
}
`;

/** Only the message body is HTML. All envelope and attachment fields are text. */
export function buildMailPrintDocument(
  messages: readonly PrintMessage[],
  subject?: string,
): string {
  const title = subject || messages[0]?.subject || "No Subject";
  const doc = document.implementation.createHTMLDocument();
  doc.title = `Print Email - ${title}`;
  const policy = doc.createElement("meta");
  policy.httpEquiv = "Content-Security-Policy";
  policy.content =
    "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data: blob: https: http:; base-uri 'none'; form-action 'none'";
  doc.head.prepend(policy);
  const style = doc.createElement("style");
  style.textContent = PRINT_STYLES;
  doc.head.append(style);

  function element(tag: string, className: string, text?: string) {
    const node = doc.createElement(tag);
    node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  const recipients = (values: readonly Sender[]) =>
    values.map((value) => (value.name ? `${value.name} <${value.email}>` : value.email)).join(", ");
  function row(label: string, value: string) {
    const node = element("div", "meta-row");
    node.append(element("span", "meta-label", label), element("span", "meta-value", value));
    return node;
  }

  for (const [index, message] of messages.entries()) {
    const container = element("div", "email-container");
    const header = element("div", "email-header");
    if (index === 0) header.append(element("h1", "email-title", title));
    if (message.tags?.length) {
      const labels = element("div", "labels-section");
      for (const tag of message.tags) labels.append(element("span", "label-badge", tag.name));
      header.append(labels);
    }
    const meta = element("div", "email-meta");
    if (message.sender) meta.append(row("From:", recipients([message.sender])));
    for (const [label, values] of [
      ["To:", message.to],
      ["CC:", message.cc],
      ["BCC:", message.bcc],
    ] as const) {
      if (values?.length) meta.append(row(label, recipients(values)));
    }
    const date = new Date(message.receivedOn);
    meta.append(
      row("Date:", Number.isNaN(date.getTime()) ? message.receivedOn : format(date, "PPpp")),
    );
    header.append(meta);
    const body = element("div", "email-body");
    const content = element("div", "email-content");
    content.innerHTML = cleanHtml(message.decodedBody ?? "");
    body.append(content);
    container.append(header, element("div", "separator"), body);
    if (message.attachments?.length) {
      const attachments = element("div", "attachments-section");
      attachments.append(
        element("h2", "attachments-title", `Attachments (${message.attachments.length})`),
      );
      for (const attachment of message.attachments) {
        const item = element("div", "attachment-item");
        item.append(element("span", "attachment-name", attachment.filename));
        const size = (attachment.size / (1024 * 1024)).toFixed(2);
        if (size !== "0.00") item.append(element("span", "attachment-size", ` - ${size} MB`));
        attachments.append(item);
      }
      container.append(attachments);
    }
    doc.body.append(container);
  }
  return "<!doctype html>" + doc.documentElement.outerHTML;
}

export function printMailMessages(messages: readonly PrintMessage[], subject?: string): void {
  if (!messages.length) return;
  const html = buildMailPrintDocument(messages, subject);
  const frame = document.createElement("iframe");
  // Parent access is needed to invoke native print. The child cannot run scripts,
  // navigate the top window, submit forms or open popups, even if sanitization fails.
  frame.setAttribute("sandbox", "allow-same-origin allow-modals");
  frame.style.cssText = "position:absolute;top:-9999px;left:-9999px;width:0;height:0;border:0";
  frame.onload = () => {
    frame.onload = null;
    const target = frame.contentWindow;
    if (!target) {
      frame.remove();
      return;
    }
    target.addEventListener("afterprint", () => frame.remove(), { once: true });
    try {
      target.focus();
      target.print();
    } catch (error) {
      frame.remove();
      console.error("Error during print:", error);
    }
  };
  frame.srcdoc = html;
  document.body.append(frame);
}
