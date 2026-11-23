// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { I18nProvider } from "@/components/i18n-provider";
import { baseDictionary } from "@/i18n";
import { WORKSPACE_NAME_CHANGED } from "@/lib/workspace-name";
import { TeamTab } from "./TeamTab";

const h = vi.hoisted(() => ({
  organization: vi.fn(),
  members: vi.fn(),
  update: vi.fn(),
  meta: vi.fn(),
  toast: vi.fn(),
}));

vi.mock("@/lib/auth-client", () => ({
  useSession: () => ({ data: { user: { id: "user-a" } } }),
  authClient: {
    organization: {
      getFullOrganization: h.organization,
      listMembers: h.members,
      listInvitations: async () => ({ data: [] }),
      update: h.update,
    },
  },
}));
vi.mock("@/lib/api", () => ({
  api: {
    get: (path: string) => (path === "permissions/org-meta" ? h.meta() : Promise.resolve({})),
  },
  getApiErrorMessage: (_error: unknown, fallback: string) => fallback,
}));
vi.mock("@/context/ToastContext", () => ({ useToast: () => ({ showToast: h.toast }) }));
vi.mock("@/context/ModalContext", () => ({ useModal: () => ({}) }));
vi.mock("@/context/CloudContext", () => ({ useCloud: () => ({ connected: false }) }));
vi.mock("@/context/PlatformContext", () => ({ usePlatform: () => ({ selfHosted: false }) }));
vi.mock("./AccessEditorModal", () => ({ AccessEditorModal: () => null }));
vi.mock("./InviteMemberInline", () => ({ InviteMemberInline: () => null }));
vi.mock("./TeamReachabilityCard", () => ({ TeamReachabilityCard: () => null }));

const { team, common } = baseDictionary.settings;
const copy = team.workspace.manage;
let host: HTMLDivElement;
let root: Root;

function member(role: string) {
  return {
    id: "member-a",
    userId: "user-a",
    role,
    user: { id: "user-a", name: "Owner", email: "owner@example.test" },
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  h.organization.mockResolvedValue({ data: { id: "org_user-a", name: "Personal workspace" } });
  h.members.mockResolvedValue({ data: { members: [member("owner")] } });
  h.meta.mockResolvedValue({
    data: { organizationId: "org_user-a", isTeam: false, memberCount: 1 },
  });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

function button(label: string) {
  return [...host.querySelectorAll<HTMLButtonElement>("button")].find(
    (el) => el.textContent?.trim() === label,
  );
}

async function render() {
  await act(async () =>
    root.render(
      <I18nProvider>
        <TeamTab />
      </I18nProvider>,
    ),
  );
}

async function enterName(name: string) {
  await act(async () => button(copy.rename)!.click());
  const input = host.querySelector<HTMLInputElement>("form input")!;
  expect(input.labels?.[0]?.textContent?.trim()).toBe(copy.nameLabel);
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, name);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  return input;
}

it.each([false, true])(
  "lets the owner rename the active workspace from Team settings (team: %s)",
  async (isTeam) => {
    h.meta.mockResolvedValue({ data: { organizationId: "org_user-a", isTeam, memberCount: 1 } });
    h.update.mockResolvedValue({ data: { id: "org_user-a", name: "Studio" } });
    const renamed = vi.fn();
    window.addEventListener(WORKSPACE_NAME_CHANGED, renamed, { once: true });
    try {
      await render();
      expect(button(team.inviteMember)).toBeDefined();
      await enterName("  Studio  ");
      await act(async () => button(common.save)!.click());

      expect(h.update).toHaveBeenCalledExactlyOnceWith({
        organizationId: "org_user-a",
        data: { name: "Studio" },
      });
      expect(host.textContent).toContain("Studio");
      expect(renamed).toHaveBeenCalledOnce();
      expect(renamed.mock.calls[0][0].detail).toEqual({
        organizationId: "org_user-a",
        name: "Studio",
      });
      expect(document.activeElement).toBe(button(copy.rename));
    } finally {
      window.removeEventListener(WORKSPACE_NAME_CHANGED, renamed);
    }
  },
);

it("shows the name to another member and keeps owner actions hidden", async () => {
  h.members.mockResolvedValue({ data: { members: [member("member")] } });
  await render();
  expect(host.textContent).toContain("Personal workspace");
  expect(button(copy.rename)).toBeUndefined();
});

it("does not offer rename when the workspace and session disagree", async () => {
  h.meta.mockResolvedValue({ data: { organizationId: "other-org", isTeam: true, memberCount: 1 } });
  await render();
  expect(button(copy.rename)).toBeUndefined();
});

it("keeps the draft when the update is refused and lets the owner cancel", async () => {
  h.update.mockResolvedValue({ error: { message: "Rename denied" } });
  await render();
  const input = await enterName("New workspace");
  await act(async () => button(common.save)!.click());
  expect(input.value).toBe("New workspace");
  expect(h.toast).toHaveBeenCalledWith("Rename denied", "error", common.toast.team);
  await act(async () => button(common.cancel)!.click());
  expect(host.textContent).toContain("Personal workspace");
});
