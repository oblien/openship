// @vitest-environment happy-dom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it } from "vitest";
import { Modal } from "@/components/ui/Modal";
import { useDialogFocus } from "./useDialogFocus";

let root: Root, host: HTMLDivElement, opener: HTMLButtonElement;
function Dialog({ close, nested = false }: { close: () => void; nested?: boolean }) {
  const { dialog, onKeyDown } = useDialogFocus(close);
  const [child, setChild] = useState(false);
  return (
    <Modal isOpen onClose={close} showCloseButton={false}>
      <div
        ref={dialog}
        role="dialog"
        tabIndex={-1}
        onKeyDown={onKeyDown}
        aria-label={nested ? "Child" : "Parent"}
      >
        <button onClick={() => setChild(true)}>First</button>
        <button>Last</button>
        {child && <Dialog nested close={() => setChild(false)} />}
      </div>
    </Modal>
  );
}
function Harness() {
  const [open, setOpen] = useState(true);
  return open && <Dialog close={() => setOpen(false)} />;
}
beforeEach(() => {
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div");
  opener = document.createElement("button");
  document.body.append(opener, host);
  opener.focus();
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  opener.remove();
});
const key = (value: string, shiftKey = false) =>
  act(async () =>
    document.activeElement!.dispatchEvent(
      new KeyboardEvent("keydown", { key: value, shiftKey, bubbles: true, cancelable: true }),
    ),
  );

it("focuses a delayed modal portal and returns to the opener after Escape", async () => {
  await act(async () => {
    root.render(<Harness />);
  });
  const dialog = document.querySelector('[role="dialog"]')!;
  expect(document.activeElement).toBe(dialog);
  await key("Escape");
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(document.activeElement).toBe(opener);
});
it("keeps keyboard traversal inside the mounted dialog", async () => {
  await act(async () => root.render(<Harness />));
  const [first, last] = [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')];
  first!.focus();
  await key("Tab", true);
  expect(document.activeElement).toBe(last);
  await key("Tab");
  expect(document.activeElement).toBe(first);
});
it("restores focus inside the parent when a nested dialog closes", async () => {
  await act(async () => root.render(<Harness />));
  const first = document.querySelector<HTMLButtonElement>('[role="dialog"] button')!;
  first.focus();
  await act(async () => first.click());
  expect(document.activeElement?.getAttribute("aria-label")).toBe("Child");
  await key("Escape");
  expect(document.querySelector('[aria-label="Child"]')).toBeNull();
  expect(document.activeElement).toBe(first);
});
