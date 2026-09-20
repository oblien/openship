// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/components/i18n-provider";
import { baseDictionary } from "@/i18n";
import { DraftProjectView } from "./DraftProjectView";

const h = vi.hoisted(() => ({
  remove: vi.fn(),
  deployments: vi.fn(),
  navigate: vi.fn(),
  project: {
    id: "draft-a",
    name: "Draft A",
    gitOwner: "acme",
    gitRepo: "demo",
    activeDeploymentId: null,
  },
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: h.navigate }) }));
vi.mock("@/context/ProjectSettingsContext", () => ({
  useProjectSettings: () => ({ id: h.project.id, projectData: h.project }),
}));
vi.mock("@/lib/api", () => ({ projectsApi: { getDeployments: h.deployments } }));
vi.mock("@/app/(dashboard)/deployments/components", () => ({ DeploymentsContent: () => null }));

let host: HTMLDivElement;
let root: Root;
const copy = baseDictionary.projectSettings.deleteDialog;
function button(label: string) {
  const found = [...host.querySelectorAll("button")].find(
    (node) => node.textContent?.trim() === label,
  );
  expect(found, `button ${label}`).toBeDefined();
  return found!;
}
function dialog() {
  return host.querySelector('[role="alertdialog"]');
}
async function open() {
  await act(async () =>
    root.render(
      <I18nProvider>
        <DraftProjectView onDeleteProject={h.remove} />
      </I18nProvider>,
    ),
  );
  const trigger = button(baseDictionary.projects.draft.delete);
  trigger.focus();
  await act(async () => trigger.click());
  return trigger;
}
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  h.deployments.mockResolvedValue({ data: [] });
  h.remove.mockResolvedValue(undefined);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

describe("draft project deletion", () => {
  it("requires confirmation before calling the existing deletion handler", async () => {
    await open();
    expect(h.remove).not.toHaveBeenCalled();
    expect(dialog()?.textContent).toContain("Draft A");
    await act(async () => button(copy.delete).click());
    expect(h.remove).toHaveBeenCalledExactlyOnceWith();
    expect(dialog()).toBeNull();
  });
  it("cancels without deleting and returns focus to the trigger", async () => {
    const trigger = await open();
    await act(async () => button(copy.cancel).click());
    expect(h.remove).not.toHaveBeenCalled();
    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });
  it("dismisses on the backdrop but does not dismiss a click inside the dialog", async () => {
    await open();
    const content = dialog()!;
    await act(async () => content.querySelector("strong")!.click());
    expect(dialog()).toBe(content);
    await act(async () => (content.parentElement as HTMLElement).click());
    expect(dialog()).toBeNull();
    expect(h.remove).not.toHaveBeenCalled();
  });
  it("starts on Cancel, keeps keyboard focus inside, and lets Escape cancel", async () => {
    const trigger = await open();
    const cancel = button(copy.cancel);
    const confirm = button(copy.delete);
    expect(document.activeElement).toBe(cancel);
    await act(async () =>
      cancel.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Tab",
          shiftKey: true,
          bubbles: true,
          cancelable: true,
        }),
      ),
    );
    expect(document.activeElement).toBe(confirm);
    await act(async () =>
      confirm.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }),
      ),
    );
    expect(document.activeElement).toBe(cancel);
    await act(async () =>
      cancel.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
      ),
    );
    expect(h.remove).not.toHaveBeenCalled();
    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });
  it("does not start another deletion while the confirmed request is pending", async () => {
    let finish!: () => void;
    h.remove.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const trigger = await open();
    await act(async () => button(copy.delete).click());
    expect(trigger.disabled).toBe(true);
    await act(async () => trigger.click());
    expect(h.remove).toHaveBeenCalledTimes(1);
    await act(async () => finish());
    expect(trigger.disabled).toBe(false);
  });
});
