// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { baseDictionary } from "@/i18n";
import { DEFAULT_CONFIG, INITIAL_STATE } from "@/context/deployment/types";
import type { DeploymentContextType } from "@/context/deployment/types";
import DeployRepository from "./page";

const api = vi.hoisted(() => ({
  slug: "ZXhhbXBsZS9kZW1v", // base64url("example/demo")
  initializeFromRepo: vi.fn(),
  initializeFromLocal: vi.fn(),
  initializeFromUpload: vi.fn(),
  initializeFromProject: vi.fn(),
  updateConfig: vi.fn(),
  rescanWithBranch: vi.fn(),
  rescanWithComposePath: vi.fn(),
  toast: vi.fn(),
  push: vi.fn(),
  listBranches: vi.fn(),
  getBranchPage: vi.fn(),
  sidebar: vi.fn(),
  serverCount: 0,
  config: null as unknown as DeploymentContextType["config"],
}));

vi.mock("next/navigation", () => ({
  useParams: () => ({ slug: api.slug }),
  useSearchParams: () => new URLSearchParams(""),
  useRouter: () => ({ push: api.push }),
}));
vi.mock("@/context/DeploymentContext", () => ({
  useDeployment: () => ({
    config: api.config,
    state: INITIAL_STATE,
    isRescanning: false,
    initializeFromRepo: api.initializeFromRepo,
    initializeFromLocal: api.initializeFromLocal,
    initializeFromUpload: api.initializeFromUpload,
    initializeFromProject: api.initializeFromProject,
    updateConfig: api.updateConfig,
    rescanWithBranch: api.rescanWithBranch,
    rescanWithComposePath: api.rescanWithComposePath,
  }),
  useOptionalDeployment: () => ({
    config: api.config,
    state: INITIAL_STATE,
    isRescanning: false,
    initializeFromRepo: api.initializeFromRepo,
    initializeFromLocal: api.initializeFromLocal,
    initializeFromUpload: api.initializeFromUpload,
    initializeFromProject: api.initializeFromProject,
    updateConfig: api.updateConfig,
    rescanWithBranch: api.rescanWithBranch,
    rescanWithComposePath: api.rescanWithComposePath,
  }),
}));
vi.mock("@/context/PlatformContext", () => ({
  usePlatform: () => ({ selfHosted: true, baseDomain: "example.test", deployMode: "self-hosted" }),
  canUseCloudConnection: () => true,
}));
vi.mock("@/components/toast", () => ({ useToast: () => ({ toast: api.toast }) }));
vi.mock("@/components/i18n-provider", () => ({
  useI18n: () => ({ t: baseDictionary }),
  interpolate: (text: string, values: Record<string, string>) =>
    text.replace(/\{(\w+)\}/g, (_, key: string) => values[key] ?? key),
}));
vi.mock("@/components/shared/ServerSelector", () => ({
  useServerSelection: ({ readOnly }: { readOnly: boolean }) => ({
    rows: Array.from({ length: api.serverCount }, (_, i) => ({ id: String(i) })),
    selected: api.serverCount ? { id: "0", name: "Production" } : null,
    ready: api.serverCount > 0,
    loading: false,
    error: null,
    automaticCloud: false,
    readOnly,
  }),
  ServerSelectorView: () => null,
  ServerSelectionPrompt: () => null,
}));
vi.mock("./components/DeployTargetStep", () => ({
  default: () => null,
  DeployTargetSummary: () => null,
}));
vi.mock("./components/ServerRuntimePicker", () => ({
  useServerRuntimeSelection: () => ({}),
}));
vi.mock("./components/Sidebar", () => ({ default: (props: unknown) => { api.sidebar(props); return null; } }));
vi.mock("./components/SkeletonLoader", () => ({ default: () => null }));
vi.mock("@/components/actions/DeployActions", () => ({ DeployActions: () => null }));
vi.mock("@/components/import-project/DeployGitHubChecks", () => ({
  DeployGitHubChecks: () => null,
}));
vi.mock("@/components/import-project/ProjectSettings", () => ({ default: () => null }));
vi.mock("@/components/import-project/BuildSettings", () => ({ default: () => null }));
vi.mock("@/components/import-project/DockerSettings", () => ({ default: () => null }));
vi.mock("@/components/import-project/ComposeServices", () => ({ default: () => null }));
vi.mock("@/components/import-project/MonorepoApps", () => ({ default: () => null }));
vi.mock("@/components/import-project/RoutingSection", () => ({ default: () => null }));
vi.mock("@/components/project-settings/ReadinessSection", () => ({ default: () => null }));
vi.mock("@/components/import-project/EnvironmentVariables", () => ({ default: () => null }));
vi.mock("@/hooks/useComposeReview", () => ({ ComposeChangeSummary: () => null }));
vi.mock("@/lib/api/github", () => ({ githubApi: { listBranches: api.listBranches } }));
vi.mock("@/lib/api/projects", () => ({ projectsApi: { getBranchPage: api.getBranchPage } }));

let root: Root;
let container: HTMLDivElement;

async function renderPage() {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root.render(<DeployRepository />);
  });
}

beforeEach(async () => {
  vi.clearAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  api.slug = "ZXhhbXBsZS9kZW1v";
  api.serverCount = 0;
  api.config = {
    ...DEFAULT_CONFIG,
    owner: "example",
    repo: "demo",
    branch: "main",
    branches: [],
    branchPage: 0,
    branchesHasMore: false,
  };
  api.initializeFromRepo.mockResolvedValue({
    success: false,
    error: 'Compose path "deploy/prod/docker-compose.yml" was not found in the repository',
    errorType: "api_error",
  });
  api.initializeFromLocal.mockResolvedValue({ success: false });
  api.initializeFromUpload.mockResolvedValue({ success: false });
  api.initializeFromProject.mockResolvedValue({ success: false });
  api.rescanWithBranch.mockResolvedValue({ success: true });
  api.rescanWithComposePath.mockResolvedValue({ success: true });
  api.listBranches.mockResolvedValue({
    data: [{ name: "main" }, { name: "feature-x" }],
    pagination: { page: 1, perPage: 100, hasMore: false },
  });
  api.getBranchPage.mockResolvedValue({
    data: [{ name: "main" }, { name: "feature-x" }],
    pagination: { page: 1, perPage: 100, hasMore: false },
  });
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it.each([
  { destinations: 2, existing: false, lockedUpload: false, review: true },
  { destinations: 1, existing: false, lockedUpload: false, review: false },
  { destinations: 2, existing: true, lockedUpload: false, review: false },
  { destinations: 2, existing: false, lockedUpload: true, review: false },
])("requests first-deploy destination review=$review with $destinations destinations, existing=$existing, upload=$lockedUpload", async ({ destinations, existing, lockedUpload, review }) => {
  api.serverCount = destinations;
  api.config.serverId = "0";
  if (existing) api.config.projectId = "existing-project";
  if (lockedUpload) api.config.uploadSessionId = "upload";
  api.initializeFromRepo.mockResolvedValue({ success: true });
  await renderPage();
  const props = api.sidebar.mock.lastCall?.[0];
  expect(props?.destinationReady).toBe(true);
  if (review) expect(props.reviewDestination?.server.id).toBe("0");
  else expect(props.reviewDestination).toBeUndefined();
});

describe("deploy page failed first scan (#1666)", () => {
  it("shows the branch selector and compose-path field inline with the error", async () => {
    await renderPage();
    const text = container.textContent ?? "";
    // The scan error is shown inline, not as the only content.
    expect(text).toContain('Compose path "deploy/prod/docker-compose.yml" was not found');
    // The steering controls survive the failed scan.
    expect(text).toContain("Compose file");
    expect(text).toContain("Try again");
    const branchTrigger = [...container.querySelectorAll("button")].find((el) =>
      el.textContent?.includes("main"),
    );
    expect(branchTrigger, "branch selector showing the current branch").toBeDefined();
    // The old full-page error is gone: it offered only leaving the wizard.
    expect(text).not.toContain("Back to Library");
    expect(text).not.toContain("Import Repository");
  });

  it("keeps the full-page error for a slug with no repository to steer", async () => {
    api.slug = "not-a-slug";
    await renderPage();
    const text = container.textContent ?? "";
    expect(text).toContain("Back to Library");
    expect(text).not.toContain("Path to your compose file");
  });
});
