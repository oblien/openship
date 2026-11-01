import { afterEach, beforeEach, expect, it, mock } from "bun:test";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import { Window } from "happy-dom";

let browser: Window;
let root: Root;
let container: HTMLElement;
let MailPanels: typeof import("./mail-panels").MailPanels;
// Bun selects the package's SSR entry. Exercise its real browser entry in happy-dom.
mock.module(
  "react-resizable-panels",
  () =>
    import(
      new URL(
        "../../node_modules/react-resizable-panels/dist/react-resizable-panels.browser.esm.js",
        import.meta.url,
      ).href
    ),
);

const globals = new Map<string, PropertyDescriptor | undefined>();

beforeEach(async () => {
  browser = new Window({ width: 1440, height: 900 });
  for (const [key, value] of Object.entries({
    window: browser,
    document: browser.document,
    navigator: browser.navigator,
    HTMLElement: browser.HTMLElement,
    KeyboardEvent: browser.KeyboardEvent,
    localStorage: browser.localStorage,
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    globals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  ({ MailPanels } = await import("./mail-panels"));
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  await browser.happyDOM.close();
  for (const [key, descriptor] of globals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  globals.clear();
});

async function render(hasThread = true) {
  await act(async () =>
    root.render(
      <MailPanels mailList={<p>Inbox</p>} readingPane={<p>Email body</p>} hasThread={hasThread} />,
    ),
  );
  // happy-dom initializes media-query change tracking only on the first resize.
  await act(async () => browser.dispatchEvent(new browser.Event("resize")));
}

function separator() {
  const handle = container.querySelector('[role="separator"]');
  if (!handle) throw new Error("Missing resize control");
  return handle;
}

async function press(key: string) {
  await act(async () =>
    separator().dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true })),
  );
}

it("resizes with the keyboard, keeps both panes usable, and restores the split after remount", async () => {
  await render();
  expect(separator().getAttribute("aria-label")).toBe("Resize email list and reading pane");
  expect(separator().getAttribute("aria-valuenow")).toBe("35");
  await press("Home");
  expect(separator().getAttribute("aria-valuenow")).toBe("20");
  await press("ArrowRight");
  expect(separator().getAttribute("aria-valuenow")).toBe("30");
  await press("End");
  expect(separator().getAttribute("aria-valuenow")).toBe("60");
  await new Promise((resolve) => setTimeout(resolve, 150));
  await act(async () => root.unmount());
  root = createRoot(container);
  await render(false);
  expect(separator().getAttribute("aria-valuenow")).toBe("60");
  expect(container.textContent).toContain("Email body");
});

it("uses the full tablet width for list or message and restores desktop widths across breakpoints", async () => {
  await render();
  await press("Home");
  await new Promise((resolve) => setTimeout(resolve, 150));
  await act(async () => {
    browser.happyDOM.setViewport({ width: 900, height: 900 });
  });
  await render(false);
  expect(container.querySelector('[role="separator"]') === null).toBe(true);
  expect(container.textContent).toBe("Inbox");
  expect(container.querySelector("[data-panel]")?.getAttribute("data-panel-size")).toBe("100.0");
  await render(true);
  expect(container.textContent).toBe("Email body");
  expect(container.querySelector("[data-panel]")?.getAttribute("data-panel-size")).toBe("100.0");
  await act(async () => {
    browser.happyDOM.setViewport({ width: 1440, height: 900 });
  });
  expect(separator().getAttribute("aria-valuenow")).toBe("20");
  await act(async () => {
    browser.happyDOM.setViewport({ width: 390, height: 844 });
  });
  expect(container.querySelector('[role="separator"]') === null).toBe(true);
  expect(container.textContent).toContain("Inbox");
  expect(container.querySelector(".fixed")?.textContent).toBe("Email body");
});
