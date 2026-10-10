// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENV_MASK } from "@repo/core";
import { baseDictionary } from "@/i18n";
import { DeploymentContext } from "@/context/DeploymentContext";
import Sidebar from "@/app/(dashboard)/(deployment)/deploy/[slug]/components/Sidebar";
import ProjectSettings from "@/components/import-project/ProjectSettings";
import BuildSettings from "@/components/import-project/BuildSettings";
import type { PrepareProjectResponse } from "@/lib/api/deploy";
import type { DeploymentContextType } from "./types";
import { useDeploymentConfig } from "./useDeploymentConfig";
import { useDeploymentBuild } from "./useDeploymentBuild";
import { ApiError } from "@/lib/api/client";
import { CloudDeployPlanModal } from "@/components/billing/CloudDeployPlanModal";

const api = vi.hoisted(() => ({
  prepare: vi.fn(),
  folderScan: vi.fn(),
  getInfo: vi.fn(),
  getEnv: vi.fn(),
  listServices: vi.fn(),
  setOptions: vi.fn(),
  setBranch: vi.fn(),
  getBranchPage: vi.fn(),
  ensure: vi.fn(),
  buildAccess: vi.fn(),
  showToast: vi.fn(),
  showModal: vi.fn(),
  hideModal: vi.fn(),
  push: vi.fn(),
  buildRedeploy: vi.fn(),
  selfHosted: true,
  query: "mode=config",
}));

vi.mock("@/lib/api", () => ({
  deployApi: { prepare: api.prepare, buildAccess: api.buildAccess, buildRedeploy: api.buildRedeploy },
  projectsApi: {
    getInfo: api.getInfo,
    getEnv: api.getEnv,
    setOptions: api.setOptions,
    setBranch: api.setBranch,
    ensure: api.ensure,
  },
  servicesApi: { list: api.listServices },
  serviceKind: (service: { kind?: string }) => service.kind ?? "compose",
  systemApi: { listServers: async () => [] },
  githubApi: {},
  getApiErrorMessage: (error: Error) => error.message,
}));
vi.mock("@/lib/api/folder", () => ({ folderApi: { scan: api.folderScan } }));
vi.mock("@/lib/api/system", () => ({ systemApi: { listServerDestinations: async () => ({ servers: [] }) } }));
vi.mock("@/lib/auth-client", () => ({ useSession: () => ({ data: null }) }));
vi.mock("@/lib/api/settings", () => ({ settingsApi: { get: async () => ({}) } }));
vi.mock("@/lib/api/projects", () => ({ projectsApi: { getBranchPage: api.getBranchPage } }));
vi.mock("@/lib/api/github", () => ({ githubApi: { listBranches: api.getBranchPage } }));
vi.mock("@/context/CloudContext", () => ({
  useDefaultDomainType: () => "custom",
  useCloud: () => ({ requireCloud: async () => true }),
}));
vi.mock("@/context/PlatformContext", () => ({
  usePlatform: () => ({ selfHosted: api.selfHosted, baseDomain: "example.test" }),
  canUseCloudConnection: () => api.selfHosted,
}));
vi.mock("@/context/ToastContext", () => ({ useToast: () => ({ showToast: api.showToast }) }));
vi.mock("@/context/ModalContext", () => ({
  useModal: () => ({ showModal: api.showModal, hideModal: api.hideModal }),
}));
vi.mock("@/components/i18n-provider", () => ({
  useI18n: () => ({ t: baseDictionary }),
  interpolate: (text: string, values: Record<string, string>) =>
    text.replace(/\{(\w+)\}/g, (_, key: string) => values[key] ?? key),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: api.push }),
  useSearchParams: () => new URLSearchParams(api.query),
}));
vi.mock("@/context/GitHubContext", () => ({ useGitHub: () => ({ state: {} }) }));
vi.mock("@/components/github/ServerGitHubConnect", () => ({
  useServerGitHubConnectModal: () => vi.fn(),
}));
vi.mock("@/hooks/useSSEConnection", () => ({
  useBuildStream: () => ({ isConnected: true, connect: vi.fn(), disconnect: vi.fn() }),
}));
vi.mock("@/hooks/useLocalDeployGate", () => ({ useLocalDeployGate: () => ({}) }));
vi.mock("@/app/(dashboard)/(deployment)/deploy/[slug]/components/CloneStrategyNudge", () => ({
  useCloneStrategyGate: () => ({}),
}));
vi.mock("@/app/(dashboard)/(deployment)/deploy/[slug]/components/DomainSettings", () => ({
  default: () => null,
}));
vi.mock("@/app/(dashboard)/(deployment)/deploy/[slug]/components/BuildSummary", () => ({
  default: () => null,
}));

const services = ["web", "db", "cache"].map((name) => ({
  name,
  image: `${name}:1`,
  ports: [],
  dependsOn: [],
  environment: {},
  volumes: [],
}));

function scan(
  branch: string,
  overrides: Partial<PrepareProjectResponse> = {},
): PrepareProjectResponse {
  return {
    repository: {
      name: "demo",
      full_name: "example/demo",
      owner: { login: "example" },
      private: true,
      default_branch: "main",
      selected_branch: branch,
      branches: ["main", "openship", "empty"].map((name) => ({ name })),
    },
    stack: "node",
    projectType: "app",
    category: "backend",
    packageManager: "npm",
    installCommand: "npm ci",
    buildCommand: "npm run build",
    startCommand: "node server.js",
    buildImage: "node:22",
    outputDirectory: "dist",
    rootDirectory: "app",
    productionPaths: ["dist"],
    port: 8080,
    hasServer: true,
    hasBuild: true,
    ...overrides,
  };
}

let current: ReturnType<typeof useDeploymentConfig>;
let build: ReturnType<typeof useDeploymentBuild>;
let root: Root;
let container: HTMLDivElement;

function Harness() {
  current = useDeploymentConfig();
  build = useDeploymentBuild(current.config, current.setConfig);
  return (
    <DeploymentContext.Provider
      value={
        {
          ...current,
          ...build,
        } satisfies DeploymentContextType
      }
    >
      <Sidebar destinationReady />
      {current.config.projectType === "app" && <ProjectSettings />}
      {current.config.projectType === "app" && <BuildSettings />}
    </DeploymentContext.Provider>
  );
}

function button(text: string): HTMLButtonElement {
  const result = [...document.querySelectorAll("button")].find(
    (el) => el.textContent?.trim() === text,
  );
  expect(result, `button: ${text}`).toBeDefined();
  return result!;
}

async function selectBranch(branch: string) {
  await act(async () => button(current.config.branch).click());
  await act(async () => {
    const option = [...document.querySelectorAll<HTMLButtonElement>('[role="option"]')].find(
      (el) => el.textContent?.trim() === branch,
    );
    expect(option).toBeDefined();
    option!.click();
  });
}

beforeEach(async () => {
  vi.clearAllMocks();
  api.selfHosted = true;
  api.query = "mode=config";
  api.showModal.mockReturnValue("modal-1");
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  api.getInfo.mockResolvedValue({
    data: {
      project: {
        id: "project-1",
        name: "My project",
        gitOwner: "example",
        gitRepo: "demo",
        gitBranch: "main",
        framework: "docker-compose",
        composePath: "infra/compose.yml",
        runtimeMode: "docker",
        buildCommand: "old build",
        startCommand: "old start",
        rootDirectory: "old-root",
        deployTarget: "server",
        serverId: "server-1",
        serverName: "Production",
      },
    },
  });
  api.getEnv.mockResolvedValue({
    data: [
      {
        id: "env-1",
        key: "TOKEN",
        value: "********",
        environment: "production",
        isSecret: true,
      },
    ],
  });
  api.listServices.mockResolvedValue({ services });
  api.setOptions.mockResolvedValue({});
  api.setBranch.mockResolvedValue({ success: true });
  api.getBranchPage.mockResolvedValue({
    data: ["main", "openship", "empty"].map((name) => ({ name })),
    pagination: { page: 1, perPage: 100, hasMore: false },
  });
  api.ensure.mockResolvedValue({ success: true, project_id: "project-1" });
  api.buildAccess.mockResolvedValue({ success: true, deployment_id: "deployment-1" });
  api.prepare.mockImplementation(async ({ branch }: { branch: string }) => scan(branch));
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(<Harness />));
  await act(async () => {
    await current.initializeFromProject("project-1");
  });
  await act(async () => current.updateConfig({ branches: ["main", "openship", "empty"] }));
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("deployment setup with workspace repository grants", () => {
  const sourceDenied = () =>
    new ApiError(404, "Not Found", {
      code: "NOT_FOUND",
      error: "github 'example/demo' not found",
    });

  function allowMaskedScan() {
    api.prepare.mockImplementation(async ({ includeEnv, branch = "main" }) => {
      if (includeEnv) throw sourceDenied();
      return scan(branch, {
        rootEnv: { SOURCE_TOKEN: ENV_MASK, OPTIONAL_TOKEN: ENV_MASK },
        openshipEnvKeys: ["SOURCE_TOKEN"],
      });
    });
  }

  it("opens an accessible repository with masked source values when editable values are denied", async () => {
    allowMaskedScan();
    await act(async () => {
      expect(await current.initializeFromRepo("example", "demo")).toEqual({ success: true });
    });
    expect(api.prepare).toHaveBeenCalledTimes(2);
    expect(current.config).toMatchObject({
      owner: "example",
      repo: "demo",
      branch: "main",
      framework: "node",
    });
    expect(current.config.envVars).toContainEqual(
      expect.objectContaining({
        key: "SOURCE_TOKEN",
        value: ENV_MASK,
        preserveValue: true,
      }),
    );
    expect(current.config.rootEnvVars).toEqual([
      expect.objectContaining({
        key: "OPTIONAL_TOKEN",
        value: ENV_MASK,
        preserveValue: true,
      }),
    ]);
    expect(api.showToast).not.toHaveBeenCalled();
    expect(api.buildAccess).not.toHaveBeenCalled();
  });

  it("keeps branch and compose rescans available without source-content access", async () => {
    allowMaskedScan();
    await act(async () =>
      current.updateConfig({
        envVars: [...current.config.envVars, { key: "APP_MODE", value: "preview", visible: true }],
      }),
    );
    await selectBranch("openship");
    expect(current.config.branch).toBe("openship");
    expect(api.prepare).toHaveBeenLastCalledWith({
      owner: "example",
      repo: "demo",
      branch: "openship",
      env: { APP_MODE: "preview" },
      includeEnv: false,
    });
    await act(async () => {
      expect(await current.rescanWithComposePath(" deploy/compose.yml ")).toMatchObject({
        success: true,
      });
    });
    expect(api.prepare).toHaveBeenLastCalledWith(
      expect.objectContaining({
        owner: "example",
        repo: "demo",
        branch: "openship",
        composePath: "deploy/compose.yml",
        env: { APP_MODE: "preview" },
        includeEnv: false,
      }),
    );
    expect(current.config.envVars).toContainEqual({
      key: "APP_MODE",
      value: "preview",
      visible: true,
    });
    expect(current.isRescanning).toBe(false);
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it("keeps editable values for a caller with source-content access", async () => {
    api.prepare.mockResolvedValueOnce(scan("main", { rootEnv: { EDITABLE: "source-value" } }));
    await act(async () => {
      expect(await current.initializeFromRepo("example", "demo")).toEqual({ success: true });
    });
    expect(api.prepare).toHaveBeenCalledOnce();
    expect(current.config.rootEnvVars).toEqual([
      expect.objectContaining({ key: "EDITABLE", value: "source-value" }),
    ]);
  });

  it("still refuses an inaccessible or missing repository after the masked scan", async () => {
    api.prepare.mockRejectedValue(sourceDenied());
    const previous = current.config;
    await act(async () => {
      expect(await current.initializeFromRepo("example", "demo")).toMatchObject({
        success: false,
        error: "github 'example/demo' not found",
        errorType: "api_error",
      });
    });
    expect(api.prepare).toHaveBeenCalledTimes(2);
    expect(current.config).toBe(previous);
    expect(api.buildAccess).not.toHaveBeenCalled();
  });

  it.each([
    [401, "UNAUTHORIZED"],
    [403, "GITHUB_ACCESS_DENIED"],
    [429, "RATE_LIMITED"],
    [503, "UPSTREAM_UNAVAILABLE"],
    [404, undefined],
  ])("does not retry an unrelated scan failure (%s, %s)", async (status, code) => {
    api.prepare.mockRejectedValueOnce(
      new ApiError(status, "Failed", { code, error: "Scan failed" }),
    );
    await act(async () => {
      expect(await current.initializeFromRepo("example", "demo")).toMatchObject({
        success: false,
        error: "Scan failed",
      });
    });
    expect(api.prepare).toHaveBeenCalledOnce();
  });

  it("does not retry local-source errors as a GitHub permission fallback", async () => {
    api.prepare.mockRejectedValueOnce(sourceDenied());
    await act(async () => {
      expect(await current.initializeFromLocal("/missing/project")).toMatchObject({
        success: false,
      });
    });
    expect(api.prepare).toHaveBeenCalledOnce();
  });
});

describe("deploy branch detection", () => {
  it.each([{ commands: ["migrate"] }, { commands: [] }])(
    "preserves explicit release settings through rescan, save and deploy: $commands",
    async ({ commands }) => {
      await act(async () => current.updateConfig({ releaseCommands: commands }));
      api.prepare.mockResolvedValueOnce(scan("openship", { releaseCommands: ["upstream migration"] }));
      await selectBranch("openship");
      expect(current.config.releaseCommands).toEqual(commands);
      await act(async () => button(baseDictionary.deploy.sidebar.saveChanges).click());
      expect(api.setOptions).toHaveBeenCalledWith("project-1", expect.objectContaining({ releaseCommands: commands }));
      await act(async () => { await build.startDeployment(); });
      expect(api.ensure).toHaveBeenCalledWith(expect.objectContaining({ releaseCommands: commands }));
    },
  );

  it("hydrates saved release commands when editing a project", async () => {
    api.getInfo.mockResolvedValueOnce({ data: { project: {
      id: "project-1", name: "Demo", framework: "node", gitOwner: "example", gitRepo: "demo",
      gitBranch: "main", releaseCommands: ["node migrate.js"],
    } } });
    api.listServices.mockResolvedValueOnce({ services: [] });
    await act(async () => { await current.initializeFromProject("project-1"); });
    expect(current.config.releaseCommands).toEqual(["node migrate.js"]);
  });

  it.each([false, true])("keeps the managed server on Cloud draft restoration (empty service read: %s)", async empty => {
    api.getInfo.mockResolvedValueOnce({ data: { project: {
      id: "project-1", name: "Cloud app", framework: "docker-compose", gitOwner: "example", gitRepo: "demo",
      gitBranch: "main", deployTarget: "cloud", serverId: "managed-server", workspaceId: "workspace", serverName: "Production",
    } } });
    api.listServices.mockResolvedValueOnce({ services: empty ? [] : services });
    await act(async () => { await current.initializeFromProject("project-1"); });
    expect(current.config).toMatchObject({ deployTarget: "cloud", serverId: "managed-server", workspaceId: "workspace", serverName: "Production" });
    await act(async () => { await build.startDeployment(); });
    expect(api.ensure).toHaveBeenCalledWith(expect.objectContaining({ serverId: "managed-server" }));
    expect(api.buildAccess).toHaveBeenCalledWith(expect.objectContaining({ deployTarget: "cloud", serverId: "managed-server" }));
  });

  it("seeds a new project from openship.json and lets the operator remove a command", async () => {
    api.prepare.mockResolvedValueOnce(scan("main", { releaseCommands: ["node migrate.js"] }));
    await act(async () => { await current.initializeFromRepo("example", "fresh"); });
    expect(current.config.releaseCommands).toEqual(["node migrate.js"]);
    const advanced = [...container.querySelectorAll<HTMLButtonElement>("button[aria-expanded]")]
      .find((el) => el.textContent?.startsWith(baseDictionary.importProject.buildSettings.advanced));
    expect(advanced).toBeDefined();
    await act(async () => advanced!.click());
    const command = container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Command 1"]');
    expect(command?.value).toBe("node migrate.js");
    const remove = container.querySelector<HTMLButtonElement>('button[aria-label="Remove command 1"]');
    expect(remove).not.toBeNull();
    await act(async () => remove!.click());
    expect(current.config.releaseCommands).toEqual([]);
  });

  it("seeds commands found on another branch of a new, unedited project", async () => {
    await act(async () => { await current.initializeFromRepo("example", "fresh"); });
    api.prepare.mockResolvedValueOnce(scan("openship", { releaseCommands: ["node migrate.js"] }));
    await selectBranch("openship");
    expect(current.config.releaseCommands).toEqual(["node migrate.js"]);
  });

  it("imports commands from an uploaded folder even when a stack was selected", async () => {
    api.folderScan.mockResolvedValue({ ...scan("main"), name: "Uploaded app", releaseCommands: ["node migrate.js"] });
    await act(async () => {
      const result = await current.initializeFromUpload("upload-1", { stack: "node", name: "Uploaded app" });
      expect(result.success).toBe(true);
    });
    expect(current.config.releaseCommands).toEqual(["node migrate.js"]);
    expect(current.config.framework).toBe("node");
  });

  it("rescans from the branch dropdown, replaces compose defaults, and preserves project edits", async () => {
    const baseline = current.config.projectEnvBaseline;
    const secret = current.config.envVars[0];
    await act(async () =>
      current.updateConfig({
        projectName: "Unsaved name",
        envVars: [secret, { key: "APP_MODE", value: "preview", visible: true }],
      }),
    );
    expect(current.config.services).toHaveLength(3);
    expect(api.prepare).not.toHaveBeenCalled();

    await selectBranch("openship");

    expect(api.prepare).toHaveBeenCalledWith({
      owner: "example",
      repo: "demo",
      branch: "openship",
      env: { APP_MODE: "preview" },
      includeEnv: true,
    });
    expect(current.config).toMatchObject({
      projectId: "project-1",
      projectName: "Unsaved name",
      branch: "openship",
      projectType: "app",
      framework: "node",
      detectedFramework: "node",
      services: [],
      serviceDeploymentMode: "single",
      composePath: undefined,
      composeDefaults: undefined,
      singleAppCandidate: undefined,
      modeSnapshots: undefined,
      serverId: "server-1",
      deployTarget: "server",
      runtimeMode: "docker",
      options: {
        buildCommand: "npm run build",
        startCommand: "node server.js",
        rootDirectory: "app",
        productionPort: "8080",
      },
    });
    expect(current.config.projectEnvBaseline).toBe(baseline);
    expect(current.config.envVars).toEqual([
      secret,
      { key: "APP_MODE", value: "preview", visible: true },
    ]);

    api.prepare.mockResolvedValueOnce(
      scan("main", {
        stack: "docker-compose",
        projectType: "services",
        services: services.slice(0, 2),
        composePath: "deploy/compose.yaml",
        rootEnv: { NEW_DEFAULT: "value" },
      }),
    );
    await selectBranch("main");
    expect(current.config.framework).toBe("docker-compose");
    expect(current.config.services).toHaveLength(2);
    expect(current.config.composePath).toBe("deploy/compose.yaml");
    expect(current.config.composeDefaults?.framework).toBe("docker-compose");
    expect(current.config.rootEnvVars.map((row) => row.key)).toEqual(["NEW_DEFAULT"]);
  });

  it("opens manual framework selection when the new branch has no recognizable stack", async () => {
    api.prepare.mockResolvedValueOnce(
      scan("empty", {
        stack: "unknown",
        buildCommand: "",
        startCommand: "",
        installCommand: "",
        rootEnv: {},
        monorepoApps: undefined,
        monorepoWorkspace: undefined,
      }),
    );
    await selectBranch("empty");
    expect(current.config).toMatchObject({
      branch: "empty",
      framework: "unknown",
      detectedFramework: null,
      projectType: "app",
      services: [],
      composeDefaults: undefined,
      composePath: undefined,
      rootEnvVars: [],
    });
    expect(container.textContent).toContain(
      baseDictionary.importProject.projectSettings.selectHint,
    );
    await act(async () => button("Vite").click());
    expect(current.config.framework).toBe("vite");
    expect(container.textContent).not.toContain(
      baseDictionary.importProject.projectSettings.useDetected,
    );
  });

  it("keeps a single app's domains and redirects while updating its detected port", async () => {
    await act(async () =>
      current.updateConfig({
        projectType: "app",
        framework: "node",
        services: [],
        publicEndpoints: [
          {
            ...current.config.publicEndpoints[0],
            customDomain: "app.example.test",
            domainType: "custom",
            redirectTo: "https://www.example.test",
            redirectStatus: 308,
          },
        ],
        options: { ...current.config.options, hasServer: true, productionPort: "3000" },
      }),
    );
    await selectBranch("openship");
    expect(current.config.publicEndpoints[0]).toMatchObject({
      customDomain: "app.example.test",
      domainType: "custom",
      redirectTo: "https://www.example.test",
      redirectStatus: 308,
      port: "8080",
    });
  });

  it("keeps save disabled during detection and keeps the previous branch on failure so it can be retried", async () => {
    let reject!: (error: Error) => void;
    api.prepare.mockReturnValueOnce(
      new Promise((_, fail) => {
        reject = fail;
      }),
    );
    const previous = current.config;
    await selectBranch("openship");
    expect(current.isRescanning).toBe(true);
    expect(current.config).toBe(previous);
    expect(button(baseDictionary.deploy.sidebar.saveChanges).disabled).toBe(true);
    expect(button("main").disabled).toBe(true);
    // A second scan cannot overtake an unresolved branch scan.
    await act(async () => {
      await current.rescanWithComposePath("another.yml");
    });
    expect(api.prepare).toHaveBeenCalledTimes(1);

    await act(async () => reject(new Error("Branch is unavailable")));
    expect(current.config).toBe(previous);
    expect(current.isRescanning).toBe(false);
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("Branch is unavailable");
    expect(button(baseDictionary.deploy.sidebar.saveChanges).disabled).toBe(false);

    await selectBranch("openship");
    expect(current.config.branch).toBe("openship");
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it("honors an explicit branch instead of silently scanning the saved project's branch", async () => {
    await act(async () => {
      await current.initializeFromRepo("example", "demo", undefined, {
        projectId: "project-1",
        branch: "openship",
      });
    });
    expect(current.config.branch).toBe("openship");
    expect(current.config.framework).toBe("node");
    expect(current.config.detectedFramework).toBe("node");
    expect(current.config.composePath).toBeUndefined();
    expect(api.prepare.mock.lastCall?.[0].composePath).toBeUndefined();
  });

  it("keeps Dockerfile defaults as a running service when rescanning single and monorepo apps", async () => {
    const docker = scan("openship", {
      stack: "docker",
      projectType: "docker",
      category: "docker",
      startCommand: "",
      buildCommand: "",
      installCommand: "",
      port: 20128,
    });
    api.prepare.mockResolvedValueOnce(docker);
    await selectBranch("openship");
    expect(current.config).toMatchObject({
      framework: "docker",
      projectType: "docker",
      runtimeMode: "docker",
      options: { startCommand: "", hasServer: true, productionPort: "20128" },
    });

    api.prepare.mockResolvedValueOnce({
      ...docker,
      projectType: "monorepo",
      monorepoApps: [
        { ...docker, id: "web", name: "web", rootDirectory: "apps/web" },
      ],
      monorepoWorkspace: {
        packageManager: "pnpm",
        prepareCommand: "pnpm install",
      },
    });
    await selectBranch("main");
    expect(current.config.monorepoApps?.[0]).toMatchObject({
      framework: "docker",
      startCommand: "",
      hasServer: true,
      port: "20128",
    });
  });

  it("replaces monorepo apps, workspace defaults, and mode snapshots when returning to a plain branch", async () => {
    const app = scan("openship");
    api.prepare.mockResolvedValueOnce(
      scan("openship", {
        projectType: "monorepo",
        monorepoApps: [{ ...app, id: "web", name: "web", rootDirectory: "apps/web" }],
        monorepoWorkspace: { packageManager: "pnpm", prepareCommand: "pnpm install" },
      }),
    );
    await selectBranch("openship");
    expect(current.config.monorepoApps).toHaveLength(1);
    expect(current.config.modeSnapshots).toBeDefined();
    await selectBranch("main");
    expect(current.config).toMatchObject({
      projectType: "app",
      framework: "node",
      monorepoApps: undefined,
      monorepoWorkspace: undefined,
      modeSnapshots: undefined,
      services: [],
    });
  });

  it("saves the scanned branch with its new build settings and clears the old compose path", async () => {
    await selectBranch("openship");
    await act(async () => button(baseDictionary.deploy.sidebar.saveChanges).click());
    expect(api.setOptions).toHaveBeenCalledWith(
      "project-1",
      expect.objectContaining({
        framework: "node",
        gitBranch: "openship",
        composePath: "",
        buildCommand: "npm run build",
        productionPort: 8080,
      }),
    );
    expect(api.setBranch).not.toHaveBeenCalled();
    expect(api.showToast).toHaveBeenCalledWith("Configuration saved", "success", "Saved");
    expect(api.buildAccess).not.toHaveBeenCalled();
  });

  it("sends the detected single-app mode to deploy even when the project previously had services", async () => {
    await selectBranch("openship");
    let deploymentId: string | null = null;
    await act(async () => {
      deploymentId = await build.startDeployment();
    });
    expect(deploymentId).toBe("deployment-1");
    expect(api.ensure).toHaveBeenCalledWith(
      expect.objectContaining({
        gitBranch: "openship",
        framework: "node",
        composePath: "",
      }),
    );
    expect(api.buildAccess).toHaveBeenCalledWith(
      expect.objectContaining({
        branch: "openship",
        serviceDeploymentMode: "single",
        services: undefined,
      }),
    );
  });

  it("ignores a completed scan after navigating to a different project", async () => {
    let resolve!: (value: PrepareProjectResponse) => void;
    api.prepare.mockReturnValueOnce(
      new Promise((done) => {
        resolve = done;
      }),
    );
    await selectBranch("openship");
    await act(async () => current.updateConfig({ projectId: "project-2", repo: "different" }));
    await act(async () => resolve(scan("openship")));
    expect(current.config.projectId).toBe("project-2");
    expect(current.config.repo).toBe("different");
    expect(current.config.branch).toBe("main");
  });
});


describe("Cloud pricing is offered only at deployment time", () => {
  async function configureCloud() {
    await selectBranch("openship");
    api.selfHosted = false;
    api.query = "";
    await act(async () => current.updateConfig({ deployTarget: "cloud", serverId: "managed-server", workspaceId: "workspace", noPublicRoute: true }));
  }
  it("lets a paid Cloud deployment pass the former waitlist gate", async () => {
    await configureCloud();
    expect(api.showModal).not.toHaveBeenCalled();
    expect(api.buildAccess).not.toHaveBeenCalled();
    await act(async () => button(baseDictionary.deploy.sidebar.deploy).click());
    expect(api.buildAccess).toHaveBeenCalledOnce();
    expect(api.push).toHaveBeenCalledWith("/build/deployment-1");
    expect(api.showModal).not.toHaveBeenCalled();
  });
  it("opens pricing after the deployment is refused and preserves configuration", async () => {
    await configureCloud();
    const envBefore = current.config.envVars;
    api.buildAccess.mockRejectedValueOnce(new ApiError(402, "Payment Required", { code: "CLOUD_BILLING_BLOCKED" }));
    await act(async () => button(baseDictionary.deploy.sidebar.deploy).click());
    expect(api.showModal).toHaveBeenCalledOnce();
    expect(api.showModal.mock.calls[0]![0].customContent.type).toBe(CloudDeployPlanModal);
    expect(api.push).not.toHaveBeenCalled();
    expect(current.config.envVars).toEqual(envBefore);
    expect(build.state.isDeploying).toBe(false);
  });
  it("never opens pricing from a configuration-only save", async () => {
    api.setOptions.mockRejectedValueOnce(new ApiError(402, "Payment Required", { code: "PLAN_UPGRADE_REQUIRED" }));
    await act(async () => button(baseDictionary.deploy.sidebar.saveChanges).click());
    expect(api.showModal).not.toHaveBeenCalled();
    expect(api.buildAccess).not.toHaveBeenCalled();
  });
  it("handles a build-screen redeploy hitting a Cloud limit with the same pricing dialog", async () => {
    api.buildRedeploy.mockRejectedValueOnce(new ApiError(402, "Payment Required", { code: "PLAN_UPGRADE_REQUIRED", reason: "build-minutes-exhausted" }));
    await act(async () => { await build.redeploy("previous-build"); });
    expect(api.showModal).toHaveBeenCalledOnce();
    expect(api.showModal.mock.calls[0]![0].customContent.props.restriction.reason).toBe("build-minutes-exhausted");
    expect(build.state.isDeploying).toBe(false);
  });
});
