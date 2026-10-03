// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { I18nProvider } from "@/components/i18n-provider";
import { ModalProvider } from "@/context/ModalContext";
import ProjectsPage from "./page";
import { baseDictionary } from "@/i18n";

const h = vi.hoisted(() => ({ home: vi.fn(), updates: vi.fn() }));
vi.mock("@/lib/api", () => ({ projectsApi: { getHome: h.home }, getApiErrorMessage: (error: Error) => error.message }));
vi.mock("@/lib/api/updates", () => ({ updatesApi: { list: h.updates } }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/context/PlatformContext", () => ({ usePlatform: () => ({ selfHosted: true }) }));
vi.mock("@/components/HelpMenu", () => ({ HelpMenu: () => null }));

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear();
  const common = { framework: "docker", createdAt: "2026-09-01T00:00:00Z", deployTarget: "server", serverId: "server1", serverName: "Server" };
  h.home.mockResolvedValue({ success: true, projects: [
    { ...common, id: "custom", name: "Custom website", slug: "custom", activeDeploymentId: "deploy1", isApp: false },
    { ...common, id: "catalog", name: "Catalog automation", slug: "catalog", activeDeploymentId: "deploy2", isApp: true, appTemplateId: "n8n" },
    { ...common, id: "draft", name: "Draft catalog app", slug: "draft", isApp: true, appTemplateId: "convex" },
  ] });
  h.updates.mockResolvedValue({ data: [{ projectId: "catalog" }] });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it.each(["grid", "list"])("keeps catalog apps out of the project %s view", async (view) => {
  localStorage.setItem("openship-projects-view", view);
  await act(async () => root.render(<I18nProvider><ModalProvider><ProjectsPage /></ModalProvider></I18nProvider>));
  expect(container.textContent).toContain("Custom website");
  expect(container.textContent).not.toContain("Catalog automation");
  expect(container.textContent).not.toContain("Draft catalog app");
  expect(container.querySelector('a[href="/projects/custom"]')).not.toBeNull();
  expect(container.querySelector('a[href="/projects/catalog"]')).toBeNull();
});
