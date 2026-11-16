// @vitest-environment happy-dom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { I18nProvider } from "@/components/i18n-provider";
import { ImageUrlEditor } from "./ImageUrlEditor";

let host: HTMLDivElement;
let root: Root;
const save = vi.fn();
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.spyOn(HTMLImageElement.prototype, "complete", "get").mockReturnValue(false);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function Editor({ initial = null }: { initial?: string | null }) {
  const [value, setValue] = useState(initial);
  return (
    <I18nProvider>
      <ImageUrlEditor
        value={value}
        editLabel="Change avatar"
        label="Avatar URL"
        hint="Image URL"
        resetLabel="Use default"
        fallback="A"
        onSave={async (next) => {
          await save(next);
          setValue(next);
        }}
      />
    </I18nProvider>
  );
}
async function render(initial?: string) {
  await act(async () => root.render(<Editor initial={initial} />));
}
function button(text: string) {
  return Array.from(host.querySelectorAll("button")).find((item) => item.textContent === text)!;
}
async function open() {
  await act(async () => button("Change avatar").click());
}
async function edit(value: string) {
  await act(async () => {
    const input = host.querySelector("input")!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function submit() {
  await act(async () =>
    host
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
  );
}

it("previews and saves a trimmed image URL", async () => {
  await render();
  await open();
  await edit("  https://cdn.example.test/avatar.png  ");
  expect(host.querySelector("img")?.getAttribute("src")).toBe(
    "https://cdn.example.test/avatar.png",
  );
  expect(host.querySelector("img")?.getAttribute("referrerpolicy")).toBe("no-referrer");
  await submit();
  expect(save).toHaveBeenCalledWith("https://cdn.example.test/avatar.png");
  expect(host.querySelector('[role="status"]')?.textContent).toBe("Saved");
  expect(host.querySelector("input")).toBeNull();
  expect(document.activeElement).toBe(button("Change avatar"));
});

it("rejects executable image schemes without loading or saving them", async () => {
  await render();
  await open();
  await edit("javascript:alert(1)");
  expect(host.querySelector("img")).toBeNull();
  await submit();
  expect(save).not.toHaveBeenCalled();
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("HTTP or HTTPS");
});

it("clears the saved override using the shared reset action", async () => {
  await render("https://cdn.example.test/avatar.png");
  await open();
  await act(async () => button("Use default").click());
  expect(save).toHaveBeenCalledWith(null);
  expect(host.querySelector("input")).toBeNull();
  expect(host.querySelector("img")).toBeNull();
});

it("falls back for a broken image, retries a changed URL and preserves the draft on save failure", async () => {
  await render("https://cdn.example.test/old.png");
  await open();
  await act(async () => host.querySelector("img")!.dispatchEvent(new Event("error")));
  expect(host.querySelector("img")).toBeNull();
  await edit("https://cdn.example.test/new.png");
  expect(host.querySelector("img")?.getAttribute("src")).toBe("https://cdn.example.test/new.png");
  save.mockRejectedValueOnce(new Error("Permission denied"));
  await submit();
  expect(host.querySelector("input")!.value).toBe("https://cdn.example.test/new.png");
  expect(host.querySelector('[role="alert"]')).not.toBeNull();
  expect(host.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(false);
});

it("keeps fields hidden until editing and discards canceled changes without saving", async () => {
  await render("https://cdn.example.test/original.png");
  expect(host.querySelector("form")).toBeNull();
  expect(host.textContent).not.toContain("Image URL");
  await open();
  expect(document.activeElement).toBe(host.querySelector("input"));
  await edit("https://cdn.example.test/draft.png");
  await act(async () => button("Cancel").click());
  expect(host.querySelector("form")).toBeNull();
  expect(host.querySelector("img")?.getAttribute("src")).toBe(
    "https://cdn.example.test/original.png",
  );
  expect(document.activeElement).toBe(button("Change avatar"));
  expect(save).not.toHaveBeenCalled();
  await open();
  expect(host.querySelector("input")!.value).toBe("https://cdn.example.test/original.png");
});

it("supports Escape to cancel and restores focus to the change action", async () => {
  await render();
  await open();
  await edit("https://cdn.example.test/draft.png");
  await act(async () =>
    host
      .querySelector("input")!
      .dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })),
  );
  expect(host.querySelector("input")).toBeNull();
  expect(document.activeElement).toBe(button("Change avatar"));
  expect(save).not.toHaveBeenCalled();
});
