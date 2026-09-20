// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { baseDictionary } from "@/i18n";
import { ProjectSettingsProvider, useProjectSettings } from "@/context/ProjectSettingsContext";
import { ProjectMobileTabs, ProjectSidebar } from "./ProjectSidebar";
import { ProjectTabSections } from "./ProjectTabSections";

vi.mock("@/lib/api", () => ({
  projectsApi: {},
  servicesApi: { list: async () => ({ services: [] }) },
}));
vi.mock("@/hooks/useProjectEndpoints", () => ({
  useProjectInfo: () => ({ isLoading: false }),
  PROJECT_INFO_NOT_FOUND: "missing",
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: vi.fn() }) }));
vi.mock("@/context/PlatformContext", () => ({ usePlatform: () => ({ isServerHost: true }) }));
vi.mock("@/hooks/useLocalhostForward", () => ({
  useLocalhostForward: () => ({ canForward: false }),
}));
vi.mock("@/components/i18n-provider", () => ({
  useI18n: () => ({ t: baseDictionary }),
  interpolate: (text: string, values: Record<string, string>) =>
    text.replace(/\{(\w+)\}/g, (_, key) => values[key] ?? key),
}));

let root: Root;
let host: HTMLDivElement;

function Navigation() {
  const { activeTab } = useProjectSettings();
  return (
    <>
      <div data-layout="desktop">
        <ProjectSidebar />
      </div>
      <div data-layout="mobile">
        <ProjectMobileTabs />
      </div>
      <ProjectTabSections />
      <output>{activeTab}</output>
    </>
  );
}

async function render(slug: string, deployTarget: "cloud" | "server" = "server") {
  await act(async () =>
    root.render(
      <ProjectSettingsProvider
        id="project"
        slug={[slug]}
        initialProjectData={{
          id: "project",
          name: "Example",
          slug: "example",
          description: "",
          framework: "nextjs",
          deployTarget,
          activeDeploymentId: "live",
        }}
      >
        <Navigation />
      </ProjectSettingsProvider>,
    ),
  );
}

function sectionLink(section: string) {
  const link = host.querySelector<HTMLAnchorElement>(`nav a[href="/projects/project/${section}"]`);
  expect(link).not.toBeNull();
  return link!;
}

function expectSelected(group: string, section: string) {
  for (const layout of ["desktop", "mobile"]) {
    const selected = host.querySelectorAll(`[data-layout="${layout}"] a[aria-current="page"]`);
    expect(selected).toHaveLength(1);
    expect(selected[0]?.textContent).toBe(group);
  }
  expect(host.querySelector("output")?.textContent).toBe(section);
  expect(sectionLink(section).getAttribute("aria-current")).toBe("page");
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

describe("merged project navigation", () => {
  it.each(["server", "cloud"] as const)(
    "keeps bookmarked Webhooks accessible under Source & Triggers on %s",
    async (deployTarget) => {
      await render("webhooks", deployTarget);
      expectSelected("Source & Triggers", "webhooks");

      for (const layout of ["desktop", "mobile"]) {
        const links = [...host.querySelectorAll(`[data-layout="${layout}"] a`)];
        expect(links.some((link) => link.textContent === "Webhooks")).toBe(false);
        expect(links.some((link) => link.textContent === "Advanced")).toBe(false);
        expect(links.some((link) => link.textContent === "Backup")).toBe(true);
      }

      await act(async () => sectionLink("source").click());
      expectSelected("Source & Triggers", "source");
      expect(window.location.pathname).toBe("/projects/project/source");
      await act(async () => sectionLink("webhooks").click());
      expectSelected("Source & Triggers", "webhooks");
      expect(window.location.pathname).toBe("/projects/project/webhooks");
    },
  );

  it("keeps Advanced links selected under Settings and Configuration one click away", async () => {
    await render("advanced");
    expectSelected("Settings", "advanced");
    await act(async () => sectionLink("runtime").click());
    expectSelected("Settings", "runtime");
    expect(sectionLink("runtime").textContent).toBe("Configuration");
    expect(window.location.pathname).toBe("/projects/project/runtime");
    await act(async () => sectionLink("advanced").click());
    expectSelected("Settings", "advanced");
    expect(window.location.pathname).toBe("/projects/project/advanced");
  });

  it("follows route changes and preserves older Git, Settings and Build aliases", async () => {
    await render("git");
    expectSelected("Source & Triggers", "source");
    await render("advanced");
    expectSelected("Settings", "advanced");
    for (const alias of ["settings", "build"]) {
      await render(alias);
      expectSelected("Settings", "runtime");
    }
    await render("webhooks");
    expectSelected("Source & Triggers", "webhooks");
  });
});
