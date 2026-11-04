// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GitSettings } from "./GitSettings";

const h = vi.hoisted(() => ({
  id: "preview-id",
  branch: "dev",
  deployTarget: "server",
  framework: "node",
  isApp: false,
  setBranch: vi.fn(),
  getBranchPage: vi.fn(),
  listBranches: vi.fn(),
  updateProjectData: vi.fn(),
  refreshGit: vi.fn(),
  invalidate: vi.fn(),
  toast: vi.fn(),
}));
const projectsApi = vi.hoisted(() => ({
  setBranch: h.setBranch,
  getBranchPage: h.getBranchPage,
  getCloneToken: async () => ({ hasToken: false }),
}));
vi.mock("@/lib/api/projects", () => ({ projectsApi }));
vi.mock("@/lib/api", () => ({ projectsApi }));
vi.mock("@/lib/api/github", () => ({ githubApi: { listBranches: h.listBranches } }));
vi.mock("@/hooks/useProjectEndpoints", () => ({
  invalidateProjectCaches: h.invalidate,
  invalidateProjectCachesFor: h.invalidate,
}));
vi.mock("@/context/ToastContext", () => ({ useToast: () => ({ showToast: h.toast }) }));
vi.mock("@/context/PlatformContext", () => ({
  usePlatform: () => ({ selfHosted: h.deployTarget !== "cloud" }),
}));
vi.mock("@/context/GitHubContext", () => ({ useGitHub: () => ({ connected: true }) }));
vi.mock("@/context/ProjectSettingsContext", () => ({
  useProjectSettings: () => ({
    id: h.id,
    projectData: {
      id: h.id,
      gitOwner: "acme",
      gitRepo: "app",
      gitBranch: h.branch,
      environmentType: "preview",
      deployTarget: h.deployTarget,
      framework: h.framework,
      isApp: h.isApp,
    },
    gitData: {
      branch: h.branch,
      repository: { url: "https://github.com/acme/app", full_name: "acme/app" },
      recentCommits: [],
      webhookStrategy: "app",
      installationInstalled: true,
    },
    servicesData: { services: [] },
    environments: [{ id: "preview-id" }, { id: "production-id" }],
    refreshGit: h.refreshGit,
    updateProjectData: h.updateProjectData,
  }),
}));
vi.mock("@/components/project-settings/DeploymentAutomation", () => ({
  PullRequestPreviews: () => null,
}));
vi.mock("@/components/project-settings/GitHubChecksSettings", () => ({
  GitHubChecksSettings: () => null,
}));
vi.mock("../../../library/components/RepositoryList", () => ({ RepositoryList: () => null }));
vi.mock("./AppSource", () => ({ AppSource: () => null }));
vi.mock("./ReleaseImageSourceSettings", () => ({ ReleaseImageSourceSettings: () => null }));

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  h.id = "preview-id";
  h.branch = "dev";
  h.deployTarget = "server";
  h.framework = "node";
  h.isApp = false;
  h.getBranchPage.mockResolvedValue({
    data: [{ name: "main" }, { name: "dev" }, { name: "release/stable" }],
    pagination: { page: 1, perPage: 100, hasMore: false },
  });
  h.setBranch.mockImplementation(async (_id, branch) => ({ success: true, branch }));
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});
async function render() {
  await act(async () => root.render(<GitSettings />));
}
function branchSelect() {
  const label = [...host.querySelectorAll("label")].find(
    (el) => el.textContent === "Deployment branch",
  )!;
  expect(label).toBeDefined();
  return document.getElementById(label.htmlFor) as HTMLButtonElement;
}
function saveButton() {
  return [...host.querySelectorAll<HTMLButtonElement>('button[type="submit"]')].find((el) =>
    el.textContent?.includes("Sav"),
  )!;
}
async function choose(branch = "release/stable") {
  await act(async () => branchSelect().click());
  await act(async () =>
    [...document.querySelectorAll<HTMLButtonElement>('[role="option"]')]
      .find((el) => el.textContent === branch)!
      .click(),
  );
}
async function save() {
  await act(async () => saveButton().click());
}

describe("deployment branch in Source settings", () => {
  it.each([
    ["server", "node"],
    ["cloud", "docker-compose"],
    ["local", "node"],
    ["cluster", "node"],
  ])(
    "saves only the selected environment through the existing operation (%s / %s)",
    async (target, framework) => {
      h.deployTarget = target;
      h.framework = framework;
      await render();
      expect(branchSelect().textContent).toContain("dev");
      expect(saveButton().disabled).toBe(true);
      await choose();
      expect(h.getBranchPage).toHaveBeenCalledWith("preview-id", 1);
      expect(h.listBranches).not.toHaveBeenCalled();
      expect(h.setBranch).not.toHaveBeenCalled();
      h.refreshGit.mockClear();
      await save();
      expect(h.setBranch).toHaveBeenCalledExactlyOnceWith("preview-id", "release/stable");
      expect(h.updateProjectData).toHaveBeenCalledExactlyOnceWith({
        gitBranch: "release/stable",
        branch: "release/stable",
      });
      expect(h.invalidate).toHaveBeenCalledExactlyOnceWith(["preview-id", "production-id"]);
      expect(h.refreshGit).toHaveBeenCalledOnce();
      expect(h.toast).toHaveBeenCalledWith("Deployment branch saved", "success");
      expect(branchSelect().textContent).toContain("release/stable");
      expect(saveButton().disabled).toBe(true);
      expect(host.textContent).toContain("Saving does not redeploy the app.");
    },
  );

  it("preserves the draft after a rejected save and allows retry", async () => {
    await render();
    await choose();
    h.setBranch.mockRejectedValueOnce(new Error("Access denied"));
    await save();
    expect(h.toast).toHaveBeenCalledWith("Access denied", "error");
    expect(h.updateProjectData).not.toHaveBeenCalled();
    expect(h.invalidate).not.toHaveBeenCalled();
    expect(branchSelect().textContent).toContain("release/stable");
    expect(saveButton().disabled).toBe(false);
    await save();
    expect(h.setBranch).toHaveBeenCalledTimes(2);
    expect(saveButton().disabled).toBe(true);
  });

  it("disables edits while saving and ignores a late completion after switching environments", async () => {
    let finish!: (value: { success: boolean; branch: string }) => void;
    h.setBranch.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    await render();
    await choose();
    await save();
    expect(branchSelect().disabled).toBe(true);
    expect(saveButton().disabled).toBe(true);
    h.id = "production-id";
    h.branch = "main";
    await render();
    expect(branchSelect().textContent).toContain("main");
    h.refreshGit.mockClear();
    await act(async () => finish({ success: true, branch: "release/stable" }));
    expect(h.invalidate).toHaveBeenCalledExactlyOnceWith(["preview-id", "production-id"]);
    expect(h.updateProjectData).not.toHaveBeenCalled();
    expect(h.refreshGit).not.toHaveBeenCalled();
    expect(h.toast).not.toHaveBeenCalled();
    expect(branchSelect().textContent).toContain("main");
    await choose();
    await save();
    expect(h.setBranch).toHaveBeenLastCalledWith("production-id", "release/stable");
  });

  it("does not offer a Git branch for catalog apps", async () => {
    h.isApp = true;
    await render();
    expect(host.textContent).not.toContain("Deployment branch");
    expect(h.getBranchPage).not.toHaveBeenCalled();
    expect(h.refreshGit).not.toHaveBeenCalled();
  });
});
