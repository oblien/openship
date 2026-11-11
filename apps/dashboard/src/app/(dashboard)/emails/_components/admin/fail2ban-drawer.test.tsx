// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/components/i18n-provider";
import { setActiveOrganizationId } from "@/lib/api/client";
import type { MailFail2banStatus } from "@repo/contracts";
import { Fail2banDrawer } from "./fail2ban-drawer";
import { loadDictionary } from "@/i18n";

const api = vi.hoisted(() => ({ status: vi.fn(), ban: vi.fn(), unban: vi.fn() }));
vi.mock("@/lib/api", () => ({ mailAdminApi: { fail2ban: api } }));
vi.mock("@/components/ui/CustomSelect", () => ({
  CustomSelect: (props: any) => (
    <select
      aria-label={props["aria-label"]}
      value={props.value}
      disabled={props.disabled}
      onChange={(event) => props.onChange(event.target.value)}
    >
      <option value="">{props.placeholder}</option>
      {props.options.map((option: any) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  ),
}));

const snapshot = (over: Partial<MailFail2banStatus> = {}): MailFail2banStatus => ({
  jails: ["postfix"],
  checkedAt: "2026-11-06T08:00:00Z",
  canManage: true,
  details: {
    postfix: {
      jail: "postfix",
      currentlyFailed: 2,
      totalFailed: 8,
      currentlyBanned: 1,
      totalBanned: 3,
      bannedIps: ["203.0.113.10"],
    },
  },
  ...over,
});
let root: Root;
let host: HTMLDivElement;
const close = vi.fn();
async function render(serverId = "srv-mail", isOpen = true, rtl = false) {
  const locale = rtl ? "ar" : "en";
  const dictionary = await loadDictionary(locale);
  await act(async () => {
    root.render(
      <I18nProvider initialLocale={locale} initialDictionary={dictionary}>
        <Fail2banDrawer serverId={serverId} isOpen={isOpen} onClose={close} />
      </I18nProvider>,
    );
  });
}
async function click(label: string, within: ParentNode = document) {
  const button = [...within.querySelectorAll<HTMLButtonElement>("button")].find(
    (node) => node.textContent?.trim() === label,
  );
  expect(button, label).toBeDefined();
  await act(async () => button!.click());
}
async function fill(value: string) {
  const input = document.querySelector("input")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function chooseJail() {
  const select = document.querySelector("select")!;
  await act(async () => {
    select.value = "postfix";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
}
beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  vi.resetAllMocks();
  api.status.mockResolvedValue(snapshot());
  api.ban.mockResolvedValue({ success: true, output: "1" });
  api.unban.mockResolvedValue({ success: true, output: "1" });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  setActiveOrganizationId(null);
});

describe("Fail2ban management drawer", () => {
  it("isolates RTL address display without changing the submitted IP", async () => {
    const value = snapshot();
    value.details.postfix.bannedIps = ["2001:db8::7"];
    api.status.mockResolvedValue(value);
    await render("srv-mail", true, true);
    const { unban } = (await loadDictionary("ar")).emailsAdmin.fail2ban;
    expect(document.documentElement.dir).toBe("rtl");
    expect(document.querySelector('bdi[dir="ltr"]')?.textContent).toBe("2001:db8::7");
    await click(unban);
    expect(document.querySelector("footer")?.textContent).toContain("\u20662001:db8::7\u2069");
    await click(unban, document.querySelector("footer")!);
    expect(api.unban).toHaveBeenCalledExactlyOnceWith("srv-mail", "2001:db8::7", "postfix");
  });
  it("reads only while open", async () => {
    await render("srv-mail", false);
    expect(api.status).not.toHaveBeenCalled();
    await render();
    expect(api.status).toHaveBeenCalledExactlyOnceWith("srv-mail");
  });
  it("keeps Escape reachable after a focused action loses focus during refresh", async () => {
    await render();
    const reload = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent?.trim() === "Reload",
    )!;
    reload.focus();
    await act(async () => {
      reload.blur();
      await new Promise((resolve) => setTimeout(resolve, 40));
    });
    expect(document.activeElement?.getAttribute("role")).toBe("dialog");
    await act(async () =>
      document.activeElement!.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      ),
    );
    expect(close).toHaveBeenCalledOnce();
  });
  it("renders read access without mutation controls", async () => {
    api.status.mockResolvedValue(snapshot({ canManage: false }));
    await render();
    expect(document.body.textContent).toContain("203.0.113.10");
    expect(document.body.textContent).toContain("Managing them requires mail administrator access");
    expect(document.querySelector("form")).toBeNull();
    expect(document.querySelector('[aria-label^="Unban"]')).toBeNull();
  });
  it("shows unavailable instead of an empty ban list after failed reads", async () => {
    api.status.mockRejectedValue(new Error("connection unavailable"));
    await render();
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      "connection unavailable",
    );
    expect(document.body.textContent).not.toContain("No active jails");
  });
  it("requires a real IP and explicit jail, with review and cancellation before a ban", async () => {
    await render();
    await fill("--all");
    await chooseJail();
    expect(document.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(true);
    await fill("2001:db8::7");
    await click("Review ban");
    expect(document.querySelector("footer")?.textContent).toContain("Ban 2001:db8::7 in postfix?");
    expect(api.ban).not.toHaveBeenCalled();
    await click("Cancel");
    expect(api.ban).not.toHaveBeenCalled();
    await click("Review ban");
    await click("Ban IP", document.querySelector("footer")!);
    expect(api.ban).toHaveBeenCalledExactlyOnceWith("srv-mail", "2001:db8::7", "postfix");
    expect(api.status).toHaveBeenCalledTimes(2);
  });
  it("scopes unban to the exact displayed jail and verifies through a refresh", async () => {
    await render();
    await click("Unban");
    expect(api.unban).not.toHaveBeenCalled();
    const next = snapshot();
    next.details.postfix.bannedIps = [];
    next.details.postfix.currentlyBanned = 0;
    api.status.mockResolvedValue(next);
    await click("Unban", document.querySelector("footer")!);
    expect(api.unban).toHaveBeenCalledExactlyOnceWith("srv-mail", "203.0.113.10", "postfix");
    expect(document.body.textContent).toContain("No addresses are currently banned");
  });
  it("retains stale observations and disables changes after refresh failure", async () => {
    await render();
    api.status.mockRejectedValue(new Error("SSH lost"));
    await click("Reload");
    expect(document.body.textContent).toContain("203.0.113.10");
    expect(document.body.textContent).toContain("last successful reading");
    expect(document.querySelector<HTMLButtonElement>('[aria-label^="Unban"]')?.disabled).toBe(true);
  });
  it("refreshes even after an uncertain mutation failure without removing the ban optimistically", async () => {
    await render();
    api.unban.mockRejectedValue(new Error("response lost"));
    await click("Unban");
    await click("Unban", document.querySelector("footer")!);
    expect(document.body.textContent).toContain("response lost");
    expect(document.body.textContent).toContain("203.0.113.10");
    expect(api.status).toHaveBeenCalledTimes(2);
  });
  it("discards a late response after switching servers", async () => {
    let finish!: (value: MailFail2banStatus) => void;
    api.status.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    await render("srv-old");
    api.status.mockResolvedValue(snapshot({ jails: [], details: {} }));
    await render("srv-new");
    await act(async () => finish(snapshot()));
    expect(document.body.textContent).not.toContain("203.0.113.10");
    expect(api.status).toHaveBeenLastCalledWith("srv-new");
  });
  it("resets a pending review when the active organization changes", async () => {
    await render();
    await click("Unban");
    api.status.mockResolvedValue(snapshot({ canManage: false }));
    await act(async () => setActiveOrganizationId("another-org"));
    expect(document.querySelector("footer")).toBeNull();
    expect(document.querySelector("form")).toBeNull();
    expect(api.unban).not.toHaveBeenCalled();
  });
});
