"use client";

import { useEffect, useState } from "react";
import { Icon } from "@repo/ui/icons";
import { PlatformProvider } from "@/context/PlatformContext";
import { DeploymentContext } from "@/context/DeploymentContext";
import {
  DEFAULT_CONFIG,
  INITIAL_STATE,
  type DeploymentContextType,
} from "@/context/deployment/types";
import { RepositoryList } from "@/app/(dashboard)/library/components/RepositoryList";
import type { GitHubRepo } from "@/context/GitHubContext";
import { DeploymentHeader } from "@/components/import-project/DeploymentHeader";
import { DeploymentStepper } from "@/components/import-project/DeploymentStepper";
import DeploymentDetails from "@/components/import-project/DeploymentDetails";
import { DeploymentLogsPanel } from "@/components/import-project/DeploymentLogsPanel";
import { LogSnapshotTerminal } from "@/components/import-project/LogSnapshotTerminal";
import { RoutingSettingsCard } from "@/components/routing/RoutingSettingsCard";
import DnsRecordCard from "@/components/domains/DnsRecordCard";
import { ResourceCards } from "@/components/monitoring/ResourceCards";
import { ResourceHistoryChart } from "@/components/monitoring/ResourceHistoryChart";
import type { ProjectUsage } from "@/hooks/useProjectUsageStream";

// Only the capture script mounts this fixture, in a temporary development route.
// Product components are unchanged. All names, logs and usage below are sample data.
const noop = () => {};
const unavailable = async (): Promise<never> => {
  throw new Error("Screenshot fixture is read-only");
};
const config: DeploymentContextType["config"] = {
  ...DEFAULT_CONFIG,
  projectId: "preview-storefront",
  projectName: "Storefront",
  owner: "acme",
  repo: "storefront",
  branch: "main",
  framework: "nextjs",
  deployTarget: "server",
  serverId: "preview-production",
  serverName: "Production",
  buildStrategy: "local",
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
  },
};

function deployment(ready: boolean): DeploymentContextType {
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

const repos: GitHubRepo[] = [
  ["storefront", "The web app for our online store", "TypeScript"],
  ["commerce-api", "API and background workers", "TypeScript"],
  ["team-docs", "Documentation for the team", "MDX"],
  ["status-page", "Public service status", "JavaScript"],
].map(([name, description, language], index) => ({
  id: index + 1,
  name,
  full_name: `acme/${name}`,
  description,
  language,
  owner: "acme",
  private: index !== 3,
  stars: 0,
  forks: 0,
  updated_at: "2026-11-09T10:00:00Z",
  default_branch: "main",
}));

const usage: ProjectUsage = {
  supported: true,
  capacity: { cpuCores: 4, memoryMb: 8192 },
  timestamp: "2026-11-09T10:00:00Z",
  overall: {
    cpuPercent: 12.4,
    memoryMb: 284,
    diskMb: 940,
    networkRxBytes: 820_000_000,
    networkTxBytes: 140_000_000,
  },
  services: [],
};
const buckets = Array.from({ length: 24 }, (_, index) => ({
  minute: Date.UTC(2026, 10, 9, 8, index * 5) / 60_000,
  cpuPercent: 10 + Math.sin(index * 0.9) * 3 + (index === 12 ? 14 : 0),
  memoryMb: 260 + index + Math.sin(index * 0.5) * 8,
  networkRxBytes: 0,
  networkTxBytes: 0,
  hasData: true,
}));
const logs = [
  "$ npm run build",
  "",
  "  Next.js — production build",
  "",
  "  Creating an optimized production build…",
  "  ✓ Compiled successfully",
  "  ✓ Linting and checking validity of types",
  "  ✓ Collecting page data",
  "  ✓ Generating static pages (8/8)",
  "  ✓ Finalizing page optimization",
  "",
  "  Preparing the deployment image…",
].join("\r\n");

export default function Preview() {
  const [view, setView] = useState("connect");
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const update = () => setView(location.hash.slice(1) || "connect");
    update();
    setReady(true);
    window.addEventListener("hashchange", update);
    return () => window.removeEventListener("hashchange", update);
  }, []);
  if (!ready) return null;
  return (
    <PlatformProvider selfHosted deployMode="desktop" hostDomain="opsh.io">
      <DeploymentContext.Provider value={deployment(view === "ship")}>
        <div
          data-walkthrough-capture={view}
          className="bg-background text-foreground"
          style={{ width: 900, height: 675, padding: 28 }}
        >
          {view === "connect" && (
            <>
              <h1 className="mb-2 text-2xl font-medium">Import a repository</h1>
              <p className="mb-7 text-sm text-muted-foreground">
                Choose the code you want to deploy.
              </p>
              <RepositoryList
                repos={repos}
                accounts={[]}
                selectedOwner="acme"
                setSelectedOwner={noop}
                loading={false}
                loadingRepos={false}
                onSelect={noop}
                onInstall={noop}
                installing={false}
              />
            </>
          )}
          {(view === "build" || view === "ship") && (
            <>
              <DeploymentHeader onRedeploy={noop} />
              <div className="mb-5">
                <DeploymentStepper />
              </div>
              {view === "build" ? (
                <DeploymentLogsPanel title="Build logs">
                  <LogSnapshotTerminal logs={logs} emptyLabel="" />
                </DeploymentLogsPanel>
              ) : (
                <DeploymentDetails />
              )}
            </>
          )}
          {view === "route" && (
            <>
              <h1 className="mb-2 text-2xl font-medium">Domains</h1>
              <p className="mb-7 text-sm text-muted-foreground">Storefront · Production</p>
              <div className="rounded-2xl bg-card p-5">
                <div className="mb-4 flex items-center gap-3">
                  <Icon name="globe" className="size-5" />
                  <h2 className="text-lg font-medium">Public domain</h2>
                </div>
                <RoutingSettingsCard
                  projectName="Storefront"
                  domain="storefront"
                  customDomain="shop.example.com"
                  domainType="custom"
                  exposedPort="3000"
                  onDomainTypeChange={noop}
                  onDomainChange={noop}
                  onCustomDomainChange={noop}
                  onExposedPortChange={noop}
                />
              </div>
              <div className="mt-3">
                <DnsRecordCard
                  record={{ type: "A", host: "shop", value: "203.0.113.10" }}
                  onCopy={noop}
                />
              </div>
            </>
          )}
          {view === "operate" && (
            <>
              <h1 className="mb-2 text-2xl font-medium">Storefront</h1>
              <p className="mb-7 text-sm text-muted-foreground">Resource usage · Production</p>
              <div className="rounded-2xl bg-card p-5">
                <ResourceCards usage={usage} isConnected error={null} onReconnect={noop} />
              </div>
              <div className="mt-5">
                <ResourceHistoryChart buckets={buckets} granularityMinutes={5} isLoading={false} />
              </div>
            </>
          )}
        </div>
      </DeploymentContext.Provider>
    </PlatformProvider>
  );
}
