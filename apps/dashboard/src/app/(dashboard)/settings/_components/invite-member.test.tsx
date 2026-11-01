// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { I18nProvider } from "@/components/i18n-provider";
import { baseDictionary } from "@/i18n";
import { InviteMemberInline } from "./InviteMemberInline";

const h = vi.hoisted(() => ({
  email: vi.fn(),
  invite: vi.fn(),
  refresh: vi.fn(),
  close: vi.fn(),
  confirm: vi.fn(),
}));
vi.mock("@/lib/api/system", () => ({ systemApi: { getEmailSettings: h.email } }));
vi.mock("@/lib/api", () => ({
  api: { patch: vi.fn() },
  permissionsApi: { inviteWithGrants: h.invite },
  getApiErrorMessage: (error: Error) => error.message,
}));
vi.mock("@/context/ModalContext", () => ({ useModal: () => ({ showModal() {}, hideModal() {} }) }));
vi.mock("@/components/permissions/confirm-server-access", async (load) => ({
  ...(await load<typeof import("@/components/permissions/confirm-server-access")>()),
  confirmServerAccess: h.confirm,
}));
vi.mock("@/components/permissions/ResourcePicker", () => ({
  ResourcePicker: ({ onChange }: { onChange: (grants: unknown[]) => void }) => (
    <button
      type="button"
      onClick={() =>
        onChange([{ resourceType: "server", resourceId: "server_1", permissions: ["read"] }])
      }
    >
      Select server
    </button>
  ),
}));
const copy = baseDictionary.settings.inviteMember;
let root: Root, host: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks();
  h.email.mockResolvedValue({ deliverable: true });
  h.invite.mockImplementation(async (body) => ({
    data: { id: "inv_1", email: body.email.toLowerCase() },
  }));
  h.confirm.mockResolvedValue(true);
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
async function render(props: Partial<Parameters<typeof InviteMemberInline>[0]> = {}) {
  await act(async () =>
    root.render(
      <I18nProvider>
        <InviteMemberInline
          availableTypes={["server", "project"]}
          selfHosted
          initialMailSource="platform"
          cloudConnected={false}
          instanceUrl="https://ops.example.test"
          onInvited={h.refresh}
          onClose={h.close}
          onConnectCloud={() => {}}
          {...props}
        />
      </I18nProvider>,
    ),
  );
}
function button(label: string, includes = false) {
  const result = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
    (node) =>
      !node.closest("[hidden]") &&
      (includes ? node.textContent?.includes(label) : node.textContent?.trim() === label),
  );
  expect(result, label).toBeDefined();
  return result!;
}
async function enterEmail() {
  await act(async () => {
    const field = host.querySelector<HTMLInputElement>('input[type="email"]')!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
      field,
      "Teammate@example.test",
    );
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function submit() {
  await act(async () =>
    host
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
  );
}

it("uses the configured email service and exposes the same invitation for copying", async () => {
  await render();
  await enterEmail();
  await submit();
  expect(h.invite).toHaveBeenCalledExactlyOnceWith(
    { email: "Teammate@example.test", role: "member", grants: [] },
    { linkOnly: false },
  );
  expect(host.textContent).toContain(copy.emailSent);
  expect(host.querySelector<HTMLInputElement>("input[readonly]")?.value).toBe(
    "https://ops.example.test/accept-invite/inv_1",
  );
  expect(h.refresh).toHaveBeenCalledTimes(1);
  expect(h.close).not.toHaveBeenCalled();
});

it("lets the owner choose a link even when email is available", async () => {
  const clipboard = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
  await render();
  await enterEmail();
  await act(async () => button(copy.linkDelivery).click());
  await submit();
  expect(h.invite.mock.calls[0][1]).toEqual({ linkOnly: true });
  expect(host.textContent).toContain(copy.linkReady);
  await act(async () => button(baseDictionary.settings.team.copyInviteLink).click());
  expect(clipboard).toHaveBeenCalledWith("https://ops.example.test/accept-invite/inv_1");
});

it("defaults to a copyable invitation when no email service is configured", async () => {
  h.email.mockResolvedValue({ deliverable: false });
  await render();
  await enterEmail();
  expect(button(copy.createInviteLink).disabled).toBe(false);
  await submit();
  expect(h.invite.mock.calls[0][1]).toEqual({ linkOnly: true });
});

it("does not overwrite an explicit link choice when a slow capability check finishes", async () => {
  let complete!: (value: { deliverable: boolean }) => void;
  h.email.mockReturnValueOnce(
    new Promise((resolve) => {
      complete = resolve;
    }),
  );
  await render();
  await enterEmail();
  await act(async () => button(copy.linkDelivery).click());
  await act(async () => complete({ deliverable: true }));
  expect(button(copy.createInviteLink).disabled).toBe(false);
  await submit();
  expect(h.invite.mock.calls[0][1]).toEqual({ linkOnly: true });
});

it("uses the same operation for restricted invitations and keeps the server-access confirmation", async () => {
  await render();
  await enterEmail();
  await act(async () => button(copy.roleRestrictedTitle, true).click());
  await act(async () => button("Select server").click());
  h.confirm.mockResolvedValueOnce(false);
  await submit();
  expect(h.invite).not.toHaveBeenCalled();
  await submit();
  expect(h.invite).toHaveBeenCalledWith(
    {
      email: "Teammate@example.test",
      role: "restricted",
      grants: [{ resourceType: "server", resourceId: "server_1", permissions: ["read"] }],
    },
    { linkOnly: false },
  );
});

it("keeps failed delivery visible and refreshes pending invitations for recovery", async () => {
  h.invite.mockRejectedValueOnce(new Error("Email service unavailable"));
  await render();
  await enterEmail();
  await submit();
  expect(host.querySelector('[role="alert"]')?.textContent).toBe("Email service unavailable");
  expect(host.querySelector<HTMLInputElement>('input[type="email"]')?.value).toBe(
    "Teammate@example.test",
  );
  expect(host.textContent).not.toContain(copy.emailSent);
  expect(h.refresh).toHaveBeenCalled();
  expect(h.close).not.toHaveBeenCalled();
});

it("does not create or copy a localhost invitation when the public address is missing", async () => {
  await render({ instanceUrl: null });
  await enterEmail();
  expect(button(copy.sendInvite).disabled).toBe(true);
  await submit();
  expect(h.invite).not.toHaveBeenCalled();
});

it("does not create two invitations from repeated submissions", async () => {
  let complete!: (value: unknown) => void;
  h.invite.mockReturnValueOnce(
    new Promise((resolve) => {
      complete = resolve;
    }),
  );
  await render();
  await enterEmail();
  await act(async () => {
    const form = host.querySelector("form")!;
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
  expect(h.invite).toHaveBeenCalledTimes(1);
  await act(async () => complete({ data: { id: "inv_1", email: "teammate@example.test" } }));
  expect(host.textContent).toContain(copy.emailSent);
});
