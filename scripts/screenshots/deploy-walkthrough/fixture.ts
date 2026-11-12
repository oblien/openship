import {
  DEFAULT_CONFIG,
  INITIAL_STATE,
  type DeploymentContextType,
} from "@/context/deployment/types";

const noop = () => {};
const unavailable = async (): Promise<never> => {
  throw new Error("Screenshot fixture is read-only");
};
export const captureConfig: DeploymentContextType["config"] = {
  ...DEFAULT_CONFIG,
  projectId: "preview-storefront",
  projectName: "Storefront",
  owner: "acme",
  repo: "storefront",
  branch: "main",
  framework: "nextjs",
  detectedFramework: "nextjs",
  packageManager: "npm",
  branches: ["main", "staging"],
  deployTarget: "server",
  serverId: "preview-production",
  serverName: "Production",
  buildStrategy: "server",
  publicEndpoints: [
    {
      id: "public",
      domainType: "custom",
      domain: "storefront",
      customDomain: "shop.example.com",
      port: "3000",
      targetPath: "",
    },
  ],
  options: {
    ...DEFAULT_CONFIG.options,
    installCommand: "npm ci",
    buildCommand: "npm run build",
    startCommand: "npm run start",
    productionPort: "3000",
    outputDirectory: ".next",
    hasBuild: true,
    hasServer: true,
  },
};

export function deployment(ready: boolean, config = captureConfig): DeploymentContextType {
  return {
    config,
    isRescanning: false,
    state: {
      ...INITIAL_STATE,
      deploymentId: "dpl_7f4c2a",
      projectId: config.projectId!,
      currentStepIndex: ready ? 4 : 3,
      deploymentSuccess: ready,
      isDeploying: !ready,
      buildDurationMs: 84_000,
    },
    terminalRef: { current: null },
    canStreamContainer: { current: false },
    updateConfig: noop,
    updateOptions: noop,
    initializeFromRepo: unavailable,
    initializeFromLocal: unavailable,
    initializeFromUpload: unavailable,
    initializeFromProject: unavailable,
    rescanWithComposePath: unavailable,
    rescanWithBranch: unavailable,
    startDeployment: unavailable,
    connectToBuild: unavailable,
    loadBuildSession: unavailable,
    stopDeployment: unavailable,
    redeploy: unavailable,
    respondToPrompt: unavailable,
    resolvePortCheck: noop,
    maybeOpenCredentialModal: () => false,
    reset: noop,
    onTerminalReady: noop,
    _setContainerFailed: noop,
    steps: [
      { label: "Prepare", icon: "server" },
      { label: "Clone", icon: "git-branch" },
      { label: "Install", icon: "download" },
      { label: "Build", icon: "wrench" },
      { label: "Deploy", icon: "rocket" },
    ],
    deploymentStatus: ready ? "ready" : "building",
  };
}
