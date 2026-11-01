// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { baseDictionary } from "@/i18n";
import { ApiError } from "@/lib/api/client";
import { ProjectSettingsProvider, useProjectSettings } from "@/context/ProjectSettingsContext";
import ProjectSettingsContent from "../[[...slug]]/page";

const h = vi.hoisted(() => ({
  remove: vi.fn(),
  info: vi.fn(),
  invalidate: vi.fn(),
  sidebar: vi.fn(),
  toast: vi.fn(),
  replace: vi.fn(),
  showModal: vi.fn(),
  projects: new Map<string, { project: Record<string, unknown>; environments: unknown[] }>(),
}));

vi.mock("@/lib/api", async () => ({
  ...(await import("@/lib/api/client")),
  projectsApi: {
    delete: h.remove,
    getInfo: h.info,
    getCommitStatus: async () => ({ data: { supported: false } }),
  },
  servicesApi: { list: async () => ({ services: [] }) },
}));
vi.mock("@/hooks/useProjectEndpoints", () => ({
  useProjectInfo: (id: string) => ({ data: h.projects.get(id), isLoading: false, error: null }),
  invalidateProjectCachesFor: h.invalidate,
  PROJECT_INFO_NOT_FOUND: "missing",
}));
vi.mock("@/lib/sidebar-nav-counts", () => ({ invalidateSidebarNavCounts: h.sidebar }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: h.replace, push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/context/ToastContext", () => ({ useToast: () => ({ showToast: h.toast }) }));
vi.mock("@/context/ModalContext", () => ({
  useModal: () => ({ showModal: h.showModal, hideModal: vi.fn() }),
}));
vi.mock("@/context/PlatformContext", () => ({
  usePlatform: () => ({ selfHosted: true, isServerHost: true }),
}));
vi.mock("@/components/i18n-provider", () => ({
  useI18n: () => ({ t: baseDictionary }),
  interpolate: (text: string, values: Record<string, string>) =>
    text.replace(/\{(\w+)\}/g, (_, key) => values[key] ?? key),
}));

// Exercise the page's real delete handler and provider; unrelated tab contents
// do not need their own network requests in a navigation regression.
vi.mock("./AdvancedSettings", () => ({
  AdvancedSettings: ({ onDeleteProject }: { onDeleteProject(): void }) => (
    <button onClick={() => void onDeleteProject()}>Delete project</button>
  ),
}));
vi.mock("./DomainSettings", () => ({ DomainSettings: () => null }));
vi.mock("./GitSettings", () => ({ GitSettings: () => null }));
vi.mock("./IncomingWebhooks", () => ({ IncomingWebhooks: () => null }));
vi.mock("./LogsSettings", () => ({ LogsSettings: () => null }));
vi.mock("./BackupSettings", () => ({ BackupSettings: () => null }));
vi.mock("./Deployments", () => ({ Deployments: () => null }));
vi.mock("./HealthTab", () => ({ HealthTab: () => null }));
vi.mock("./MonitoringTab", () => ({ MonitoringTab: () => null }));
vi.mock("./OverviewTab", () => ({ OverviewTab: () => null }));
vi.mock("./ServicesTab", () => ({ ServicesTab: () => null }));
vi.mock("./ProjectSidebar", () => ({ ProjectSidebar: () => null, ProjectMobileTabs: () => null }));
vi.mock("./ProjectTabSections", () => ({ ProjectTabSections: () => null }));
vi.mock("./DraftProjectView", () => ({
  DraftProjectView: ({ onDeleteProject }: { onDeleteProject(wipeVolumes: boolean, recordOnly: boolean): void }) => (
    <button onClick={() => void onDeleteProject(true, false)}>Delete failed project and data</button>
  ),
}));
vi.mock("@/components/topology/ProjectTopologyPage", () => ({ ProjectTopologyPage: () => null }));
vi.mock("@/components/HelpMenu", () => ({ HelpMenu: () => null }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function environment(id: string, type: "production" | "preview" = "production") {
  return { id, type, name: id, slug: id, gitBranch: "main", version: null };
}

function seed(id: string, environments = [environment(id)], deletedAt: string | null = null) {
  h.projects.set(id, {
    project: {
      id,
      name: id,
      slug: id,
      description: "",
      framework: "docker",
      deployTarget: "server",
      activeDeploymentId: `dep-${id}`,
      deletedAt,
    },
    environments,
  });
}

let root: Root;
let host: HTMLDivElement;
let settings: ReturnType<typeof useProjectSettings>;
function Probe() {
  settings = useProjectSettings();
  return <ProjectSettingsContent />;
}

async function renderProject(id: string) {
  window.history.replaceState(null, "", `/projects/${id}/advanced`);
  await act(async () =>
    root.render(
      <ProjectSettingsProvider id={id} slug={["advanced"]}>
        <Probe />
      </ProjectSettingsProvider>,
    ),
  );
}

async function startDelete() {
  const button = [...host.querySelectorAll("button")].find(
    (button) => button.textContent === "Delete project",
  );
  expect(button).toBeDefined();
  await act(async () => button!.click());
  expect(h.remove).toHaveBeenCalledWith("project-a", {
    wipeVolumes: false,
    recordOnly: false,
    force: false,
    forceOrphan: false,
  });
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks();
  h.projects.clear();
  h.remove.mockReset();
  h.info.mockReset().mockResolvedValue({});
  h.replace.mockImplementation((href: string) => window.history.replaceState(null, "", href));
  seed("project-a");
  seed("project-b", [environment("project-b"), environment("project-b-preview", "preview")]);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const outcomes = [
  { name: "success", result: { ok: true } },
  {
    name: "partial cleanup",
    result: { ok: false, rowDeleted: true, unrecoverable: [{ step: "container" }] },
  },
  { name: "already deleted", error: new ApiError(404, "Not Found", {}) },
];

describe("project deletion completion", () => {
  it("preserves a failed Cloud project's explicit volume cleanup choice at the API boundary", async () => {
    seed("failed-cloud");
    Object.assign(h.projects.get("failed-cloud")!.project, {
      activeDeploymentId: null,
      latestDeploymentStatus: "failed",
      deployTarget: "cloud",
    });
    h.remove.mockResolvedValue({ ok: true });
    await renderProject("failed-cloud");
    const remove = [...host.querySelectorAll("button")].find(
      (node) => node.textContent === "Delete failed project and data",
    )!;
    await act(async () => remove.click());
    expect(h.remove).toHaveBeenCalledExactlyOnceWith("failed-cloud", {
      wipeVolumes: true,
      recordOnly: false,
      force: false,
      forceOrphan: false,
    });
  });

  it.each(outcomes)(
    "keeps the normal redirect after $name when still viewing the deleted project",
    async (outcome) => {
      const request = deferred<unknown>();
      h.remove.mockReturnValue(request.promise);
      await renderProject("project-a");
      await startDelete();
      await act(async () =>
        outcome.error ? request.reject(outcome.error) : request.resolve(outcome.result),
      );
      expect(h.replace).toHaveBeenCalledExactlyOnceWith("/");
      expect(h.invalidate).toHaveBeenCalledWith(["project-a"]);
      expect(h.sidebar).toHaveBeenCalledOnce();
    },
  );

  it("selects a surviving environment when the deleted page is still open", async () => {
    seed("project-a", [environment("project-a"), environment("sibling", "preview")]);
    h.remove.mockResolvedValue({ ok: true });
    await renderProject("project-a");
    await startDelete();
    expect(h.replace).toHaveBeenCalledExactlyOnceWith("/projects/sibling/advanced");
    expect(settings.environments.map((env) => env.id)).toEqual(["sibling"]);
  });

  it.each(outcomes)(
    "does not redirect or replace another project's state after late $name",
    async (outcome) => {
      seed("project-a", [environment("project-a"), environment("sibling", "preview")]);
      const request = deferred<unknown>();
      h.remove.mockReturnValue(request.promise);
      await renderProject("project-a");
      await startDelete();
      await renderProject("project-b");
      await act(async () =>
        outcome.error ? request.reject(outcome.error) : request.resolve(outcome.result),
      );
      expect(h.replace).not.toHaveBeenCalled();
      expect(window.location.pathname).toBe("/projects/project-b/advanced");
      expect(settings.projectData.id).toBe("project-b");
      expect(settings.environments.map((env) => env.id)).toEqual([
        "project-b",
        "project-b-preview",
      ]);
      expect(h.invalidate).toHaveBeenCalledWith(["project-a", "sibling"]);
      expect(h.sidebar).toHaveBeenCalledOnce();
    },
  );

  it.each(["/projects/project-a-other/advanced", "/servers/server-b"])(
    "respects navigation to %s before the old page unmounts",
    async (pathname) => {
      const request = deferred<unknown>();
      h.remove.mockReturnValue(request.promise);
      await renderProject("project-a");
      await startDelete();
      window.history.replaceState(null, "", pathname);
      await act(async () => request.resolve({ ok: true }));
      expect(h.replace).not.toHaveBeenCalled();
      expect(window.location.pathname).toBe(pathname);
      expect(h.sidebar).toHaveBeenCalledOnce();
    },
  );

  it("finishes a background deletion without navigating after the page unmounts", async () => {
    const request = deferred<unknown>();
    h.remove.mockReturnValue(request.promise);
    await renderProject("project-a");
    await startDelete();
    await act(async () => root.render(<div>Another page</div>));
    await act(async () => request.resolve({ ok: true }));
    expect(h.replace).not.toHaveBeenCalled();
    expect(h.invalidate).toHaveBeenCalledWith(["project-a"]);
    expect(h.sidebar).toHaveBeenCalledOnce();
  });

  it("does not clear another project's deletion state when an earlier request fails", async () => {
    const request = deferred<unknown>();
    h.remove.mockReturnValue(request.promise);
    const deletingAt = "2026-10-06T09:00:00.000Z";
    seed("project-b", [environment("project-b")], deletingAt);
    await renderProject("project-a");
    await startDelete();
    await renderProject("project-b");
    await act(async () => request.reject(new ApiError(500, "Delete failed", {})));
    expect(settings.projectData).toMatchObject({ id: "project-b", deletedAt: deletingAt });
    expect(h.replace).not.toHaveBeenCalled();
  });

  it("ignores an in-flight deletion poll after navigating to another project", async () => {
    vi.useFakeTimers();
    seed("project-a", [environment("project-a")], "2026-10-06T09:00:00.000Z");
    const poll = deferred<unknown>();
    h.info.mockReturnValue(poll.promise);
    await renderProject("project-a");
    await act(async () => vi.advanceTimersByTimeAsync(3000));
    expect(h.info).toHaveBeenCalledExactlyOnceWith("project-a");
    await renderProject("project-b");
    await act(async () => poll.reject(new ApiError(404, "Not Found", {})));
    await act(async () => vi.advanceTimersByTimeAsync(6000));
    expect(h.replace).not.toHaveBeenCalled();
    expect(settings.environments.map((env) => env.id)).toEqual(["project-b", "project-b-preview"]);
    expect(h.info).toHaveBeenCalledOnce();
    expect(h.toast).not.toHaveBeenCalled();
  });

  it("keeps polling completion working on the deleted page without overlapping slow requests", async () => {
    vi.useFakeTimers();
    seed("project-a", [environment("project-a")], "2026-10-06T09:00:00.000Z");
    const poll = deferred<unknown>();
    h.info.mockReturnValue(poll.promise);
    await renderProject("project-a");
    await act(async () => vi.advanceTimersByTimeAsync(9000));
    expect(h.info).toHaveBeenCalledExactlyOnceWith("project-a");
    await act(async () => poll.reject(new ApiError(404, "Not Found", {})));
    expect(h.replace).toHaveBeenCalledExactlyOnceWith("/");
    expect(h.sidebar).toHaveBeenCalledOnce();
    await act(async () => vi.advanceTimersByTimeAsync(6000));
    expect(h.info).toHaveBeenCalledOnce();
  });

  it("handles the delete response and a simultaneous 404 poll only once", async () => {
    vi.useFakeTimers();
    const request = deferred<unknown>();
    const poll = deferred<unknown>();
    h.remove.mockReturnValue(request.promise);
    h.info.mockReturnValue(poll.promise);
    await renderProject("project-a");
    await startDelete();
    await act(async () => vi.advanceTimersByTimeAsync(3000));
    expect(h.info).toHaveBeenCalledOnce();
    await act(async () => {
      request.resolve({ ok: true });
      poll.reject(new ApiError(404, "Not Found", {}));
    });
    expect(h.replace).toHaveBeenCalledExactlyOnceWith("/");
    expect(h.sidebar).toHaveBeenCalledOnce();
  });
});

it("reconciles failed teardown with the durable cleanup error instead of returning to Live", async () => {
  h.remove.mockRejectedValue(
    new ApiError(409, "Cleanup failed", {
      code: "PROJECT_TEARDOWN_FAILED",
      unrecoverable: [{ step: "runtime_cleanup", error: "cache in use" }],
    }),
  );
  h.info.mockResolvedValue({
    project: { id: "project-a", deletionInProgress: true, lifecycleOperation: { kind: "delete", status: "failed", error: "cache in use" } },
  });
  await renderProject("project-a");
  await startDelete();
  expect(settings.projectData).toMatchObject({
    deletedAt: null,
    deletionInProgress: true,
    lifecycleOperation: { kind: "delete", status: "failed", error: "cache in use" },
  });
  expect(host.textContent).toContain(baseDictionary.projects.delete.retryCleanup);
  expect(host.textContent).toContain("cache in use");
  expect(h.replace).not.toHaveBeenCalled();
});

it("keeps an unconfirmed deletion pending after connection loss and reconciles when the API returns", async () => {
  vi.useFakeTimers();
  h.remove.mockRejectedValue(new ApiError(502, "Connection lost", {}));
  h.info.mockRejectedValueOnce(new ApiError(502, "Connection lost", {}));
  await renderProject("project-a");
  await startDelete();
  expect(settings.projectData.deletedAt).toBeTruthy();
  expect(host.textContent).toContain(baseDictionary.projects.delete.retryCleanup);
  h.info.mockResolvedValue({ project: { id: "project-a", deletionInProgress: true, lifecycleOperation: { kind: "delete", status: "failed", error: "cache in use" } } });
  await act(async () => vi.advanceTimersByTimeAsync(3000));
  expect(settings.projectData).toMatchObject({ deletedAt: null, deletionInProgress: true, lifecycleOperation: { kind: "delete", status: "failed", error: "cache in use" } });
});

it("recognizes a completed deletion when its response was lost", async () => {
  h.remove.mockRejectedValue(new ApiError(502, "Connection lost", {}));
  h.info.mockRejectedValue(new ApiError(404, "Not Found", {}));
  await renderProject("project-a");
  await startDelete();
  expect(h.replace).toHaveBeenCalledExactlyOnceWith("/");
  expect(h.sidebar).toHaveBeenCalledOnce();
});
