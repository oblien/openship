// @vitest-environment happy-dom
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AssistantComposer } from "./AssistantComposer";

let root: Root, host: HTMLDivElement;
beforeEach(() => {
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});
const send = vi.fn(),
  stop = vi.fn();
async function render(props: Partial<ComponentProps<typeof AssistantComposer>> = {}) {
  send.mockClear();
  stop.mockClear();
  await act(async () =>
    root.render(
      <AssistantComposer
        value="Check my apps"
        onChange={() => {}}
        onSend={send}
        onStop={stop}
        controls={null}
        active={false}
        busy={false}
        disabled={false}
        canSend
        {...props}
      />,
    ),
  );
  return host.querySelector("textarea")!;
}
const press = async (input: HTMLTextAreaElement, options: KeyboardEventInit = {}) => {
  const event = new KeyboardEvent("keydown", {
    key: "Enter",
    bubbles: true,
    cancelable: true,
    ...options,
  });
  await act(async () => {
    input.dispatchEvent(event);
  });
  return event;
};

it("sends on desktop Enter, while preserving Shift+Enter and IME composition", async () => {
  const input = await render();
  expect((await press(input, { shiftKey: true })).defaultPrevented).toBe(false);
  expect((await press(input, { isComposing: true })).defaultPrevented).toBe(false);
  expect((await press(input, { keyCode: 229 })).defaultPrevented).toBe(false);
  expect(send).not.toHaveBeenCalled();
  expect((await press(input)).defaultPrevented).toBe(true);
  expect(send).toHaveBeenCalledTimes(1);
});
it("keeps Enter as a newline on touch devices and sends through the explicit button", async () => {
  vi.spyOn(window, "matchMedia").mockReturnValue({ matches: true } as MediaQueryList);
  const input = await render();
  expect((await press(input)).defaultPrevented).toBe(false);
  expect(send).not.toHaveBeenCalled();
  await act(async () =>
    host.querySelector<HTMLButtonElement>('[aria-label="Send message"]')!.click(),
  );
  expect(send).toHaveBeenCalledTimes(1);
});
it.each([{ disabled: true }, { busy: true }, { canSend: false }, { value: "  " }])(
  "does not submit unavailable input: %j",
  async (props) => {
    const input = await render(props);
    await press(input);
    await act(async () => {
      host
        .querySelector("form")!
        .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    expect(send).not.toHaveBeenCalled();
    expect(host.querySelector<HTMLButtonElement>('[aria-label="Send message"]')!.disabled).toBe(
      true,
    );
  },
);
it("shows Stop during a turn and never sends another turn with Enter", async () => {
  const input = await render({ active: true });
  await press(input);
  expect(send).not.toHaveBeenCalled();
  expect(host.querySelector('[aria-label="Send message"]')).toBeNull();
  await act(async () =>
    host.querySelector<HTMLButtonElement>('[aria-label="Stop response"]')!.click(),
  );
  expect(stop).toHaveBeenCalledTimes(1);
});

it("accepts image-only turns, previews and removes images, and blocks sending during image preparation", async () => {
  const image = { id: "image", name: "status.png", mime: "image/png" as const, data: "aW1hZ2U=" };
  const remove = vi.fn();
  await render({ value: "", images: [image], imagesSupported: true, onRemoveImage: remove });
  expect(host.querySelector("img")?.alt).toBe("status.png");
  await act(async () =>
    host.querySelector<HTMLButtonElement>('[aria-label="Send message"]')!.click(),
  );
  expect(send).toHaveBeenCalledTimes(1);
  await act(async () =>
    host.querySelector<HTMLButtonElement>('[aria-label="Remove status.png"]')!.click(),
  );
  expect(remove).toHaveBeenCalledWith("image");
  await render({ value: "", images: [image], imagesSupported: true, imagesPending: true });
  expect(host.querySelector<HTMLButtonElement>('[aria-label="Send message"]')!.disabled).toBe(true);
  await render({ images: [image], imagesSupported: false });
  expect(host.querySelector<HTMLButtonElement>('[aria-label="Send message"]')!.disabled).toBe(true);
});

it("lets a task receive a live follow-up while retaining Stop and disabling attachments", async () => {
  const input = await render({
    active: true,
    canMessageWhileActive: true,
    imagesSupported: true,
    onImages: vi.fn(),
  });
  expect(host.querySelector('[aria-label="Stop response"]')).not.toBeNull();
  expect(host.querySelector<HTMLButtonElement>('[aria-label="Attach images"]')!.disabled).toBe(
    true,
  );
  expect(host.querySelector<HTMLButtonElement>('[aria-label="Send message"]')!.disabled).toBe(
    false,
  );
  await press(input);
  expect(send).toHaveBeenCalledTimes(1);
});

it("collapses a cleared conversation draft and resets its scroll instead of retaining the old height", async () => {
  const input = await render({ compact: true });
  vi.spyOn(input, "scrollHeight", "get").mockReturnValue(168);
  await render({ compact: true, value: "A long investigation\nwith several lines\nand details" });
  input.scrollTop = 60;
  expect(input.style.height).toBe("168px");
  await render({ compact: true, value: "", active: true });
  expect(input.getAttribute("rows")).toBe("2");
  expect(input.style.height).toBe("auto");
  expect(input.scrollTop).toBe(0);
  expect(host.querySelector('[aria-label="Stop response"]')).not.toBeNull();
  await render({ compact: true, value: "", active: false });
  expect(input.getAttribute("rows")).toBe("2");
  expect(input.style.height).toBe("auto");
});
