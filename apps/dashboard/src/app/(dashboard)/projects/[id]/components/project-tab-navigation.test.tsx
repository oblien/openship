// @vitest-environment happy-dom
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { baseDictionary } from "@/i18n";
import { ProjectSettingsProvider, useProjectSettings } from "@/context/ProjectSettingsContext";
import { ProjectMobileTabs, ProjectSidebar } from "./ProjectSidebar";
import { ProjectTabSections } from "./ProjectTabSections";
import { ReleaseImageSourceSettings } from "./ReleaseImageSourceSettings";
import type { ProjectUpdateStatus } from "@/lib/api/projects";

const platform = vi.hoisted(() => ({ selfHosted: true, commitStatus: vi.fn() }));

vi.mock("@/lib/api", () => ({
  projectsApi: { getCommitStatus: platform.commitStatus },
  servicesApi: { list: async () => ({ services: [] }) },
}));
vi.mock("@/context/ToastContext", () => ({ useToast: () => ({ showToast: vi.fn() }) }));
vi.mock("@/hooks/useProjectEndpoints", () => ({
  useProjectInfo: () => ({ isLoading: false }),
  PROJECT_INFO_NOT_FOUND: "missing",
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: vi.fn() }) }));
vi.mock("@/context/PlatformContext", () => ({
  usePlatform: () => ({ isServerHost: platform.selfHosted, selfHosted: platform.selfHosted }),
}));
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
let settings: ReturnType<typeof useProjectSettings>;
let showReleaseSource = false;

function Navigation() {
  settings = useProjectSettings();
  const { activeTab } = settings;
  return (
    <>
      {showReleaseSource && <ReleaseImageSourceSettings />}
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

async function render(
  slug: string,
  deployTarget: "cloud" | "server" | "local" = "server",
  project: Partial<NonNullable<ComponentProps<typeof ProjectSettingsProvider>["initialProjectData"]>> = {},
) {
  await act(async () =>
    root.render(
      <ProjectSettingsProvider
        id={project.id ?? "project"}
        slug={[slug]}
        initialProjectData={{
          id: "project",
          name: "Example",
          slug: "example",
          description: "",
          framework: "nextjs",
          deployTarget,
          activeDeploymentId: "live",
          ...project,
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

function expectSelected(group: string, section: string, hasSections = true) {
  for (const layout of ["desktop", "mobile"]) {
    const selected = host.querySelectorAll(`[data-layout="${layout}"] a[aria-current="page"]`);
    expect(selected).toHaveLength(1);
    expect(selected[0]?.textContent).toBe(group);
  }
  expect(host.querySelector("output")?.textContent).toBe(section);
  if (hasSections) {
    expect(sectionLink(section).getAttribute("aria-current")).toBe("page");
  } else {
    expect(host.querySelector("nav")).toBeNull();
  }
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  platform.selfHosted = true;
  showReleaseSource = false;
  platform.commitStatus.mockReset().mockResolvedValue({ data: { supported: false } });
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
  it.each(["server", "local"] as const)(
    "opens Health links under Monitoring & Logs and switches sections on %s",
    async (deployTarget) => {
      await render("health", deployTarget);
      expectSelected("Monitoring & Logs", "health");
      expect([...host.querySelectorAll("nav a")].map((link) => link.textContent)).toEqual([
        "Monitoring", "Logs", "Health",
      ]);
      for (const layout of ["desktop", "mobile"]) {
        expect(host.querySelector(`[data-layout="${layout}"] a[href="/projects/project/health"]`)).toBeNull();
      }

      await act(async () => sectionLink("monitoring").click());
      expectSelected("Monitoring & Logs", "monitoring");
      expect(window.location.pathname).toBe("/projects/project/monitoring");
      await act(async () => sectionLink("health").click());
      expectSelected("Monitoring & Logs", "health");
      expect(window.location.pathname).toBe("/projects/project/health");

      await render("overview", deployTarget);
      await render("health", deployTarget);
      expectSelected("Monitoring & Logs", "health");
    },
  );

  it.each([
    { selfHosted: true, deployTarget: "cloud" as const },
    { selfHosted: false, deployTarget: "cloud" as const },
    { selfHosted: false, deployTarget: "server" as const },
  ])("excludes local Health for $deployTarget projects with selfHosted=$selfHosted", async ({ selfHosted, deployTarget }) => {
    platform.selfHosted = selfHosted;
    await render("health", deployTarget);
    expect(host.querySelector("output")?.textContent).toBe("overview");
    await render("monitoring", deployTarget);
    expect(host.querySelector("output")?.textContent).toBe("monitoring");
    expect([...host.querySelectorAll("nav a")].map((link) => link.textContent)).toEqual([
      "Monitoring", "Logs",
    ]);
    expect(host.querySelector('a[href="/projects/project/health"]')).toBeNull();
    for (const layout of ["desktop", "mobile"]) {
      const selected = host.querySelector(`[data-layout="${layout}"] a[aria-current="page"]`);
      expect(selected?.textContent).toBe("Monitoring & Logs");
    }
  });

  it.each([
    { selfHosted: true, deployTarget: "server" as const },
    { selfHosted: true, deployTarget: "local" as const },
    { selfHosted: true, deployTarget: "cloud" as const },
    { selfHosted: false, deployTarget: "cloud" as const },
    { selfHosted: false, deployTarget: "server" as const },
  ])("keeps existing Logs links in the shared group for $deployTarget with selfHosted=$selfHosted", async ({ selfHosted, deployTarget }) => {
    platform.selfHosted = selfHosted;
    await render("logs", deployTarget);
    expectSelected("Monitoring & Logs", "logs");
    for (const layout of ["desktop", "mobile"]) {
      expect(host.querySelector(`[data-layout="${layout}"] a[href="/projects/project/logs"]`)).toBeNull();
      const group = host.querySelector<HTMLAnchorElement>(
        `[data-layout="${layout}"] a[href="/projects/project/monitoring"]`,
      );
      expect(group?.textContent).toBe("Monitoring & Logs");
      await act(async () => group!.click());
      expectSelected("Monitoring & Logs", "monitoring");
      await act(async () => sectionLink("logs").click());
      expectSelected("Monitoring & Logs", "logs");
      expect(window.location.pathname).toBe("/projects/project/logs");
    }

    // Reloading or following a saved Logs URL selects the same section.
    await render("overview", deployTarget);
    await render("logs", deployTarget);
    expectSelected("Monitoring & Logs", "logs");
  });

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

  it("opens Settings directly without separate Configuration and Advanced tabs", async () => {
    await render("advanced");
    expectSelected("Settings", "advanced", false);
    expect(host.querySelector('a[href="/projects/project/runtime"]')).toBeNull();
    for (const layout of ["desktop", "mobile"]) {
      await render("overview");
      const settings = host.querySelector<HTMLAnchorElement>(
        `[data-layout="${layout}"] a[href="/projects/project/advanced"]`,
      );
      expect(settings?.textContent).toBe("Settings");
      await act(async () => settings!.click());
      expectSelected("Settings", "advanced", false);
      expect(window.location.pathname).toBe("/projects/project/advanced");
    }
  });

  it("follows route changes and preserves older Git, Settings and Build aliases", async () => {
    await render("git");
    expectSelected("Source & Triggers", "source");
    await render("advanced");
    expectSelected("Settings", "advanced", false);
    for (const alias of ["settings", "build", "runtime"]) {
      await render(alias);
      expectSelected("Settings", "advanced", false);
    }
    await render("webhooks");
    expectSelected("Source & Triggers", "webhooks");
  });
});

describe("project update indicator", () => {
  const commit: ProjectUpdateStatus = {
    supported: true, mode: "commit", behind: true, latestInProgress: false,
    branch: "main", latestSha: "latest", latestMessage: null, deployedSha: "previous",
  };
  const indicatorLabel = baseDictionary.projectSettings.appSource.updateAvailable;
  const indicators = () => host.querySelectorAll(`[role="img"][aria-label="${indicatorLabel}"]`);

  it.each(["commit", "release", "image"] as const)(
    "shares a confirmed %s update across desktop and mobile Deployments links",
    async (mode) => {
      platform.commitStatus.mockResolvedValue({ data: { supported: true, behind: true, mode } });
      await render("overview");
      expect(platform.commitStatus).toHaveBeenCalledExactlyOnceWith("project");
      expect(indicators()).toHaveLength(2);
      for (const layout of ["desktop", "mobile"]) {
        const link = host.querySelector<HTMLAnchorElement>(
          `[data-layout="${layout}"] a[href="/projects/project/deployments"]`,
        )!;
        expect(link.querySelector(`[aria-label="${indicatorLabel}"]`)?.getAttribute("title")).toBe(indicatorLabel);
        await act(async () => link.click());
        expectSelected("Deployments", "deployments", false);
        expect(window.location.pathname).toBe("/projects/project/deployments");
      }
      expect(platform.commitStatus).toHaveBeenCalledOnce();
    },
  );

  it.each([
    { supported: false, behind: true },
    { supported: true, behind: false },
    { supported: true, behind: true, latestInProgress: true },
  ])("does not flag unsupported, current, or already deploying updates: %j", async (data) => {
    platform.commitStatus.mockResolvedValue({ data });
    await render("overview");
    expect(indicators()).toHaveLength(0);
  });

  it("skips the CLI-managed control plane", async () => {
    await render("overview", "server", { appTemplateId: "openship" });
    expect(platform.commitStatus).not.toHaveBeenCalled();
    expect(indicators()).toHaveLength(0);
  });

  it.each([
    { activeDeploymentId: "updated" },
    { latestDeploymentId: "building", latestDeploymentStatus: "building" },
    { gitBranch: "production" },
    { releaseSource: { mode: "github" as const, repo: "example/app" } },
  ])("clears the previous result while checking changed deployment/source state: %j", async (change) => {
    platform.commitStatus.mockResolvedValueOnce({ data: commit });
    await render("overview");
    expect(indicators()).toHaveLength(2);

    let resolve!: (value: { data: ProjectUpdateStatus }) => void;
    platform.commitStatus.mockReturnValueOnce(new Promise((done) => { resolve = done; }));
    await act(async () => settings.setProjectData((project) => ({ ...project, ...change })));
    expect(indicators()).toHaveLength(0);
    expect(platform.commitStatus).toHaveBeenCalledTimes(2);
    await act(async () => resolve({ data: { ...commit, behind: false } }));
    expect(indicators()).toHaveLength(0);
  });

  it("ignores a previous project's late response", async () => {
    let resolve!: (value: { data: ProjectUpdateStatus }) => void;
    platform.commitStatus.mockReturnValueOnce(new Promise((done) => { resolve = done; }));
    await render("overview");
    await render("overview", "server", { id: "other" });
    expect(platform.commitStatus).toHaveBeenLastCalledWith("other");
    await act(async () => resolve({ data: commit }));
    expect(indicators()).toHaveLength(0);
  });

  it("deduplicates simultaneous refreshes and checks again on a later visit", async () => {
    let resolve!: (value: { data: ProjectUpdateStatus }) => void;
    platform.commitStatus.mockReturnValueOnce(new Promise((done) => { resolve = done; }));
    await render("overview");
    const first = settings.refreshUpdateStatus();
    const second = settings.refreshUpdateStatus();
    expect(first).toBe(second);
    expect(platform.commitStatus).toHaveBeenCalledOnce();
    await act(async () => {
      resolve({ data: commit });
      await first;
    });
    expect(indicators()).toHaveLength(2);
    await act(async () => settings.refreshUpdateStatus());
    expect(platform.commitStatus).toHaveBeenCalledTimes(2);
    expect(indicators()).toHaveLength(0);
  });

  it("keeps failed checks silent without showing an update", async () => {
    platform.commitStatus.mockRejectedValue(new Error("Network unavailable"));
    await render("overview");
    expect(indicators()).toHaveLength(0);
    expectSelected("Overview", "overview", false);
  });

  it("shares the release check with source settings even when the deployed version is current", async () => {
    showReleaseSource = true;
    platform.commitStatus.mockResolvedValue({ data: {
      supported: true, mode: "release", behind: false, latestInProgress: false,
      currentVersion: "1.2.3", latestVersion: "1.2.3", pinned: false,
    } satisfies ProjectUpdateStatus });
    await render("source", "server", {
      releaseSource: { mode: "github", repo: "example/app", artifactKind: "image", imageTemplate: "ghcr.io/example/app:{tag}" },
    });
    expect(platform.commitStatus).toHaveBeenCalledExactlyOnceWith("project");
    expect(indicators()).toHaveLength(0);
    expect(host.textContent).toContain("1.2.3");
  });
});
