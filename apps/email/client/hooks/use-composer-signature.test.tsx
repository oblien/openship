import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Editor } from "@tiptap/core";
import { Window } from "happy-dom";
import { useComposerSignature } from "./use-composer-signature";

let browser: Window;
let root: Root;
let editor: Editor;
let body: string;
const globals = new Map<string, PropertyDescriptor | undefined>();
type Settings = { signature: string; signatureEnabled: boolean };
const signature: Settings = { signature: "<p><strong>Alex</strong></p>", signatureEnabled: true };

function Composer({
  settings,
  initialMessage = "",
  draftId,
}: {
  settings?: Settings;
  initialMessage?: string;
  draftId?: string;
}) {
  useComposerSignature(editor, settings, initialMessage, draftId);
  return null;
}

beforeEach(() => {
  browser = new Window();
  for (const [key, value] of Object.entries({
    window: browser,
    document: browser.document,
    navigator: browser.navigator,
    Node: browser.Node,
    HTMLElement: browser.HTMLElement,
    getComputedStyle: browser.getComputedStyle.bind(browser),
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    globals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  body = "";
  editor = {
    get state() {
      return { doc: { content: { size: body.length } } };
    },
    commands: {
      insertContentAt: (position: number, html: string) => {
        body = body.slice(0, position) + html + body.slice(position);
        return true;
      },
    },
  } as unknown as Editor;
  root = createRoot(document.createElement("div"));
});

afterEach(async () => {
  await act(async () => root.unmount());
  await browser.happyDOM.close();
  for (const [key, descriptor] of globals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  globals.clear();
});

async function render(props: Parameters<typeof Composer>[0]) {
  await act(async () => root.render(<Composer {...props} />));
}

describe("editable composer signatures", () => {
  it("inserts once when preferences arrive, preserving text already typed", async () => {
    await render({});
    body = "<p>Hello</p>";
    await render({ settings: signature });
    expect(body).toContain("<p>Hello</p>");
    expect(body).toContain("<strong>Alex</strong>");
    await render({ settings: { ...signature } });
    expect(body.match(/Alex/g)).toHaveLength(1);
    // Deleting the inserted signature is a user's choice, not an invitation to re-add it.
    body = "<p>Hello</p>";
    await render({ settings: { ...signature } });
    expect(body).toBe("<p>Hello</p>");
  });

  it("leaves a resumed draft exactly as saved", async () => {
    body = "<p>Saved body</p>";
    await render({ settings: signature, initialMessage: "<p>Saved body</p>", draftId: "draft-1" });
    expect(body).toBe("<p>Saved body</p>");
  });

  it("does not sign disabled preferences", async () => {
    await render({ settings: { ...signature, signatureEnabled: false } });
    expect(body).toBe("");
  });

  it("does not insert an empty signature", async () => {
    await render({ settings: { signature: "", signatureEnabled: true } });
    expect(body).toBe("");
  });

  it("does not add a signature to a supplied message body", async () => {
    body = "<p>Restored message</p>";
    await render({ settings: signature, initialMessage: "<p>Restored message</p>" });
    expect(body).toBe("<p>Restored message</p>");
  });
});
