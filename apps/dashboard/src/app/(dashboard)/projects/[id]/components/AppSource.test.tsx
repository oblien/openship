// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { baseDictionary } from "@/i18n";
import { AppSource } from "./AppSource";

const h = vi.hoisted(() => ({ list: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/context/ProjectSettingsContext", () => ({
  useProjectSettings: () => ({ id: "project-a", projectData: {} }),
}));
vi.mock("@/context/ToastContext", () => ({ useToast: () => ({ showToast: vi.fn() }) }));
vi.mock("@/components/i18n-provider", () => ({
  useI18n: () => ({ t: baseDictionary }),
  interpolate: (text: string) => text,
}));
vi.mock("@/lib/api/updates", () => ({ updatesApi: { list: h.list } }));
vi.mock("@/components/AppLogo", () => ({ AppLogo: () => null }));
let root: Root, container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it.each([null, "alpine"])(
  "does not present an unknown running image as up to date (latest=%s)",
  async (latest) => {
    h.list.mockResolvedValue({
      data: [
        {
          projectId: "project-a",
          kind: "image",
          behind: false,
          unverified: true,
          latestInProgress: false,
          currentLabel: "alpine",
          latestLabel: latest,
        },
      ],
    });
    await act(async () => {
      root.render(<AppSource />);
    });
    expect(container.textContent).toContain(baseDictionary.projectSettings.appSource.unverified);
    expect(container.textContent).not.toContain(baseDictionary.projectSettings.appSource.upToDate);
    expect(
      [...container.querySelectorAll("button")].map((button) => button.textContent),
    ).not.toContain(baseDictionary.projectSettings.appSource.update);
  },
);

it("keeps the confirmed current state for verified images", async () => {
  h.list.mockResolvedValue({
    data: [
      {
        projectId: "project-a",
        kind: "image",
        behind: false,
        unverified: false,
        latestInProgress: false,
        currentLabel: "alpine",
        latestLabel: "alpine",
      },
    ],
  });
  await act(async () => {
    root.render(<AppSource />);
  });
  expect(container.textContent).toContain(baseDictionary.projectSettings.appSource.upToDate);
  expect(container.textContent).not.toContain(baseDictionary.projectSettings.appSource.unverified);
});
