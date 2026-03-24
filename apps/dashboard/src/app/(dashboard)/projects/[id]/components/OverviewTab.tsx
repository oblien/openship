"use client";

import React from "react";
import { useProjectSettings } from "@/context/ProjectSettingsContext";
import { usePlatform } from "@/context/PlatformContext";
import { useCloud } from "@/context/CloudContext";
import { getProjectStatus, PROJECT_STATUS_META } from "@/utils/project-status";
import { formatDate } from "@/utils/date";
import {
  ExternalLink,
  GitBranch,
  Globe,
  Clock,
  Cloud,
  HardDrive,
  Container,
  Cpu,
  Moon,
  Zap,
  CheckCircle2,
  XCircle,
  Server,
  Hammer,
  Database,
  Plus,
  Layers,
} from "lucide-react";

export const OverviewTab = () => {
  const { projectData, domain, gitData, buildData } = useProjectSettings();
  const { selfHosted, deployMode } = usePlatform();
  const { connected: cloudConnected } = useCloud();

  const status = getProjectStatus(projectData as any);
  const meta = PROJECT_STATUS_META[status];

  const isCloud = !selfHosted || cloudConnected;
  const hasGit = !!(projectData.gitOwner && projectData.gitRepo);
  const runtimeLabel =
    deployMode === "desktop" ? "Desktop" : deployMode === "docker" ? "Docker" : "Bare Metal";
  const modeLabel =
    projectData.productionMode === "static"
      ? "Static Site"
      : projectData.productionMode === "standalone"
        ? "Standalone"
        : "Server";

  return (
    <div className="space-y-5">
      {/* ── Info sections ─────────────────────────────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">

        {/* Infrastructure */}
        <Card title="Infrastructure" icon={Cpu} iconColor="primary">
          <Item label="Platform" value={isCloud ? "Openship Cloud" : "Self-hosted"} />
          <Item label="Runtime" value={runtimeLabel} />
          <Item label="Mode" value={modeLabel} />
          <Item label="Port" value={String(projectData.port || 3000)} />
          <Item label="Sleep"  value={projectData.sleepMode === "always_on" ? "Always On" : "Auto Sleep"} />
        </Card>

        {/* Source & CI/CD */}
        <Card title="Source & CI/CD" icon={GitBranch} iconColor="orange">
          <div className="flex items-center justify-between">
            <span className="text-[13px] text-muted-foreground">Repository</span>
            {hasGit ? (
              <a
                href={`https://github.com/${projectData.gitOwner}/${projectData.gitRepo}`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-[13px] font-medium text-foreground hover:text-primary transition-colors inline-flex items-center gap-1.5 truncate max-w-[180px]"
              >
                {projectData.gitOwner}/{projectData.gitRepo}
                <ExternalLink className="size-3 shrink-0 text-muted-foreground" />
              </a>
            ) : (
              <span className="text-[13px] text-muted-foreground/60">Not connected</span>
            )}
          </div>
          <Item label="Branch" value={projectData.gitBranch || projectData.branch || "main"} />
          <StatusItem label="Auto Deploy" active={!!gitData?.autoDeployEnabled} />
          <StatusItem label="Webhook" active={!!gitData?.webhookActive} />
        </Card>
      </div>

      {/* Connected Services */}
      <Card title="Connected Services" icon={Layers} iconColor="emerald">
        <div className="py-3 text-center">
          <div className="w-10 h-10 rounded-xl bg-muted/50 flex items-center justify-center mx-auto mb-3">
            <Database className="size-5 text-muted-foreground/50" />
          </div>
          <p className="text-[13px] font-medium text-foreground/70 mb-1">No services connected</p>
          <p className="text-[12px] text-muted-foreground/60 mb-4 max-w-[260px] mx-auto leading-relaxed">
            Add databases, caches, or other services to extend your project.
          </p>
          <div className="flex flex-wrap justify-center gap-2 mb-4">
            {[
              { label: "PostgreSQL", icon: Database },
              { label: "Redis", icon: Zap },
              { label: "MySQL", icon: Database },
            ].map((svc) => (
              <span
                key={svc.label}
                className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-muted/40 text-[12px] text-muted-foreground"
              >
                <svc.icon className="size-3" />
                {svc.label}
              </span>
            ))}
          </div>
          <button className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-[13px] font-medium bg-foreground/[0.06] text-foreground hover:bg-foreground/[0.1] transition-colors">
            <Plus className="size-3.5" />
            Add Service
          </button>
        </div>
      </Card>
    </div>
  );
};

/* ── Sub-components ────────────────────────────────────────────────── */

const ICON_COLORS: Record<string, { bg: string; text: string }> = {
  primary: { bg: "bg-primary/10", text: "text-primary" },
  orange: { bg: "bg-orange-500/10", text: "text-orange-500" },
  blue: { bg: "bg-blue-500/10", text: "text-blue-500" },
  emerald: { bg: "bg-emerald-500/10", text: "text-emerald-500" },
};

function Card({
  title,
  icon: Icon,
  iconColor = "primary",
  children,
}: {
  title: string;
  icon: React.ComponentType<{ className?: string }>;
  iconColor?: keyof typeof ICON_COLORS;
  children: React.ReactNode;
}) {
  const colors = ICON_COLORS[iconColor] || ICON_COLORS.primary;
  return (
    <div className="bg-card rounded-2xl border border-border/50">
      <div className="flex items-center gap-3 px-5 py-4 border-b border-border/50">
        <div className={`w-8 h-8 rounded-lg flex items-center justify-center ${colors.bg}`}>
          <Icon className={`size-4 ${colors.text}`} />
        </div>
        <h3 className="text-[14px] font-semibold text-foreground">{title}</h3>
      </div>
      <div className="px-5 py-4 space-y-3">{children}</div>
    </div>
  );
}

function Item({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <span className="text-[13px] text-muted-foreground">{label}</span>
      <span className="text-[13px] font-medium text-foreground truncate max-w-[200px]">{value}</span>
    </div>
  );
}

function StatusItem({ label, active }: { label: string; active: boolean }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <span className="text-[13px] text-muted-foreground">{label}</span>
      <span
        className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11px] font-semibold ${
          active
            ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
            : "bg-muted/60 text-muted-foreground/60"
        }`}
      >
        <span className={`w-1.5 h-1.5 rounded-full ${active ? "bg-emerald-500" : "bg-muted-foreground/30"}`} />
        {active ? "Active" : "Off"}
      </span>
    </div>
  );
}
