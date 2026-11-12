// @vitest-environment happy-dom
import { act, useState, type ComponentProps, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { baseDictionary } from "@/i18n";
import { ModalProvider } from "@/context/ModalContext";
import { ProjectSettingsProvider, useProjectSettings } from "@/context/ProjectSettingsContext";
import { BuildSettings } from "./BuildSettings";
import { AppConfiguration } from "./AppConfiguration";
import { ProjectApplicationPanel } from "./services/ProjectApplicationPanel";

const api = vi.hoisted(() => ({
  getEnv: vi.fn(),
  mergeEnv: vi.fn(),
  services: vi.fn(),
  toast: vi.fn(),
  trigger: vi.fn(),
  inspectCaches: vi.fn(),
  push: vi.fn(),
  connections: vi.fn(),
}));
vi.mock("@/lib/api", () => ({
  projectsApi: { getEnv: api.getEnv, mergeEnv: api.mergeEnv, getCommitStatus: async () => ({ data: { supported: false } }) },
  servicesApi: { list: api.services },
  deployApi: { trigger: api.trigger },
  getApiErrorMessage: (_error: unknown, fallback: string) => fallback,
}));
vi.mock("@/lib/api/client", () => ({
  ApiError: class extends Error {},
  api: { post: api.inspectCaches },
  getApiRequestScopeVersion: () => 0,
  getApiErrorMessage: (_error: unknown, fallback: string) => fallback,
}));
vi.mock("@/lib/api/projects", () => ({ projectsApi: { getEnv: api.getEnv } }));
vi.mock("@/lib/api/connections", () => ({ connectionsApi: { list: api.connections } }));
vi.mock("@/components/services/RuntimeRoles", () => ({ RuntimeRolesCard: () => null }));
vi.mock("@/components/services/RuntimeRoleConfiguration", () => ({ RuntimeRoleConfigurationControl: () => null }));
vi.mock("@/hooks/useProjectEndpoints", () => ({
  useProjectInfo: () => ({ isLoading: false }),
  invalidateProjectCachesFor: vi.fn(),
  PROJECT_INFO_NOT_FOUND: "missing",
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: api.push, replace: vi.fn() }) }));
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
  api.connections.mockResolvedValue({ data: [] });
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
  api.trigger.mockReset().mockResolvedValue({ data: { deployment: { id: "next-deployment" } } });
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
function RoutedSettings({ children }: { children: ReactNode }) {
  const [environment, setEnvironment] = useState(false);
  return <div onClick={event => {
    if ((event.target as HTMLElement).closest('a[href$="/application/env"]')) {
      event.preventDefault(); setEnvironment(true);
    }
  }}>{environment ? <ProjectApplicationPanel /> : children}</div>;
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
        id="project" slug={["services", "application", "env"]}
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
        <RoutedSettings>{children}</RoutedSettings>
      </ProjectSettingsProvider></ModalProvider>,
    ),
  );
}
function button(label: string) {
  const element = [...document.querySelectorAll<HTMLButtonElement>("button,a")].find(
    (el) => el.textContent?.trim().replace(/ →$/, "") === label,
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
  it("opens the shared editor directly for a bare app and keeps apply separate from save", async () => {
    await mountProject("nextjs", <ProjectApplicationPanel />, { runtimeMode: "bare" });
    expect(document.querySelector('input[value="BUILD_VALUE"]')).not.toBeNull();
    expect(button("Apply & restart").disabled).toBe(false);
    expect(document.body.textContent).not.toContain("Compose");
    expect(document.body.textContent).toContain("Edit as text");
    await editInput([...document.querySelectorAll("input")].find(input => input.value === "old")!, "new");
    expect(button("Apply & restart").disabled).toBe(true);
    expect(button("Rebuild and redeploy").disabled).toBe(true);
    await act(async () => button("Save").click());
    expect(api.trigger).not.toHaveBeenCalled();
    expect(api.mergeEnv).toHaveBeenCalledWith("project", {
      environment: "production", upserts: [{ key: "BUILD_VALUE", value: "new", isSecret: false }], deletes: [],
    });
    await act(async () => button("Apply & restart").click());
    expect(api.trigger).toHaveBeenCalledExactlyOnceWith({ projectId: "project", refresh: true });
    expect(document.querySelector('a[href="/build/next-deployment"]')).not.toBeNull();
    expect(document.body.textContent).toContain("Environment update started");
    expect(document.body.textContent).not.toContain("matches the saved environment");
    expect(api.push).not.toHaveBeenCalled();
  });

  it("keeps Apply available after revisiting the app Environment tab without another save", async () => {
    await mountProject("node", <BuildSettings />, { runtimeMode: "bare" });
    await act(async () => button("Edit").click());
    await editInput([...document.querySelectorAll("input")].find(input => input.value === "old")!, "new");
    await act(async () => button("Save").click());
    await act(async () => button("Overview").click());
    await act(async () => button("Environment").click());
    expect(button("Apply & restart").disabled).toBe(false);
    await act(async () => button("Apply & restart").click());
    expect(api.mergeEnv).toHaveBeenCalledOnce();
    expect(api.trigger).toHaveBeenCalledExactlyOnceWith({ projectId: "project", refresh: true });
  });

  it("uses text editing without sending or deleting an untouched saved secret", async () => {
    await mountProject("node", <ProjectApplicationPanel />, { runtimeMode: "bare" });
    await act(async () => button("Edit as text").click());
    const input = document.querySelector("textarea")!;
    expect(input.value).toContain("TOKEN=••••••••");
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(
        input, input.value.replace("BUILD_VALUE=old", "BUILD_VALUE=updated"),
      );
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => button("Apply changes").click());
    expect(api.mergeEnv).not.toHaveBeenCalled();
    await act(async () => button("Save").click());
    expect(api.mergeEnv).toHaveBeenCalledExactlyOnceWith("project", {
      environment: "production", upserts: [{ key: "BUILD_VALUE", value: "updated", isSecret: false }], deletes: [],
    });
  });

  it("keeps connection-managed values outside the editable rows and preserves them on save", async () => {
    api.connections.mockResolvedValue({ data: [{ id: "link", envKey: "TOKEN", sourceName: "Database", mode: "internal" }] });
    await mountProject("node", <ProjectApplicationPanel />, { runtimeMode: "bare" });
    expect(document.querySelector('input[value="TOKEN"]')).toBeNull();
    expect(document.body.textContent).toContain("via Database");
    await editInput([...document.querySelectorAll("input")].find(input => input.value === "old")!, "new");
    await act(async () => button("Save").click());
    expect(api.mergeEnv).toHaveBeenCalledExactlyOnceWith("project", {
      environment: "production", upserts: [{ key: "BUILD_VALUE", value: "new", isSecret: false }], deletes: [],
    });
  });

  it("deduplicates Apply while a request is in flight and locks the editor", async () => {
    let resolve!: (value: unknown) => void;
    api.trigger.mockReturnValueOnce(new Promise(done => { resolve = done; }));
    await mountProject("node", <ProjectApplicationPanel />, { runtimeMode: "bare" });
    const apply = button("Apply & restart");
    await act(async () => { apply.click(); apply.click(); });
    expect(api.trigger).toHaveBeenCalledOnce();
    const input = document.querySelector<HTMLInputElement>('input[value="BUILD_VALUE"]')!;
    expect(input.readOnly).toBe(true);
    expect(input.closest("fieldset")!.disabled).toBe(true);
    await act(async () => resolve({ data: { deployment: { id: "queued" } } }));
    expect(button("Apply & restart").disabled).toBe(false);
    expect(document.querySelector('a[href="/build/queued"]')).not.toBeNull();
  });

  it("retains saved variables and allows retry when starting an apply fails", async () => {
    api.trigger.mockRejectedValueOnce(new Error("unavailable"));
    await mountProject("node", <ProjectApplicationPanel />, { runtimeMode: "bare" });
    await act(async () => button("Apply & restart").click());
    expect(document.querySelector('input[value="BUILD_VALUE"]')).not.toBeNull();
    expect(button("Apply & restart").disabled).toBe(false);
    expect(document.querySelector('a[href="/build/next-deployment"]')).toBeNull();
    await act(async () => button("Apply & restart").click());
    expect(api.trigger).toHaveBeenCalledTimes(2);
    expect(api.mergeEnv).not.toHaveBeenCalled();
  });

  it("requires known connection ownership before editing and supports retry", async () => {
    api.connections.mockRejectedValueOnce(new Error("unavailable"));
    await mountProject("node", <ProjectApplicationPanel />, { runtimeMode: "bare" });
    expect(document.querySelector('input[value="BUILD_VALUE"]')).toBeNull();
    expect(document.querySelector('[role="alert"]')).not.toBeNull();
    expect(button("Save").disabled).toBe(true);
    expect(button("Apply & restart").disabled).toBe(true);
    await act(async () => button("Reload environment").click());
    expect(document.querySelector('input[value="BUILD_VALUE"]')).not.toBeNull();
    expect(api.mergeEnv).not.toHaveBeenCalled();
  });

  it("explains shared scope when a primary app has companion services", async () => {
    api.services.mockResolvedValue({ success: true, services: [{ id: "cache", name: "redis", kind: "compose" }] });
    await mountProject("node", <ProjectApplicationPanel />, { runtimeMode: "bare" });
    expect(document.body.textContent).toContain("shared with this project’s services");
    await act(async () => button("Apply to project").click());
    expect(api.trigger).toHaveBeenCalledExactlyOnceWith({ projectId: "project", refresh: true });
  });

  it.each([
    {
      framework: "static",
      deployTarget: "server" as const,
      options: { workloadType: "static" as const, hasServer: false },
    },
    { framework: "node", deployTarget: "server" as const, options: { hasServer: false } },
    { framework: "node", deployTarget: "cloud" as const, options: { workloadType: "web" as const } },
  ])(
    "rebuilds saved environment changes for $framework on $deployTarget",
    async ({ framework, ...extra }) => {
      await mountProject(framework, <BuildSettings />, extra);
      await act(async () => button("Edit").click());
      await editInput(
        [...document.querySelectorAll("input")].find((input) => input.value === "old")!,
        "new",
      );
      await act(async () => button("Save").click());
      expect(api.trigger).not.toHaveBeenCalled();
      expect(document.body.textContent).not.toContain("Apply without a rebuild");
      await act(async () => button("Rebuild and redeploy").click());
      expect(api.trigger).toHaveBeenCalledExactlyOnceWith({ projectId: "project", smartRoute: true });
      expect(api.push).toHaveBeenCalledWith("/build/next-deployment");
      expect(api.mergeEnv).toHaveBeenCalledOnce();
    },
  );

  it.each([
    {
      framework: "node",
      deployTarget: "server" as const,
      options: { workloadType: "worker" as const, hasServer: false },
    },
    { framework: "docker-compose", deployTarget: "cloud" as const, options: {} },
  ])("preserves runtime refresh for $framework on $deployTarget", async ({ framework, ...extra }) => {
    await mountProject(framework, <BuildSettings />, extra);
    await act(async () => button("Edit").click());
    await editInput(
      [...document.querySelectorAll("input")].find((input) => input.value === "old")!,
      "new",
    );
    await act(async () => button("Save").click());
    await act(async () => button("Apply & restart").click());
    expect(api.trigger).toHaveBeenCalledExactlyOnceWith({ projectId: "project", refresh: true });
    expect(api.push).not.toHaveBeenCalled();
  });

  it("keeps a static site's saved values available when starting the rebuild fails", async () => {
    api.trigger.mockRejectedValueOnce(new Error("unavailable"));
    await mountProject("static", <BuildSettings />, { options: { workloadType: "static" } });
    await act(async () => button("Edit").click());
    await editInput(
      [...document.querySelectorAll("input")].find((input) => input.value === "old")!,
      "new",
    );
    await act(async () => button("Save").click());
    await act(async () => button("Rebuild and redeploy").click());
    expect(api.push).not.toHaveBeenCalled();
    expect(api.toast).toHaveBeenLastCalledWith(
      baseDictionary.projects.redeploy.couldNotRedeploy,
      "error",
      baseDictionary.projects.redeploy.errorTitle,
    );
    await act(async () => button("Rebuild and redeploy").click());
    expect(api.push).toHaveBeenCalledWith("/build/next-deployment");
    expect(api.mergeEnv).toHaveBeenCalledOnce();
  });

  it.each(["nextjs", "docker-compose"])(
    "keeps %s Settings reachable and edits shared project inputs without overwriting secrets",
    async (framework) => {
      await mountProject(framework);
      expect(host.querySelector('nav a[href$="/advanced"]')).not.toBeNull();
      expect(host.textContent).toContain(framework === "docker-compose" ? "Project environment" : "Environment");
      await act(async () => button("Edit").click());
      expect(api.getEnv).toHaveBeenCalledWith("project");
      const value = [...document.querySelectorAll("input")].find((input) => input.value === "old")!;
      expect(value).toBeDefined();
      expect(
        [...document.querySelectorAll("input")].some((input) => input.value === "PREVIEW_ONLY"),
      ).toBe(false);
      const secret = document.querySelector<HTMLInputElement>(
        'input[placeholder="••••••••"]',
      )!;
      expect(secret.value).toBe("");
      await editInput(value, "new");
      await act(async () => button("Save").click());
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
    expect(host.textContent).toContain("Shared project environment");
    expect(host.querySelector('nav a[href$="/advanced"]')).not.toBeNull();
    expect(host.querySelectorAll('section[aria-label="Machine power"]')).toHaveLength(1);
  });

  it("shows installed-app and project settings together without a second service list", async () => {
    await mountProject("docker-compose", <AppConfiguration />, {
      isApp: true,
      appTemplateId: "mongodb",
    });
    expect(host.textContent).toContain("Project environment");
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
    expect(host.textContent).toContain(hasCompanion ? "Shared project environment" : "Environment");
  });
});
