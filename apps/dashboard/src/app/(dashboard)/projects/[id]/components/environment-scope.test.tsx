// @vitest-environment happy-dom
import { act, type ComponentProps, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { baseDictionary } from "@/i18n";
import { ModalProvider } from "@/context/ModalContext";
import { ProjectSettingsProvider, useProjectSettings } from "@/context/ProjectSettingsContext";
import { BuildSettings } from "./BuildSettings";
import { AppConfiguration } from "./AppConfiguration";
import { ServiceEnvironmentScope } from "./services/ServiceEnvironmentScope";

const api = vi.hoisted(() => ({
  getEnv: vi.fn(),
  mergeEnv: vi.fn(),
  services: vi.fn(),
  toast: vi.fn(),
  trigger: vi.fn(),
}));
vi.mock("@/lib/api", () => ({
  projectsApi: { getEnv: api.getEnv, mergeEnv: api.mergeEnv },
  servicesApi: { list: api.services },
  deployApi: { trigger: api.trigger },
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
vi.mock("./ResourceSettings", () => ({ ResourceSettings: () => null }));
vi.mock("./StorageSettings", () => ({ StorageSettings: () => null }));
vi.mock("./ServicesTab", () => ({ ServicesTab: () => <div>Service list</div> }));
vi.mock("./AppSettingsTab", () => ({ AppSettingsTab: () => null }));

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  api.services.mockResolvedValue({ success: true, services: [] });
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
    "keeps %s Configuration reachable and edits shared project inputs without overwriting secrets",
    async (framework) => {
      await mountProject(framework);
      expect(host.querySelector('nav a[href$="/runtime"]')).not.toBeNull();
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
    expect(host.textContent).toContain("1 sub-app");
    expect(host.textContent).toContain("Project environment (build + shared runtime)");
    expect(host.querySelector('nav a[href$="/runtime"]')).not.toBeNull();
  });

  it("includes shared project inputs in the installed app's Deployment mode", async () => {
    await mountProject("docker-compose", <AppConfiguration />, {
      isApp: true,
      appTemplateId: "n8n",
    });
    await act(async () => button("Deployment").click());
    expect(host.textContent).toContain("Project environment (build + shared runtime)");
    expect(host.textContent).toContain("Service list");
  });
});

describe("service runtime scope", () => {
  const scopeCopy = baseDictionary.projectSettings.serviceEnvironment;
  const info = () => host.querySelector<HTMLButtonElement>(`button[aria-label="${scopeCopy.title}"]`)!;
  const openInfo = async () => { await act(async () => info().click()); };

  it("keeps guidance behind Info, reads matching keys on demand, and never renders project values", async () => {
    await act(async () =>
      root.render(
        <ServiceEnvironmentScope
          projectId="project"
          keys={["TOKEN", "PREVIEW_ONLY", "SERVICE_ONLY", "TOKEN"]}
        />,
      ),
    );
    expect(host.textContent).not.toContain(scopeCopy.description);
    expect(info().getAttribute("aria-expanded")).toBe("false");
    expect(api.getEnv).not.toHaveBeenCalled();
    await openInfo();
    expect(info().getAttribute("aria-expanded")).toBe("true");
    expect(host.textContent).toContain(
      "These keys take precedence over project values for this service: TOKEN.",
    );
    expect(host.textContent).not.toContain("PREVIEW_ONLY");
    expect(host.textContent).not.toContain("••••••••");
    expect(host.textContent).toContain(scopeCopy.buildArguments);
    expect(host.querySelector('a[href="/projects/project/runtime"]')).not.toBeNull();
    await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
    expect(info().getAttribute("aria-expanded")).toBe("false");
    expect(host.textContent).not.toContain(scopeCopy.description);
  });

  it("keeps scope guidance when project key lookup fails", async () => {
    api.getEnv.mockRejectedValue(new Error("offline"));
    await act(async () =>
      root.render(<ServiceEnvironmentScope projectId="project" keys={["TOKEN"]} />),
    );
    await openInfo();
    expect(host.textContent).toContain("Could not load project variable names");
    expect(host.textContent).toContain(scopeCopy.description);
    expect(host.textContent).not.toContain("These keys take precedence");
  });

  it("does not display keys from the previous project while navigating", async () => {
    let release!: (value: unknown) => void;
    api.getEnv.mockReturnValueOnce(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    await act(async () =>
      root.render(<ServiceEnvironmentScope projectId="old-project" keys={["TOKEN"]} />),
    );
    await openInfo();
    api.getEnv.mockResolvedValue({ data: [] });
    await act(async () =>
      root.render(<ServiceEnvironmentScope projectId="new-project" keys={["TOKEN"]} />),
    );
    await act(async () => release({ data: [{ key: "TOKEN", environment: "production" }] }));
    expect(host.textContent).not.toContain("These keys take precedence");
    expect(host.querySelector('a[href="/projects/new-project/runtime"]')).not.toBeNull();
  });
});
