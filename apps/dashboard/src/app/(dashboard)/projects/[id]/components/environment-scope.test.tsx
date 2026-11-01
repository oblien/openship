// @vitest-environment happy-dom
import { act, type ComponentProps, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { baseDictionary } from "@/i18n";
import { ModalProvider } from "@/context/ModalContext";
import { ProjectSettingsProvider, useProjectSettings } from "@/context/ProjectSettingsContext";
import { BuildSettings } from "./BuildSettings";
import { AppConfiguration } from "./AppConfiguration";

const api = vi.hoisted(() => ({
  getEnv: vi.fn(),
  mergeEnv: vi.fn(),
  services: vi.fn(),
  toast: vi.fn(),
  trigger: vi.fn(),
  inspectCaches: vi.fn(),
}));
vi.mock("@/lib/api", () => ({
  projectsApi: { getEnv: api.getEnv, mergeEnv: api.mergeEnv, getCommitStatus: async () => ({ data: { supported: false } }) },
  servicesApi: { list: api.services },
  deployApi: { trigger: api.trigger },
  getApiErrorMessage: (_error: unknown, fallback: string) => fallback,
}));
vi.mock("@/lib/api/client", () => ({
  api: { post: api.inspectCaches },
  getApiRequestScopeVersion: () => 0,
}));
vi.mock("@/lib/api/projects", () => ({ projectsApi: { getEnv: api.getEnv } }));
vi.mock("@/lib/api/connections", () => ({ connectionsApi: { list: async () => ({ data: [] }) } }));
vi.mock("@/hooks/useProjectEndpoints", () => ({
  useProjectInfo: () => ({ isLoading: false }),
  invalidateProjectCachesFor: vi.fn(),
  PROJECT_INFO_NOT_FOUND: "missing",
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }) }));
vi.mock("@/context/PlatformContext", () => ({ usePlatform: () => ({ isServerHost: true }) }));
vi.mock("@/context/ToastContext", () => ({ useToast: () => ({ showToast: api.toast }) }));
vi.mock("@/components/i18n-provider", () => ({
  useI18n: () => ({ t: baseDictionary }),
  interpolate: (text: string, values: Record<string, string>) =>
    text.replace(/\{(\w+)\}/g, (_, key) => values[key] ?? key),
}));
// The independent resource/app forms aren't under test. The real provider,
// Configuration surface, project env editor and modal run together.
vi.mock("./ResourceSettings", () => ({ ResourceSettings: () => <section aria-label="Machine power" /> }));
vi.mock("./StorageSettings", () => ({ StorageSettings: () => null }));
vi.mock("./ServicesTab", () => ({ ServicesTab: () => <div>Service list</div> }));
vi.mock("./AppSettingsTab", () => ({ AppSettingsTab: () => <input aria-label="App setting" defaultValue="original" /> }));

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  api.services.mockResolvedValue({ success: true, services: [] });
  api.inspectCaches.mockResolvedValue({ data: { candidates: [], canMigrate: false } });
  api.getEnv.mockResolvedValue({
    data: [
      { id: "build", key: "BUILD_VALUE", value: "old", environment: "production", isSecret: false },
      { id: "secret", key: "TOKEN", value: "••••••••", environment: "production", isSecret: true },
      {
        id: "preview",
        key: "PREVIEW_ONLY",
        value: "preview",
        environment: "preview",
        isSecret: false,
      },
    ],
  });
  api.mergeEnv.mockResolvedValue({ upserted: 1, deleted: 0 });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

function TabsProbe() {
  const { tabs } = useProjectSettings();
  return (
    <nav>
      {tabs.map((tab) => (
        <a key={tab.id} href={`/projects/project/${tab.id}`}>
          {tab.label}
        </a>
      ))}
    </nav>
  );
}
async function mountProject(
  framework: string,
  children: ReactNode = <BuildSettings />,
  extra: Partial<
    NonNullable<ComponentProps<typeof ProjectSettingsProvider>["initialProjectData"]>
  > = {},
) {
  await act(async () =>
    root.render(
      <ModalProvider><ProjectSettingsProvider
        id="project"
        initialProjectData={{
          id: "project",
          name: "Test",
          slug: "test",
          description: "",
          framework,
          activeDeploymentId: "live",
          ...extra,
        }}
      >
        <TabsProbe />
        {children}
      </ProjectSettingsProvider></ModalProvider>,
    ),
  );
}
function button(label: string) {
  const element = [...document.querySelectorAll("button")].find(
    (el) => el.textContent?.trim() === label,
  );
  expect(element, `button ${label}`).toBeDefined();
  return element!;
}
async function editInput(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("project environment access (GH-881)", () => {
  it.each(["nextjs", "docker-compose"])(
    "keeps %s Settings reachable and edits shared project inputs without overwriting secrets",
    async (framework) => {
      await mountProject(framework);
      expect(host.querySelector('nav a[href$="/advanced"]')).not.toBeNull();
      expect(host.textContent).toContain("Project environment (build + shared runtime)");
      await act(async () => button("Edit").click());
      expect(api.getEnv).toHaveBeenCalledWith("project");
      const value = [...document.querySelectorAll("input")].find((input) => input.value === "old")!;
      expect(value).toBeDefined();
      expect(
        [...document.querySelectorAll("input")].some((input) => input.value === "PREVIEW_ONLY"),
      ).toBe(false);
      const secret = document.querySelector<HTMLInputElement>(
        'input[placeholder*="set — type to replace"]',
      )!;
      expect(secret.value).toBe("");
      await editInput(value, "new");
      await act(async () => button("Save changes").click());
      expect(api.mergeEnv).toHaveBeenCalledExactlyOnceWith("project", {
        environment: "production",
        upserts: [{ key: "BUILD_VALUE", value: "new", isSecret: false }],
        deletes: [],
      });
      expect(document.body.textContent).toContain("Rebuild and redeploy");
      expect(api.trigger).not.toHaveBeenCalled();
    },
  );

  it("keeps the shared editor for monorepos", async () => {
    api.services.mockResolvedValue({ success: true, services: [{ id: "sub", name: "api", kind: "monorepo" }] });
    await mountProject("node");
    expect(host.textContent).toContain("Project environment (build + shared runtime)");
    expect(host.querySelector('nav a[href$="/advanced"]')).not.toBeNull();
    expect(host.querySelectorAll('section[aria-label="Machine power"]')).toHaveLength(1);
  });

  it("shows installed-app and project settings together without a second service list", async () => {
    await mountProject("docker-compose", <AppConfiguration />, {
      isApp: true,
      appTemplateId: "mongodb",
    });
    expect(host.textContent).toContain("Project environment (build + shared runtime)");
    expect(host.textContent).not.toContain("Service list");
    expect(host.querySelectorAll('section[aria-label="Machine power"]')).toHaveLength(1);
    const actions = [...host.querySelectorAll("button")].map((element) => element.textContent?.trim());
    expect(actions).not.toContain("App settings");
    expect(actions).not.toContain("Deployment");

    const appInput = host.querySelector<HTMLInputElement>('input[aria-label="App setting"]')!;
    await editInput(appInput, "unsaved app setting");
    await act(async () => button("Edit").click());
    expect(api.getEnv).toHaveBeenCalledWith("project");
    expect(host.querySelector('input[aria-label="App setting"]')).toBe(appInput);
    expect(appInput.value).toBe("unsaved app setting");
  });

  it.each([false, true])("keeps limits available for a static site's companion services (%s)", async (hasCompanion) => {
    api.services.mockResolvedValue({ success: true, services: hasCompanion
      ? [{ id: "cache", name: "redis", kind: "compose" }]
      : [] });
    await mountProject("static", <BuildSettings />, { options: { hasServer: false, workloadType: "static" } });
    expect(host.querySelectorAll('section[aria-label="Machine power"]')).toHaveLength(hasCompanion ? 1 : 0);
    expect(host.textContent).toContain("Project environment (build + shared runtime)");
  });
});
