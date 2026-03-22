"use client";

import React, { useEffect, useState, useCallback } from "react";
import { Server, Cloud, Cpu, ArrowRight, Pencil, ChevronDown, CheckCircle2 } from "lucide-react";
import { useDeployment } from "@/context/DeploymentContext";
import { useCloud } from "@/context/CloudContext";
import { systemApi } from "@/lib/api/system";
import type { ServerInfo } from "@/lib/api/system";
import type { DeployTarget, BuildStrategy } from "@/context/deployment/types";

// ─── Option card ─────────────────────────────────────────────────────────────

interface OptionCardProps {
  value: string;
  selected: boolean;
  onSelect: () => void;
  icon: React.ReactNode;
  label: string;
  description: string;
  /** Optional children rendered below when selected */
  children?: React.ReactNode;
}

const OptionCard: React.FC<OptionCardProps> = ({
  selected,
  onSelect,
  icon,
  label,
  description,
  children,
}) => (
  <div>
    <button
      type="button"
      onClick={onSelect}
      className={`
        relative w-full text-left p-4 rounded-xl border transition-all
        ${selected
          ? "border-primary bg-primary/5 ring-1 ring-primary/20"
          : "border-border/50 bg-card hover:border-primary/30 hover:bg-primary/[0.02]"
        }
        ${selected && children ? "rounded-b-none border-b-0" : ""}
      `}
    >
      <div className="flex items-start gap-3">
        <div className={`p-2 rounded-lg ${selected ? "bg-primary/10 text-primary" : "bg-muted/50 text-muted-foreground"}`}>
          {icon}
        </div>
        <div className="flex-1 min-w-0">
          <p className={`text-sm font-semibold ${selected ? "text-foreground" : "text-foreground/80"}`}>
            {label}
          </p>
          <p className="text-xs text-muted-foreground mt-0.5 leading-relaxed">
            {description}
          </p>
        </div>
        {selected && (
          <div className="size-5 rounded-full bg-primary flex items-center justify-center shrink-0 mt-0.5">
            <div className="size-2 rounded-full bg-primary-foreground" />
          </div>
        )}
      </div>
    </button>
    {selected && children && (
      <div className="border border-t-0 border-primary/20 bg-primary/[0.02] rounded-b-xl px-4 pb-4 pt-2">
        {children}
      </div>
    )}
  </div>
);

// ─── Server sub-selector (shown when "Servers" is selected with multiple) ────

interface ServerSubSelectorProps {
  servers: ServerInfo[];
  selectedId?: string;
  onSelect: (server: ServerInfo) => void;
}

const ServerSubSelector: React.FC<ServerSubSelectorProps> = ({
  servers,
  selectedId,
  onSelect,
}) => (
  <div className="space-y-1.5">
    <p className="text-xs font-medium text-muted-foreground mb-2">Choose a server</p>
    {servers.map((s) => {
      const isSelected = selectedId === s.id;
      return (
        <button
          key={s.id}
          type="button"
          onClick={() => onSelect(s)}
          className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-left transition-all ${
            isSelected
              ? "bg-primary/10 border border-primary/30"
              : "bg-card/60 border border-border/30 hover:border-primary/20 hover:bg-muted/30"
          }`}
        >
          <div className={`w-7 h-7 rounded-md flex items-center justify-center shrink-0 ${
            isSelected ? "bg-primary/15 text-primary" : "bg-muted/50 text-muted-foreground"
          }`}>
            <Server className="size-3.5" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-foreground truncate">
              {s.name || s.sshHost}
            </p>
            <p className="text-[11px] text-muted-foreground">
              {s.sshUser || "root"}@{s.sshHost}:{s.sshPort || 22}
            </p>
          </div>
          {isSelected && (
            <CheckCircle2 className="size-4 text-primary shrink-0" />
          )}
        </button>
      );
    })}
  </div>
);

// ─── Compact summary (shown when editing from step 2) ────────────────────────

interface CompactSummaryProps {
  deployTarget: DeployTarget;
  buildStrategy: BuildStrategy;
  serverName?: string | null;
  onEdit: () => void;
}

const targetLabels: Record<DeployTarget, { label: string; icon: React.ReactNode }> = {
  local: { label: "This Machine", icon: <Cpu className="size-3.5" /> },
  server: { label: "My Server", icon: <Server className="size-3.5" /> },
  cloud: { label: "Oblien Cloud", icon: <Cloud className="size-3.5" /> },
};

const buildLabels: Record<BuildStrategy, { label: string; icon: React.ReactNode }> = {
  local: { label: "This Machine", icon: <Cpu className="size-3.5" /> },
  server: { label: "Remote", icon: <Cloud className="size-3.5" /> },
};

export const DeployTargetSummary: React.FC<CompactSummaryProps> = ({
  deployTarget,
  buildStrategy,
  serverName,
  onEdit,
}) => {
  const target = targetLabels[deployTarget];
  const build = buildLabels[buildStrategy];
  const deployLabel = deployTarget === "server" && serverName
    ? serverName
    : target.label;

  return (
    <button
      type="button"
      onClick={onEdit}
      className="w-full flex items-center gap-3 px-4 py-3 bg-card rounded-xl border border-border/50 hover:border-primary/30 transition-all group"
    >
      <div className="flex items-center gap-4 flex-1 min-w-0">
        <div className="flex items-center gap-1.5 text-sm">
          {build.icon}
          <span className="text-muted-foreground">Build:</span>
          <span className="font-medium text-foreground">{build.label}</span>
        </div>
        <ArrowRight className="size-3 text-muted-foreground/50" />
        <div className="flex items-center gap-1.5 text-sm">
          {target.icon}
          <span className="text-muted-foreground">Deploy:</span>
          <span className="font-medium text-foreground">{deployLabel}</span>
        </div>
      </div>
      <Pencil className="size-3.5 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" />
    </button>
  );
};

// ─── Hook: resolve available targets ─────────────────────────────────────────

export interface ResolvedTargets {
  ready: boolean;
  /** All configured servers */
  servers: ServerInfo[];
  hasCloudConnected: boolean;
  /** True when there's a real choice to make */
  hasChoice: boolean;
}

export function useDesktopTargets(): ResolvedTargets {
  const cloud = useCloud();
  const [servers, setServers] = useState<ServerInfo[]>([]);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    systemApi.listServers()
      .then((list) => { if (!cancelled) setServers(list); })
      .catch(() => {})
      .finally(() => { if (!cancelled) setReady(true); });
    return () => { cancelled = true; };
  }, []);

  const hasServers = servers.length > 0;
  const hasCloudConnected = cloud.connected;

  return {
    ready,
    servers,
    hasCloudConnected,
    hasChoice: hasServers && hasCloudConnected,
  };
}

// ─── Main step ───────────────────────────────────────────────────────────────

interface DeployTargetStepProps {
  targets: ResolvedTargets;
  onContinue: () => void;
}

const DeployTargetStep: React.FC<DeployTargetStepProps> = ({ targets, onContinue }) => {
  const { config, updateConfig } = useDeployment();
  const { servers, hasCloudConnected, hasChoice } = targets;
  const hasServers = servers.length > 0;
  const isSingleServer = servers.length === 1;

  // Auto-set deploy target when there's only one option
  useEffect(() => {
    if (!hasChoice) {
      if (hasServers) {
        updateConfig({ deployTarget: "server", serverId: servers[0].id });
      } else {
        updateConfig({ deployTarget: "cloud" });
      }
    }
  }, [hasChoice, hasServers, hasCloudConnected]);

  // Auto-select single server
  useEffect(() => {
    if (isSingleServer && config.deployTarget === "server" && !config.serverId) {
      updateConfig({ serverId: servers[0].id });
    }
  }, [isSingleServer, config.deployTarget, config.serverId]);

  const handleDeployTargetChange = (target: DeployTarget) => {
    const updates: Partial<typeof config> = { deployTarget: target };
    if (target === "cloud") {
      updates.serverId = undefined;
    }
    if (target === "server" && isSingleServer) {
      updates.serverId = servers[0].id;
    }
    updateConfig(updates);
  };

  const handleServerSelect = (server: ServerInfo) => {
    updateConfig({ deployTarget: "server", serverId: server.id });
  };

  // Build the deploy target options
  const deployTargetOptions: Array<{
    value: DeployTarget;
    icon: React.ReactNode;
    label: string;
    description: string;
  }> = [];

  if (hasServers) {
    if (isSingleServer) {
      // Single server → show directly by name
      deployTargetOptions.push({
        value: "server",
        icon: <Server className="size-5" />,
        label: servers[0].name || servers[0].sshHost,
        description: "Deploy to your remote server via SSH.",
      });
    } else {
      // Multiple servers → show "Servers" category
      deployTargetOptions.push({
        value: "server",
        icon: <Server className="size-5" />,
        label: "Servers",
        description: `Choose from ${servers.length} configured servers.`,
      });
    }
  }

  if (hasCloudConnected) {
    deployTargetOptions.push({
      value: "cloud",
      icon: <Cloud className="size-5" />,
      label: "Oblien Cloud",
      description: "Deploy to managed cloud infrastructure. No server setup needed.",
    });
  }

  const buildOptions: Array<{
    value: BuildStrategy;
    icon: React.ReactNode;
    label: string;
    description: string;
  }> = [
    {
      value: "local",
      icon: <Cpu className="size-5" />,
      label: "This Machine",
      description: "Build locally, then transfer the output. Faster if you have a powerful machine.",
    },
    {
      value: "server",
      icon: <Cloud className="size-5" />,
      label: "Remote",
      description: "Build on the deploy target. Best when your machine has limited resources.",
    },
  ];

  // Determine the selected server name for continue button context
  const selectedServer = servers.find((s) => s.id === config.serverId);
  const canContinue = config.deployTarget === "cloud" ||
    (config.deployTarget === "server" && !!config.serverId);

  return (
    <div className="space-y-8">
      {/* Deploy target — only when there's a real choice */}
      {hasChoice && (
        <div className="space-y-3">
          <div>
            <h3 className="text-base font-semibold text-foreground">
              Where do you want to deploy?
            </h3>
            <p className="text-sm text-muted-foreground mt-0.5">
              Choose where your application will run
            </p>
          </div>
          <div className="space-y-2">
            {deployTargetOptions.map((opt) => (
              <OptionCard
                key={opt.value}
                value={opt.value}
                selected={config.deployTarget === opt.value}
                onSelect={() => handleDeployTargetChange(opt.value)}
                icon={opt.icon}
                label={opt.label}
                description={opt.description}
              >
                {/* Sub-selector for multiple servers */}
                {opt.value === "server" && !isSingleServer && config.deployTarget === "server" && (
                  <ServerSubSelector
                    servers={servers}
                    selectedId={config.serverId}
                    onSelect={handleServerSelect}
                  />
                )}
              </OptionCard>
            ))}
          </div>
        </div>
      )}

      {/* Build location — always shown on desktop because strategy still matters
          even for source-only deployments (clone/stage/transfer path). */}
      <div className="space-y-3">
        <div>
          <h3 className="text-base font-semibold text-foreground">
            {config.options.hasBuild ? "Where do you want to build?" : "Where do you want to prepare it?"}
          </h3>
          <p className="text-sm text-muted-foreground mt-0.5">
            {config.options.hasBuild
              ? "Choose where the build process runs"
              : "Choose where the repository is cloned and staged before deploy"}
          </p>
        </div>
        <div className="space-y-2">
          {buildOptions.map((opt) => (
            <OptionCard
              key={opt.value}
              value={opt.value}
              selected={config.buildStrategy === opt.value}
              onSelect={() => updateConfig({ buildStrategy: opt.value })}
              icon={opt.icon}
              label={opt.label}
              description={opt.description}
            />
          ))}
        </div>
      </div>

      {/* Continue */}
      <button
        type="button"
        onClick={onContinue}
        disabled={!canContinue}
        className="w-full inline-flex items-center justify-center gap-2 px-5 py-3 bg-primary text-primary-foreground text-sm font-medium rounded-xl hover:bg-primary/90 transition-all hover:shadow-lg hover:shadow-primary/25 hover:-translate-y-0.5 disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:translate-y-0 disabled:hover:shadow-none"
      >
        Continue
        <ArrowRight className="size-4" />
      </button>
    </div>
  );
};

export default DeployTargetStep;
