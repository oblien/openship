import { afterEach, describe, expect, it } from "bun:test";
import { Window } from "happy-dom";
import { buildMailPrintDocument, printMailMessages } from "./mail-print";

type Message = Parameters<typeof buildMailPrintDocument>[0][number];
const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
let browser: Window | undefined;
function fixture() {
  browser = new Window();
  Object.defineProperty(globalThis, "document", { configurable: true, value: browser.document });
  return browser;
}
afterEach(async () => {
  if (originalDocument) Object.defineProperty(globalThis, "document", originalDocument);
  else Reflect.deleteProperty(globalThis, "document");
  await browser?.happyDOM.close();
});
const message = (text: string): Message => ({
  subject: text,
  sender: { name: text, email: text },
  to: [{ name: text, email: text }],
  cc: [{ name: text, email: text }],
  bcc: [{ name: text, email: text }],
  receivedOn: text,
  tags: [{ id: "tag", name: text, type: "user" }],
  decodedBody: "",
  attachments: [
    {
      attachmentId: "a",
      filename: text,
      mimeType: "text/plain",
      size: 2048,
      body: "",
      headers: [],
    },
  ],
});

describe("mail printing", () => {
  it("renders hostile subjects, envelope fields, labels, dates and filenames as literal text", () => {
    const window = fixture();
    const payload =
      '</title><script>parent.injected=true</script><img src=x onerror="parent.injected=true">';
    const doc = new window.DOMParser().parseFromString(
      buildMailPrintDocument([message(payload)]),
      "text/html",
    );
    expect(doc.querySelector("script, img, iframe, object")).toBeNull();
    expect(doc.title).toBe(`Print Email - ${payload}`);
    expect(doc.querySelector(".email-title")?.textContent).toBe(payload);
    expect(doc.querySelector(".label-badge")?.textContent).toBe(payload);
    expect(doc.querySelector(".attachment-name")?.textContent).toBe(payload);
    const values = [...doc.querySelectorAll(".meta-value")].map((node) => node.textContent);
    expect(values).toEqual([...Array(4).fill(`${payload} <${payload}>`), payload]);
  });

  it("preserves literal Unicode, punctuation and thread order without double escaping", () => {
    const window = fixture();
    const first = message('رسالة <Finance> & "Q4"');
    const second = message("Follow-up");
    const doc = new window.DOMParser().parseFromString(
      buildMailPrintDocument([first, second]),
      "text/html",
    );
    expect(doc.querySelectorAll(".email-container")).toHaveLength(2);
    expect(doc.querySelector(".email-title")?.textContent).toBe(first.subject);
    expect([...doc.querySelectorAll(".attachment-name")].map((node) => node.textContent)).toEqual([
      first.subject,
      second.subject,
    ]);
    expect(
      doc.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute("content"),
    ).toContain("script-src 'none'");
  });

  it("uses a script-disabled frame for both print entry points", () => {
    const window = fixture();
    printMailMessages([message("Single message")]);
    printMailMessages([message("First"), message("Second")], "Thread");
    const frames = [...window.document.querySelectorAll("iframe")];
    expect(frames).toHaveLength(2);
    for (const frame of frames) {
      expect(frame.getAttribute("sandbox")?.split(" ").sort()).toEqual([
        "allow-modals",
        "allow-same-origin",
      ]);
      expect(frame.srcdoc).toContain("script-src 'none'");
      expect(frame.onload).toBeTypeOf("function");
      frame.onload = null;
    }
    expect(frames[1].srcdoc).toContain("<title>Print Email - Thread</title>");
  });

  it("does not create an empty print frame", () => {
    const window = fixture();
    printMailMessages([]);
    expect(window.document.querySelector("iframe")).toBeNull();
  });
});
