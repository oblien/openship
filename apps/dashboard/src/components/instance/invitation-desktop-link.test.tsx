// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { desktopInstanceLink } from "@repo/core";
import { I18nProvider } from "@/components/i18n-provider";
import { baseDictionary } from "@/i18n";
import { InvitationDesktopLink } from "./InvitationDesktopLink";

const h = vi.hoisted(() => ({ selfHosted: true, copy: vi.fn() }));
vi.mock("@/hooks/useDeploymentInfo", () => ({
  useDeploymentInfo: () => ({ selfHosted: h.selfHosted }),
}));
vi.mock("@/lib/clipboard", () => ({ copyText: h.copy }));
let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  h.selfHosted = true;
  h.copy.mockReset().mockResolvedValue(undefined);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});
const render = () =>
  act(async () =>
    root.render(
      <I18nProvider>
        <InvitationDesktopLink invitationId="inv_1" />
      </I18nProvider>,
    ),
  );
const m = baseDictionary.misc.acceptInvite;
const address = () => `${window.location.origin}/accept-invite/inv_1`;

it("offers an explicit Desktop link with a manual fallback and no automatic redirect", async () => {
  await render();
  const link = host.querySelector("a")!;
  expect(link.getAttribute("href")).toBe(desktopInstanceLink(address()));
  expect(host.querySelector("input")).toBeNull();
  await act(async () => {
    const event = new MouseEvent("click", { bubbles: true, cancelable: true });
    event.preventDefault();
    link.dispatchEvent(event);
  });
  expect(host.textContent).toContain(m.desktopFallback);
  expect(host.querySelector<HTMLInputElement>("input")?.value).toBe(address());
});

it("copies the normal invitation URL for manual connection", async () => {
  await render();
  await act(async () => host.querySelector<HTMLButtonElement>("button")!.click());
  expect(h.copy).toHaveBeenCalledExactlyOnceWith(address());
  expect(host.textContent).toContain(m.desktopCopied);
});

it("exposes a selectable URL if clipboard permission is denied", async () => {
  h.copy.mockRejectedValueOnce(new Error("Clipboard denied"));
  await render();
  await act(async () => host.querySelector<HTMLButtonElement>("button")!.click());
  expect(host.querySelector<HTMLInputElement>("input")?.value).toBe(address());
});

it.each(["desktop", "cloud"])(
  "does not offer an unrelated instance connection in %s",
  async (mode) => {
    if (mode === "desktop") vi.stubGlobal("desktop", { isDesktop: true });
    else h.selfHosted = false;
    await render();
    expect(host.querySelector("a")).toBeNull();
  },
);
