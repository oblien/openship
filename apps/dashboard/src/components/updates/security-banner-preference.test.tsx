// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { baseDictionary } from "@/i18n";
import { UpdateCenter } from "./UpdateCenter";
import { SecurityAdvisorySettings } from "@/app/(dashboard)/settings/_components/SecurityAdvisorySettings";

const h = vi.hoisted(() => ({ account: "account-one", updates: vi.fn(), push: vi.fn() }));
vi.mock("@/context/CloudResourceContext", () => ({ useCloudResourceKey: () => h.account }));
vi.mock("@/components/i18n-provider", async (original) => ({
  ...(await original<object>()),
  useI18n: () => ({ t: baseDictionary }),
}));
vi.mock("next/navigation", () => ({ usePathname: () => "/", useRouter: () => ({ push: h.push }) }));
vi.mock("./useUpdates", () => ({ useUpdates: h.updates }));

const copy = baseDictionary.projectSettings.securityAdvisories;
const project = {
  projectId: "esge",
  name: "esge",
  findings: [{ id: "node", evidence: ["node 20.20.2"], serviceName: null }],
};
const runtime = {
  id: "runtime:node",
  title: "Update Node.js for the Brotli security fix",
  severity: "critical",
  projects: [project],
};
const overview = { projects: [project], pendingProjects: 0, unknownProjects: 0 };
let root: Root;
let container: HTMLDivElement;
function render() {
  root.render(
    <>
      <UpdateCenter />
      <SecurityAdvisorySettings />
    </>,
  );
}
function button(label: string) {
  const found = [...document.querySelectorAll("button")].find(
    (item) => item.getAttribute("aria-label") === label || item.textContent === label,
  );
  expect(found, label).toBeDefined();
  return found!;
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  h.account = "account-one";
  localStorage.clear();
  h.updates.mockReturnValue({
    state: {
      advisories: [
        runtime,
        { id: "maintenance", title: "Scheduled maintenance", severity: "critical" },
      ],
    },
    runtimeAdvisories: [runtime],
    securityOverview: overview,
    desktop: false,
    mode: "cloud",
    refresh: vi.fn(),
    dismissAdvisory: vi.fn(),
    updatePhase: "idle",
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it("hides critical runtime banners immediately, persists the choice, and restores it from Settings", async () => {
  await act(async () => render());
  expect(container.textContent).toContain(runtime.title);
  await act(async () => button(copy.bannerSettings).click());
  await act(async () => button(copy.hideBanners).click());
  expect(container.textContent).not.toContain(runtime.title);
  expect(container.textContent).toContain("Scheduled maintenance");
  expect(button(copy.showBanners).getAttribute("aria-checked")).toBe("false");
  expect(localStorage.getItem("openship_security_banners:account-one")).toBe("0");
  // Hiding the banner never mutates findings or per-project automatic-update consent.
  expect(h.updates().securityOverview).toBe(overview);
  expect(overview.projects[0].findings).toHaveLength(1);

  await act(async () => root.render(null));
  await act(async () => render());
  expect(container.textContent).not.toContain(runtime.title);
  h.account = "account-two";
  await act(async () => render());
  expect(container.textContent).toContain(runtime.title);
  h.account = "account-one";
  await act(async () => render());
  expect(container.textContent).not.toContain(runtime.title);
  await act(async () => button(copy.showBanners).click());
  expect(container.textContent).toContain(runtime.title);
  expect(localStorage.getItem("openship_security_banners:account-one")).toBe("1");
});

it("shares a visibility change from another browser tab", async () => {
  await act(async () => render());
  const key = "openship_security_banners:account-one";
  await act(async () => {
    localStorage.setItem(key, "0");
    window.dispatchEvent(new StorageEvent("storage", { key, newValue: "0" }));
  });
  expect(container.textContent).not.toContain(runtime.title);
  expect(button(copy.showBanners).getAttribute("aria-checked")).toBe("false");
});
