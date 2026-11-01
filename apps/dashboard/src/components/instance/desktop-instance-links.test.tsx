// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/components/i18n-provider";
import { baseDictionary } from "@/i18n";
import { DesktopInstanceLinks } from "./DesktopInstanceLinks";

const h = vi.hoisted(() => ({ connect: vi.fn(), code: vi.fn(), pathname: "/" }));
vi.mock("next/navigation", () => ({ usePathname: () => h.pathname }));
vi.mock("@/lib/api/instance", () => ({
  instanceApi: { connectAddress: h.connect, connect: h.code },
}));
const first = { id: 1, address: "https://ops.example.test/accept-invite/inv_1" };
let requests = [first];
let notify: () => void;
let root: Root;
let host: HTMLDivElement;
const ack = vi.fn(async (id: number) => {
  if (requests[0]?.id !== id) return false;
  requests.shift();
  notify();
  return true;
});
let navigate: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks();
  h.pathname = "/";
  window.history.replaceState(null, "", "/");
  requests = [first];
  h.connect.mockResolvedValue({});
  vi.stubGlobal("desktop", {
    isDesktop: true,
    instanceLinks: {
      pending: vi.fn(async () => requests[0] ?? null),
      acknowledge: ack,
      onLink: (callback: () => void) => {
        notify = callback;
        return () => {
          notify = () => {};
        };
      },
    },
  });
  navigate = vi.spyOn(window.location, "assign").mockImplementation(() => {});
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
const render = () =>
  act(async () =>
    root.render(
      <I18nProvider>
        <DesktopInstanceLinks />
      </I18nProvider>,
    ),
  );
const input = () => document.querySelector<HTMLInputElement>('input[inputmode="url"]')!;
const submit = () =>
  act(async () => {
    document
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });

describe("Desktop invitation confirmation", () => {
  it("loads a cold-launch link into the existing dialog without connecting or accepting", async () => {
    await render();
    expect(input().value).toBe(first.address);
    expect(document.body.textContent).toContain(
      baseDictionary.settings.instance.connection.invitationTitle,
    );
    expect(document.body.textContent).not.toContain(
      baseDictionary.settings.instance.connection.useCode,
    );
    expect(h.connect).not.toHaveBeenCalled();
    expect(h.code).not.toHaveBeenCalled();
    expect(ack).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
    await submit();
    expect(h.connect).toHaveBeenCalledExactlyOnceWith("https://ops.example.test");
    expect(ack).toHaveBeenCalledExactlyOnceWith(1);
    expect(navigate).toHaveBeenCalledExactlyOnceWith("/accept-invite/inv_1");
  });

  it("keeps a later link queued while the current one is being reviewed", async () => {
    await render();
    const second = { id: 2, address: "https://other.test/accept-invite/inv_2" };
    requests.push(second);
    await act(async () => notify());
    expect(input().value).toBe(first.address);
    await act(async () => {
      document
        .querySelector<HTMLButtonElement>(
          `button[aria-label="${baseDictionary.settings.common.close}"]`,
        )!
        .click();
    });
    expect(ack).toHaveBeenCalledWith(1);
    expect(input().value).toBe(second.address);
    expect(h.connect).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  });

  it("preserves a failed connection for retry instead of consuming the link", async () => {
    h.connect.mockRejectedValueOnce(new Error("Instance unavailable"));
    await render();
    await submit();
    expect(input().value).toBe(first.address);
    expect(document.querySelector('[role="alert"]')?.textContent).toBe("Instance unavailable");
    expect(ack).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
    await submit();
    expect(ack).toHaveBeenCalledWith(1);
    expect(navigate).toHaveBeenCalledWith("/accept-invite/inv_1");
  });

  it("stays absent in a browser without the Desktop bridge", async () => {
    vi.stubGlobal("desktop", undefined);
    await render();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(h.connect).not.toHaveBeenCalled();
  });

  it.each(["/accept-invite/current", "/login", "/register", "/two-factor"])(
    "keeps the next link pending while the current invitation uses %s",
    async (path) => {
      h.pathname = path;
      window.history.replaceState(null, "", `${path}?returnTo=%2Faccept-invite%2Fcurrent`);
      await render();
      expect(document.querySelector('[role="dialog"]')).toBeNull();
      expect(ack).not.toHaveBeenCalled();
      h.pathname = "/";
      window.history.replaceState(null, "", "/");
      await render();
      expect(input().value).toBe(first.address);
    },
  );
});
