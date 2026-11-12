"use client";

import { useEffect, useState } from "react";
import { useI18n } from "@/components/i18n-provider";
import { Icon } from "@repo/ui/icons";
import { PlatformProvider } from "@/context/PlatformContext";
import { DeploymentContext } from "@/context/DeploymentContext";
import { deployment } from "./fixture";
import { RepositoryList } from "@/app/(dashboard)/library/components/RepositoryList";
import type { GitHubAccount, GitHubRepo } from "@/context/GitHubContext";
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

// Small, original avatars keep the sample accounts recognizable and captures
// deterministic, without fetching real people's photos or organization data.
const avatar = (art: string) =>
  `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">${art}</svg>`)}`;
const accounts: GitHubAccount[] = [
  {
    login: "maya-chen",
    type: "User",
    avatar_url: avatar(
      '<rect width="64" height="64" fill="#d5e5df"/><path d="M9 64c0-17 9-26 23-26s23 9 23 26" fill="#405e56"/><ellipse cx="32" cy="28" rx="14" ry="18" fill="#e7b695"/><path d="M17 29C12 7 29 3 40 9c10 4 10 15 7 23l-5-12c-9 3-16 0-18-3l-5 14z" fill="#302b2b"/>',
    ),
  },
  {
    login: "acme",
    type: "Organization",
    avatar_url: avatar(
      '<rect width="64" height="64" fill="#eab46c"/><path d="M15 46 30 15h6l14 31H39l-6-15-7 15z" fill="#302b24"/><path d="M29 42h8" stroke="#fff3de" stroke-width="4" stroke-linecap="round"/>',
    ),
  },
  {
    login: "orbit-labs",
    type: "Organization",
    avatar_url: avatar(
      '<rect width="64" height="64" fill="#71689b"/><circle cx="32" cy="32" r="7" fill="#f6f1ff"/><ellipse cx="32" cy="32" rx="22" ry="11" transform="rotate(-38 32 32)" fill="none" stroke="#e0d7f2" stroke-width="3"/><circle cx="48" cy="18" r="4" fill="#eab46c"/>',
    ),
  },
];

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
  const { t } = useI18n();
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
      <DeploymentContext.Provider
        value={{
          ...deployment(view === "ship"),
          steps: [
            { label: t.deploy.targetStep.build.actionPrepare, icon: "server" },
            { label: t.projectSettings.advanced.transfer.clone, icon: "git-branch" },
            { label: t.deploy.buildSummary.install, icon: "download" },
            { label: t.importProject.buildSettings.build, icon: "wrench" },
            { label: t.deploy.sidebar.deploy, icon: "rocket" },
          ],
        }}
      >
        <div
          data-walkthrough-capture={view}
          className="bg-background text-foreground"
          style={{ width: 900, height: 675, padding: 28 }}
        >
          {view === "connect" && (
            <>
              <h1 className="mb-2 text-2xl font-medium">{t.library.page.title}</h1>
              <p className="mb-7 text-sm text-muted-foreground">{t.library.page.subtitle}</p>
              <RepositoryList
                repos={repos}
                accounts={accounts}
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
                <DeploymentLogsPanel title={t.importProject.deploymentProcessing.buildTerminal}>
                  <LogSnapshotTerminal logs={logs} emptyLabel="" />
                </DeploymentLogsPanel>
              ) : (
                <DeploymentDetails />
              )}
            </>
          )}
          {view === "route" && (
            <>
              <h1 className="mb-2 text-2xl font-medium">{t.dashboard.pages.domains.title}</h1>
              <p className="mb-7 text-sm text-muted-foreground">Storefront · Production</p>
              <div className="rounded-2xl bg-card p-5">
                <div className="mb-4 flex items-center gap-3">
                  <Icon name="globe" className="size-5" />
                  <h2 className="text-lg font-medium">
                    {t.importProject.composeServices.domain.publicDomain}
                  </h2>
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
              <p className="mb-7 text-sm text-muted-foreground">
                {t.projects.monitoring.resourcesTitle} · Production
              </p>
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
