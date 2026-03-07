export interface Framework {
  id: string;
  name: string;
  icon: React.ReactNode;
}

export interface RepoData {
  repo: string;
  owner: string;
  branch: string;
  private: boolean | false;
}

export interface EnvironmentVariable {
  key: string;
  value: string;
  visible: boolean;
}

export type StartCommand = string;

export type FrameworkId =
  | "next"
  | "react"
  | "vite"
  | "nuxt"
  | "sveltekit"
  | "vue"
  | "static"
  | "astro"
  | "angular"
  | "unknown"
  | "node";

export interface ProjectSettingsProps {
  projectName: string;
  setProjectName: (name: string) => void;
  framework: FrameworkId;
  handleFrameworkChange: (frameworkId: FrameworkId) => void;
  selectedBranch: string;
  setSelectedBranch: (branch: string) => void;
  branches: string[];
  loadingBranches: boolean;
}

export interface BuildSettingsProps {
  framework: FrameworkId;
  buildCommand: string;
  setBuildCommand: (command: string) => void;
  outputDirectory: string;
  setOutputDirectory: (directory: string) => void;
  installCommand: string;
  setInstallCommand: (command: string) => void;
  startCommand: StartCommand;
  setStartCommand: (command: string) => void;
  rootDirectory: string;
  setRootDirectory: (directory: string) => void;
  productionPort: string;
  setProductionPort: (port: string) => void;
  hasServer: boolean;
  setHasServer: (hasServer: boolean) => void;
  projectName: string;
}

export interface EnvironmentVariablesProps {
  envVars: EnvironmentVariable[];
  setEnvVars: React.Dispatch<React.SetStateAction<EnvironmentVariable[]>>;
  mode?: "deploy" | "settings";
  showEditControls?: boolean;
  isEditingMode?: boolean;
  setIsEditingMode?: (value: boolean) => void;
  showAddButton?: boolean;
  onSave?: () => void;
  onCancel?: () => void;
  hasChanges?: boolean;
  isSaving?: boolean;
}

export interface HeaderProps {
  repoData: RepoData;
}

/* Re-export for backwards compat — utils/deployment.ts imports from here */
export type { Deployment } from "@/app/(dashboard)/deployments/types";

export interface SidebarProps {
  repoData: RepoData;
  framework: FrameworkId;
  isDeploying: boolean;
  handleDeploy: () => void;
}
