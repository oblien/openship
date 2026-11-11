// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DeploymentContextType } from "./types";
import { useDeploymentConfig } from "./useDeploymentConfig";
import { ApiError } from "@/lib/api/client";

const api = vi.hoisted(() => ({
  prepare: vi.fn(),
  folderScan: vi.fn(),
  getInfo: vi.fn(),
  getEnv: vi.fn(),
  listServices: vi.fn(),
  syncServices: vi.fn(),
  mergeServiceEnv: vi.fn(),
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
  deployApi: {
    prepare: api.prepare,
    buildAccess: api.buildAccess,
    buildRedeploy: api.buildRedeploy,
  },
  projectsApi: {
    getInfo: api.getInfo,
    getEnv: api.getEnv,
    setOptions: api.setOptions,
    setBranch: api.setBranch,
    ensure: api.ensure,
  },
  servicesApi: { list: api.listServices, sync: api.syncServices, mergeEnv: api.mergeServiceEnv },
  serviceKind: (service: { kind?: string }) => service.kind ?? "compose",
  systemApi: { listServers: async () => [] },
  githubApi: {},
  getApiErrorMessage: (error: Error) => error.message,
}));
vi.mock("@/lib/api/folder", () => ({ folderApi: { scan: api.folderScan } }));
vi.mock("@/lib/api/system", () => ({
  systemApi: { listServerDestinations: async () => ({ servers: [] }) },
}));
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
  useI18n: () => ({ t: {} }),
  interpolate: (text: string, values: Record<string, string>) =>
    text.replace(/\{(\w+)\}/g, (_, key: string) => values[key] ?? key),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: api.push }),
  useSearchParams: () => new URLSearchParams(api.query),
}));
vi.mock("@/context/GitHubContext", () => ({ useGitHub: () => ({ state: {} }) }));
vi.mock("@/hooks/useSSEConnection", () => ({
  useBuildStream: () => ({ isConnected: true, connect: vi.fn(), disconnect: vi.fn() }),
}));
vi.mock("@/hooks/useLocalDeployGate", () => ({ useLocalDeployGate: () => ({}) }));

let current: ReturnType<typeof useDeploymentConfig>;
let root: Root;
let container: HTMLDivElement;

function Harness() {
  current = useDeploymentConfig();
  return null;
}

beforeEach(async () => {
  vi.clearAllMocks();
  api.selfHosted = true;
  api.query = "mode=config";
  api.showModal.mockReturnValue("modal-1");
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  api.prepare.mockResolvedValue({
    error: 'Compose path "deploy/prod/docker-compose.yml" was not found in the repository',
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(<Harness />));
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("failed first scan keeps the wizard source (#1666)", () => {
  it("records the attempted owner, repo and default branch when prepare reports an error", async () => {
    let result: Awaited<ReturnType<DeploymentContextType["initializeFromRepo"]>>;
    await act(async () => {
      result = await current.initializeFromRepo("example", "demo");
    });
    expect(result!).toMatchObject({ success: false });
    expect(current.config.owner).toBe("example");
    expect(current.config.repo).toBe("demo");
    expect(current.config.branch).toBe("main");
  });

  it("records an explicitly requested branch", async () => {
    await act(async () => {
      await current.initializeFromRepo("example", "demo", undefined, { branch: "feature-x" });
    });
    expect(current.config.owner).toBe("example");
    expect(current.config.repo).toBe("demo");
    expect(current.config.branch).toBe("feature-x");
  });

  it("also seeds the source when prepare throws", async () => {
    api.prepare.mockRejectedValueOnce(new ApiError(500, "Server error", { error: "boom" }));
    let result: Awaited<ReturnType<DeploymentContextType["initializeFromRepo"]>>;
    await act(async () => {
      result = await current.initializeFromRepo("example", "demo");
    });
    expect(result!).toMatchObject({ success: false });
    expect(current.config.owner).toBe("example");
    expect(current.config.repo).toBe("demo");
  });

  it("does not clobber an identity the operator has since moved to", async () => {
    await act(async () => {
      current.updateConfig({ owner: "other", repo: "other-repo" });
    });
    await act(async () => {
      await current.initializeFromRepo("example", "demo");
    });
    expect(current.config.owner).toBe("other");
    expect(current.config.repo).toBe("other-repo");
  });
});
