// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { I18nProvider } from "@/components/i18n-provider";
import { ProfileSetting } from "@/app/(dashboard)/settings/_components/ProfileSetting";
import { ProjectIconSetting } from "@/components/project-settings/ProjectIconSetting";

const h = vi.hoisted(() => ({
  profile: vi.fn(),
  project: vi.fn(),
  update: vi.fn(),
  invalidate: vi.fn(),
}));
vi.mock("@/context/AuthContext", () => ({
  useAuth: () => ({ user: { name: "Ada", email: "ada@example.test", image: null } }),
}));
vi.mock("@/lib/auth-client", () => ({ authClient: { updateUser: h.profile } }));
vi.mock("@/context/ProjectSettingsContext", () => ({
  useProjectSettings: () => ({
    projectData: { id: "project-a", iconUrl: "https://cdn.example.test/old.png" },
    updateProjectData: h.update,
  }),
}));
vi.mock("@/lib/api", () => ({ projectsApi: { update: h.project } }));
vi.mock("@/hooks/useProjectEndpoints", () => ({ invalidateProjectCaches: h.invalidate }));
let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  h.profile.mockResolvedValue({ data: { status: true }, error: null });
  h.project.mockImplementation(async (_id, data) => ({ data }));
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

it("saves the avatar through the current user's existing auth update", async () => {
  await act(async () =>
    root.render(
      <I18nProvider>
        <ProfileSetting />
      </I18nProvider>,
    ),
  );
  await act(async () => host.querySelector<HTMLButtonElement>("button")!.click());
  await act(async () => {
    const input = host.querySelector("input")!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
      input,
      "https://cdn.example.test/avatar.png",
    );
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () =>
    host
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
  );
  expect(h.profile).toHaveBeenCalledWith({ image: "https://cdn.example.test/avatar.png" });
});

it("clears the single project icon field through existing settings", async () => {
  const onClose = vi.fn();
  await act(async () =>
    root.render(
      <I18nProvider>
        <ProjectIconSetting onClose={onClose} />
      </I18nProvider>,
    ),
  );
  const dialog = document.querySelector('[role="dialog"]')!;
  expect(dialog.querySelector('input[type="url"]')).not.toBeNull();
  await act(async () =>
    Array.from(dialog.querySelectorAll("button"))
      .find((button) => button.textContent === "Use default icon")!
      .click(),
  );
  expect(h.project).toHaveBeenCalledWith("project-a", { iconUrl: null });
  expect(h.update).toHaveBeenCalledWith({
    iconUrl: null,
  });
  expect(h.invalidate).toHaveBeenCalledWith("project-a");
  expect(onClose).toHaveBeenCalledOnce();
});
