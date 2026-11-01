// @vitest-environment happy-dom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/components/i18n-provider";
import { baseDictionary } from "@/i18n";
import CloudAuthorizePage from "@/app/cloud-authorize/page";
import AuthorizePage from "@/app/authorize/page";
import { ApiError } from "@/lib/api/client";

const h = vi.hoisted(() => ({
  list: vi.fn(),
  setActive: vi.fn(),
  signOut: vi.fn(),
  authorize: vi.fn(),
  header: vi.fn(),
  replace: vi.fn(),
  push: vi.fn(),
  params: new URLSearchParams(),
  pending: false,
  session: null as null | {
    user: { id: string; name: string; email: string; image: string | null };
    session: { activeOrganizationId: string | null };
  },
}));
vi.mock("@/lib/auth-client", () => ({
  authClient: { organization: { list: h.list, setActive: h.setActive } },
  signOut: h.signOut,
  useSession: () => ({ data: h.session, isPending: h.pending }),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: h.replace, push: h.push }),
  useSearchParams: () => h.params,
}));
vi.mock("@/lib/api", () => ({ cloudApi: { connectAuthorize: h.authorize } }));
vi.mock("@/lib/api/client", async (original) => ({
  ...(await original<typeof import("@/lib/api/client")>()),
  setActiveOrganizationId: h.header,
}));
vi.mock("@/components/auth-shell", () => ({
  AuthShell: ({ children }: { children: ReactNode }) => <main>{children}</main>,
}));

const m = baseDictionary.misc.cloudAuthorize;
const challenge = "a".repeat(43);
const orgs = [
  { id: "org-a", name: "Personal workspace", logo: null },
  { id: "org-b", name: "Acme team", logo: null },
];
let root: Root;
let host: HTMLDivElement;
const button = (label: string) =>
  [...host.querySelectorAll<HTMLButtonElement>("button")].find(
    (node) => node.getAttribute("aria-label") === label || node.textContent?.trim() === label,
  );
const click = (label: string) =>
  act(async () => {
    const node = button(label);
    expect(node, label).toBeDefined();
    node!.click();
  });
const render = (desktop = false) =>
  act(async () =>
    root.render(
      <I18nProvider>{desktop ? <AuthorizePage /> : <CloudAuthorizePage />}</I18nProvider>,
    ),
  );
function desktopParams() {
  h.params = new URLSearchParams({
    callback: "http://localhost:4500/api/auth/cloud-callback",
    flow: "desktop-cloud",
    app: "Openship Desktop",
    machine: "My Mac",
    state: "opaque-state",
    code_challenge: challenge,
  });
}
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  h.session = {
    user: { id: "user-a", name: "Ada", email: "ada@example.test", image: null },
    session: { activeOrganizationId: "org-a" },
  };
  h.pending = false;
  h.params = new URLSearchParams({
    redirect: "https://instance.example.test/cloud-connect-callback",
    state: "opaque-state",
    code_challenge: challenge,
  });
  window.location.href = `http://localhost:3000/cloud-authorize?${h.params}`;
  h.list.mockResolvedValue({ data: orgs });
  h.setActive.mockResolvedValue({ data: orgs[1] });
  h.signOut.mockResolvedValue({ data: { success: true } });
  h.authorize.mockResolvedValue({
    callbackUrl:
      "https://instance.example.test/cloud-connect-callback?code=one-time&state=opaque-state",
  });
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

describe("Cloud consent identity and switching", () => {
  it.each([false, true])(
    "shows the actual account and organization without granting access (Desktop: %s)",
    async (desktop) => {
      if (desktop) desktopParams();
      await render(desktop);
      expect(host.textContent).toContain("Ada");
      expect(host.textContent).toContain("ada@example.test");
      expect(host.textContent).toContain("Personal workspace");
      expect(host.textContent).not.toContain("Acme team");
      expect(button(m.switchAccount)).toBeDefined();
      expect(button(m.switchOrganization)).toBeDefined();
      expect(button(m.authorize)?.disabled).toBe(false);
      expect(h.authorize).not.toHaveBeenCalled();
      expect(h.setActive).not.toHaveBeenCalled();
    },
  );
  it("shows one organization without an unnecessary switch control", async () => {
    h.list.mockResolvedValueOnce({ data: [orgs[0]] });
    await render();
    expect(host.textContent).toContain("Personal workspace");
    expect(button(m.switchOrganization)).toBeUndefined();
    expect(button(m.switchAccount)).toBeDefined();
    expect(button(m.authorize)?.disabled).toBe(false);
  });

  it("explains an empty organization list and offers retry", async () => {
    h.list.mockResolvedValueOnce({ data: [] });
    await render();
    expect(host.querySelector('[role="status"]')?.textContent).toContain(m.noOrganizations);
    expect(button(m.authorize)?.disabled).toBe(true);
    await click(m.retry);
    expect(button(m.authorize)?.disabled).toBe(false);
  });

  it("keeps the Desktop handoff state and challenge after explicit consent", async () => {
    desktopParams();
    await render(true);
    await click(m.authorize);
    const url = new URL(window.location.href);
    expect(url.pathname).toBe("/api/cloud/desktop-handoff");
    expect(url.searchParams.get("redirect")).toBe(h.params.get("callback"));
    expect(url.searchParams.get("state")).toBe("opaque-state");
    expect(url.searchParams.get("code_challenge")).toBe(challenge);
    expect(h.authorize).not.toHaveBeenCalled();
  });

  it("blocks authorization while loading, then retries a failed organization read", async () => {
    let finish!: (value: unknown) => void;
    h.list.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    await render();
    expect(button(m.authorize)?.disabled).toBe(true);
    await act(async () => finish({ error: { message: "Permission denied" } }));
    expect(host.querySelector('[role="alert"]')?.textContent).toContain(m.organizationsError);
    expect(button(m.authorize)?.disabled).toBe(true);
    expect(h.authorize).not.toHaveBeenCalled();
    await click(m.retry);
    expect(host.textContent).toContain("Personal workspace");
    expect(button(m.authorize)?.disabled).toBe(false);
  });
  it.each([null, "removed-org"])(
    "does not substitute the first organization for an unresolved active scope (%s)",
    async (id) => {
      vi.spyOn(window.location, "reload").mockImplementation(() => {});
      h.session!.session.activeOrganizationId = id;
      await render();
      expect(button(m.authorize)?.disabled).toBe(true);
      expect(host.textContent).toContain(m.chooseOrganizationHint);
      await click(m.switchOrganization);
      await click("Acme team");
      expect(h.setActive).toHaveBeenCalledExactlyOnceWith({ organizationId: "org-b" });
      expect(h.authorize).not.toHaveBeenCalled();
    },
  );
  it("waits for the organization switch to succeed and preserves the entire consent URL", async () => {
    const reload = vi.spyOn(window.location, "reload").mockImplementation(() => {});
    const original = window.location.href;
    let finish!: (value: unknown) => void;
    h.setActive.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    await render();
    await click(m.switchOrganization);
    await click("Acme team");
    await click("Acme team");
    expect(h.setActive).toHaveBeenCalledOnce();
    expect(button(m.authorize)?.disabled).toBe(true);
    expect(h.header).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
    await act(async () => finish({ data: orgs[1] }));
    expect(h.header).toHaveBeenCalledWith("org-b");
    expect(reload).toHaveBeenCalledOnce();
    expect(window.location.href).toBe(original);
    expect(h.authorize).not.toHaveBeenCalled();
  });
  it("keeps the original organization on a denied switch and does not grant access", async () => {
    h.setActive.mockResolvedValueOnce({ error: { message: "Access denied" } });
    const reload = vi.spyOn(window.location, "reload").mockImplementation(() => {});
    await render();
    await click(m.switchOrganization);
    await click("Acme team");
    expect(host.querySelector('[role="alert"]')?.textContent).toContain(m.switchOrganizationError);
    expect(host.querySelector('button[aria-pressed="true"]')?.textContent).toContain(
      "Personal workspace",
    );
    expect(h.header).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
    expect(h.authorize).not.toHaveBeenCalled();
  });
  it.each([false, true])(
    "switches accounts only after sign-out and preserves connection parameters (Desktop: %s)",
    async (desktop) => {
      if (desktop) desktopParams();
      const original = h.params.toString();
      let finish!: (value: unknown) => void;
      h.signOut.mockReturnValueOnce(
        new Promise((resolve) => {
          finish = resolve;
        }),
      );
      await render(desktop);
      await click(m.switchAccount);
      await click(m.switchAccount);
      expect(h.signOut).toHaveBeenCalledOnce();
      expect(button(m.authorize)?.disabled).toBe(true);
      expect(window.location.pathname).toBe("/cloud-authorize");
      await act(async () => finish({ data: { success: true } }));
      const url = new URL(window.location.href);
      expect(url.pathname).toBe("/login");
      expect(h.header).toHaveBeenCalledWith(null);
      if (desktop)
        expect(Object.fromEntries(url.searchParams)).toEqual(
          Object.fromEntries(new URLSearchParams(original)),
        );
      else expect(url.searchParams.get("returnTo")).toBe(`/cloud-authorize?${original}`);
      expect(h.authorize).not.toHaveBeenCalled();
    },
  );
  it("does not navigate to login when sign-out fails", async () => {
    h.signOut.mockResolvedValueOnce({ error: { message: "Offline" } });
    const original = window.location.href;
    await render();
    await click(m.switchAccount);
    expect(window.location.href).toBe(original);
    expect(h.header).not.toHaveBeenCalled();
    expect(host.querySelector('[role="alert"]')?.textContent).toContain(m.switchAccountError);
    expect(button(m.switchAccount)?.disabled).toBe(false);
  });
  it("drops a late private organization list when the account changes", async () => {
    let finish!: (value: unknown) => void;
    h.list.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    await render();
    h.session = {
      user: { id: "user-b", name: "Bea", email: "bea@example.test", image: null },
      session: { activeOrganizationId: "org-b" },
    };
    h.list.mockResolvedValueOnce({ data: [orgs[1]] });
    await render();
    await act(async () => finish({ data: orgs }));
    expect(host.textContent).toContain("Bea");
    expect(host.textContent).toContain("Acme team");
    expect(host.textContent).not.toContain("Ada");
    expect(host.textContent).not.toContain("Personal workspace");
  });
  it("authorizes only after an explicit click, with unchanged state and PKCE", async () => {
    await render();
    await click(m.authorize);
    expect(h.authorize).toHaveBeenCalledExactlyOnceWith({
      redirect: "https://instance.example.test/cloud-connect-callback",
      state: "opaque-state",
      codeChallenge: challenge,
    });
    expect(window.location.href).toContain("code=one-time&state=opaque-state");
  });
  it("keeps device authorization in-place and deduplicates repeated clicks", async () => {
    h.params = new URLSearchParams({
      mode: "device",
      state: "opaque-state",
      code_challenge: challenge,
    });
    let finish!: (value: unknown) => void;
    h.authorize.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    await render();
    await act(async () => {
      button(m.authorize)!.click();
      button(m.authorize)!.click();
    });
    expect(h.authorize).toHaveBeenCalledExactlyOnceWith({
      state: "opaque-state",
      codeChallenge: challenge,
      mode: "device",
    });
    await act(async () => finish({ authorized: true }));
    expect(host.textContent).toContain(m.deviceDoneTitle);
    expect(window.location.pathname).toBe("/cloud-authorize");
  });
  it("returns an expired session to login with the same device request", async () => {
    h.params = new URLSearchParams({
      mode: "device",
      state: "opaque-state",
      code_challenge: challenge,
    });
    h.authorize.mockRejectedValueOnce(new ApiError(401, "Expired", {}));
    await render();
    await click(m.authorize);
    const destination = h.replace.mock.calls.at(-1)?.[0];
    expect(new URL(destination, "http://localhost").searchParams.get("returnTo")).toBe(
      `/cloud-authorize?${h.params}`,
    );
  });
  it("does not query identities or authorize a malformed request", async () => {
    h.params.delete("code_challenge");
    await render();
    expect(host.textContent).toContain(m.missingCodeChallenge);
    expect(h.list).not.toHaveBeenCalled();
    expect(h.authorize).not.toHaveBeenCalled();
  });
});
