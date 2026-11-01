// @vitest-environment happy-dom

import { act, useState } from "react";
import { createPortal } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useTopologyFullscreen } from "./useTopologyFullscreen";

let host: HTMLDivElement;
let root: Root;
let originalOverflow: string;

function Workspace() {
  const [fullscreen, setFullscreen] = useState(false);
  const [dialog, setDialog] = useState(false);
  const { workspaceRef, toggleRef, trapFocus } = useTopologyFullscreen(fullscreen);
  return (
    <div>
      <aside data-sidebar>Project navigation</aside>
      <main style={{ overflow: "auto" }}>
        <header>Project header</header>
        <div>
          <div ref={workspaceRef} data-workspace onKeyDown={trapFocus}>
            <button ref={toggleRef} onClick={() => setFullscreen(!fullscreen)}>Toggle full screen</button>
            <input aria-label="Draft service name" defaultValue="api" />
            <button onClick={() => setDialog(true)}>Open dialog</button>
            {dialog && createPortal(<div role="dialog"><input aria-label="Dialog input" /></div>, document.body)}
          </div>
        </div>
        <aside data-already-inert inert>Unavailable panel</aside>
      </main>
    </div>
  );
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  originalOverflow = document.body.style.overflow;
  document.body.style.overflow = "clip";
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root.render(<Workspace />));
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  document.body.style.overflow = originalOverflow;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function toggle() {
  act(() => host.querySelector<HTMLButtonElement>("button")!.click());
}

describe("topology full screen", () => {
  it("keeps the existing workspace and draft while isolating and restoring the page", () => {
    const workspace = host.querySelector<HTMLElement>("[data-workspace]")!;
    const draft = host.querySelector<HTMLInputElement>("input")!;
    draft.value = "pending-api";
    const sidebar = host.querySelector<HTMLElement>("[data-sidebar]")!;
    const header = host.querySelector<HTMLElement>("header")!;
    const scroller = host.querySelector("main")!;

    toggle();
    expect(sidebar.inert).toBe(true);
    expect(header.inert).toBe(true);
    expect(workspace.closest("[inert]")).toBeNull();
    expect(scroller.style.overflow).toBe("hidden");
    expect(document.body.style.overflow).toBe("hidden");
    expect(host.querySelector("[data-workspace]")).toBe(workspace);
    expect(host.querySelector("input")).toBe(draft);
    expect(draft.value).toBe("pending-api");

    toggle();
    expect(sidebar.inert).toBe(false);
    expect(header.inert).toBe(false);
    expect(host.querySelector<HTMLElement>("[data-already-inert]")!.inert).toBe(true);
    expect(scroller.style.overflow).toBe("auto");
    expect(document.body.style.overflow).toBe("clip");
    expect(document.activeElement).toBe(host.querySelector("button"));
    expect(draft.value).toBe("pending-api");
  });

  it("restores page access when the expanded workspace unmounts", () => {
    const sidebar = host.querySelector<HTMLElement>("[data-sidebar]")!;
    toggle();
    act(() => root.render(null));
    expect(sidebar.inert).toBe(false);
    expect(document.body.style.overflow).toBe("clip");
  });

  it("keeps later body-portalled dialogs interactive", () => {
    toggle();
    act(() => host.querySelectorAll<HTMLButtonElement>("button")[1].click());
    const input = document.querySelector<HTMLInputElement>('[aria-label="Dialog input"]')!;
    expect(input.closest("[inert]")).toBeNull();
    input.focus();
    expect(document.activeElement).toBe(input);
    const event = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
    input.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  });

  it("wraps keyboard focus inside the expanded workspace", () => {
    vi.spyOn(HTMLElement.prototype, "getClientRects").mockReturnValue([new DOMRect(0, 0, 20, 20)] as unknown as DOMRectList);
    toggle();
    const buttons = host.querySelectorAll<HTMLButtonElement>("button");
    const first = buttons[0];
    const last = buttons[1];
    last.focus();
    last.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }));
    expect(document.activeElement).toBe(first);
    first.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true }));
    expect(document.activeElement).toBe(last);
  });
});
