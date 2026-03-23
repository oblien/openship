import type { Terminal } from "@xterm/xterm";
import type { FrameworkId, EnvironmentVariable } from "@/components/import-project/types";
import type { ProjectType, BuildStrategy, DeployTarget, RuntimeMode } from "@repo/core";
import type { BuildLog } from "@/utils/deploymentPhaseDetector";

// ─── Screenshots ─────────────────────────────────────────────────────────────

export interface Screenshot {
  url: string;
  variants: Array<{ variant: string; url: string }>;
  size: number;
  mime: string;
}

// ─── Compose service (matches API response) ─────────────────────────────────

export interface ComposeServiceInfo {
  name: string;
  image?: string;
  build?: string;
  ports: string[];
  dependsOn: string[];
  environment: Record<string, string>;
  volumes: string[];
  // Per-service exposure settings (set by user in UI)
  exposed?: boolean;
  exposedPort?: string;
  domain?: string;
  customDomain?: string;
  domainType?: "free" | "custom";
}

// ─── Build Strategy ──────────────────────────────────────────────────────────

export type { BuildStrategy, RuntimeMode, DeployTarget } from "@repo/core";

// ─── Config ──────────────────────────────────────────────────────────────────

export interface DeploymentConfig {
  projectName: string;
  repo: string;
  owner: string;
  /** Absolute path for local projects (mutually exclusive with owner/repo git source) */
  localPath?: string;
  /** Where the build runs: "server" (default, build in cloud/workspace) or "local" (build on host machine) */
  buildStrategy: BuildStrategy;
  /** Where the app deploys to: "local" (this machine), "server" (remote SSH), or "cloud" (Oblien) */
  deployTarget: DeployTarget;
  /** Which server to deploy to when deployTarget === "server" */
  serverId?: string;
  /** Runtime mode: "bare" (direct process) or "docker" (container-based) */
  runtimeMode: RuntimeMode;
  projectType: ProjectType;
  framework: FrameworkId;
  detectedFramework: FrameworkId | null;
  packageManager: string;
  buildImage: string;
  domain: string;
  customDomain: string;
  domainType: "free" | "custom";
  envVars: EnvironmentVariable[];
  branch: string;
  branches: string[];
  services: ComposeServiceInfo[];
  options: {
    buildCommand: string;
    outputDirectory: string;
    productionPaths: string;
    installCommand: string;
    startCommand: string;
    productionPort: string;
    rootDirectory: string;
    hasServer: boolean;
    hasBuild: boolean;
  };
}

export const DEFAULT_CONFIG: DeploymentConfig = {
  projectName: "",
  repo: "",
  owner: "",
  localPath: undefined,
  buildStrategy: "server",
  deployTarget: "cloud",
  runtimeMode: "bare",
  projectType: "app",
  framework: "nextjs",
  detectedFramework: null,
  packageManager: "npm",
  buildImage: "node:22",
  domain: "",
  customDomain: "",
  domainType: "free",
  branch: "main",
  branches: [],
  services: [],
  options: {
    buildCommand: "",
    outputDirectory: "",
    productionPaths: "",
    installCommand: "",
    startCommand: "",
    productionPort: "",
    rootDirectory: "./",
    hasServer: true,
    hasBuild: true,
  },
  envVars: [],
};

// ─── State ───────────────────────────────────────────────────────────────────

export interface DeploymentState {
  deploymentId: string | null;
  isDeploying: boolean;
  isStopping: boolean;
  deploymentSuccess: boolean;
  deploymentFailed: boolean;
  deploymentCanceled: boolean;
  failureMessage: string;
  errorCode: string;
  errorDetails: Record<string, unknown> | null;
  buildLogs: BuildLog[];
  currentProgress: number;
  currentStepIndex: number;
  screenshots: Screenshot[];
  projectId: string | null;
  /** Final build duration in ms (set when build finishes). */
  buildDurationMs: number | null;
  /** ISO timestamp when the build started (for elapsed timer). */
  buildStartedAt: string | null;
  /** Active pipeline prompt waiting for user response. */
  pendingPrompt: {
    promptId: string;
    title: string;
    message: string;
    actions: Array<{ id: string; label: string; variant?: string }>;
    details?: Record<string, unknown>;
  } | null;
}

export const INITIAL_STATE: DeploymentState = {
  deploymentId: null,
  isDeploying: false,
  isStopping: false,
  deploymentSuccess: false,
  deploymentFailed: false,
  deploymentCanceled: false,
  failureMessage: "",
  errorCode: "",
  errorDetails: null,
  buildLogs: [],
  currentProgress: 0,
  currentStepIndex: 0,
  screenshots: [],
  projectId: null,
  buildDurationMs: null,
  buildStartedAt: null,
  pendingPrompt: null,
};

// ─── Status ──────────────────────────────────────────────────────────────────

export type DeploymentStatus = "building" | "deploying" | "ready" | "failed" | "cancelled";

// ─── Context type ────────────────────────────────────────────────────────────

export interface DeploymentContextType {
  // Single source of truth
  config: DeploymentConfig;
  state: DeploymentState;
  terminalRef: React.MutableRefObject<Terminal | null>;
  canStreamContainer: React.MutableRefObject<boolean>;

  // Config updates
  updateConfig: (updates: Partial<DeploymentConfig>) => void;
  updateOptions: (updates: Partial<DeploymentConfig["options"]>) => void;

  // Prepare (resolve project info)
  initializeFromRepo: (
    owner: string,
    repo: string,
    force?: string,
  ) => Promise<{ success: boolean; error?: string; errorType?: string; buildInProgress?: boolean }>;
  initializeFromLocal: (
    path: string,
  ) => Promise<{ success: boolean; error?: string; errorType?: string }>;

  // Build lifecycle
  startDeployment: (overrides?: { runtimeMode?: RuntimeMode }) => Promise<string | null>;
  connectToBuild: (deploymentId?: string) => Promise<void>;
  loadBuildSession: (deploymentId: string) => Promise<{ success: boolean; error?: string }>;
  stopDeployment: () => Promise<void>;
  redeploy: (deploymentId: string) => Promise<string | null>;
  respondToPrompt: (action: string) => Promise<void>;
  reset: () => void;

  // Terminal
  onTerminalReady: () => void;

  // Internal
  _setContainerFailed: (message: string) => void;
  steps: { label: string; icon: string }[];
  deploymentStatus: DeploymentStatus;
}
