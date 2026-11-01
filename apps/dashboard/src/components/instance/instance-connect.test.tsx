// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/components/i18n-provider";
import { baseDictionary } from "@/i18n";
import { InstanceConnectDialog } from "./InstanceConnectDialog";

const h = vi.hoisted(() => ({ address: vi.fn(), code: vi.fn(), close: vi.fn() }));
vi.mock("@/lib/api/instance", () => ({
  instanceApi: { connectAddress: h.address, connect: h.code },
}));
const copy = baseDictionary.settings.instance.connection;
let root: Root;
let host: HTMLDivElement;
let navigate: ReturnType<typeof vi.spyOn>;
beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks();
  h.address.mockResolvedValue({});
  h.code.mockResolvedValue({});
  navigate = vi.spyOn(window.location, "assign").mockImplementation(() => {});
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () =>
    root.render(
      <I18nProvider>
        <InstanceConnectDialog onClose={h.close} />
      </I18nProvider>,
    ),
  );
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const button = (label: string) => {
  const result = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (el) => el.textContent?.trim() === label,
  );
  expect(result, label).toBeDefined();
  return result!;
};
async function type(value: string) {
  const field = document.querySelector<HTMLInputElement | HTMLTextAreaElement>(
    'input[inputmode="url"], textarea',
  )!;
  const prototype =
    field.tagName === "INPUT" ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function submit() {
  await act(async () => {
    document
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
}

describe("Desktop connection dialog", () => {
  it("starts with one URL field and requires a separate action for a pairing code", async () => {
    expect(document.querySelector('input[inputmode="url"]')).not.toBeNull();
    expect(document.querySelector("textarea")).toBeNull();
    expect(button(copy.continue).disabled).toBe(true);
    await act(async () => button(copy.useCode).click());
    expect(document.querySelector('input[inputmode="url"]')).toBeNull();
    expect(document.querySelector("textarea")).not.toBeNull();
    expect(h.address).not.toHaveBeenCalled();
    expect(h.code).not.toHaveBeenCalled();
  });
  it("connects the reviewed origin and navigates to normal sign-in", async () => {
    await type("ops.example.test");
    await submit();
    expect(h.address).toHaveBeenCalledExactlyOnceWith("https://ops.example.test");
    expect(h.code).not.toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledWith("/login");
  });
  it("keeps an invitation for the recipient to claim after connecting", async () => {
    await type("https://ops.example.test/accept-invite/inv_123");
    await submit();
    expect(h.address).toHaveBeenCalledWith("https://ops.example.test");
    expect(navigate).toHaveBeenCalledWith("/accept-invite/inv_123");
  });
  it.each([
    "http://remote.example.test",
    "https://person:secret@remote.example.test",
    "https://remote.example.test?returnTo=https://evil.test",
  ])("rejects an unsafe address without a connection: %s", async (value) => {
    await type(value);
    await submit();
    expect(document.querySelector('[role="alert"]')?.textContent).toBe(copy.invalidAddress);
    expect(h.address).not.toHaveBeenCalled();
    expect(h.code).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  });
  it("retains the address after a failed connection so it can be corrected", async () => {
    h.address.mockRejectedValueOnce(new Error("Instance unavailable"));
    await type("https://ops.example.test");
    await submit();
    expect(document.querySelector<HTMLInputElement>("input")?.value).toBe(
      "https://ops.example.test",
    );
    expect(document.querySelector('[role="alert"]')?.textContent).toBe("Instance unavailable");
    expect(button(copy.continue).disabled).toBe(false);
    await submit();
    expect(navigate).toHaveBeenCalledWith("/login");
  });
  it("prevents parallel connections and closing during an uncertain response", async () => {
    let complete!: () => void;
    h.address.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        complete = resolve;
      }),
    );
    await type("https://ops.example.test");
    await act(async () => {
      const form = document.querySelector("form")!;
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    expect(h.address).toHaveBeenCalledTimes(1);
    await act(async () =>
      document
        .querySelector('[role="dialog"]')!
        .dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })),
    );
    expect(h.close).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
    await act(async () => complete());
    expect(navigate).toHaveBeenCalledWith("/login");
  });
  it("exchanges a code only when that method is explicitly chosen", async () => {
    await act(async () => button(copy.useCode).click());
    await type("fixture-code");
    await submit();
    expect(h.code).toHaveBeenCalledExactlyOnceWith("fixture-code");
    expect(h.address).not.toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledWith("/");
  });
});
