"use client";

import React, { useState } from "react";
import { usePlatform } from "@/context/PlatformContext";
import { servicesApi, type Service, type ServiceContainer } from "@/lib/api/services";
import { resolveServiceHostnameLabel } from "@repo/core";
import { RoutingSettingsCard } from "@/components/routing/RoutingSettingsCard";
import {
  Play,
  Square,
  RefreshCw,
  Globe,
  Terminal,
  Variable,
  Container,
  Loader2,
  Network,
  Hash,
  ExternalLink,
  Power,
  RotateCw,
  Layers,
  Copy,
  Check,
  HardDrive,
  Settings,
} from "lucide-react";

/* ── Props ──────────────────────────────────────────────────────────── */

interface ServiceDetailPanelProps {
  service: Service;
  container?: ServiceContainer;
  projectId: string;
  projectSlugBase: string;
  onClose: () => void;
  onRefresh: () => void;
}

/* ── Panel ──────────────────────────────────────────────────────────── */

export function ServiceDetailPanel({
  service,
  container,
  projectId,
  projectSlugBase,
  onClose,
  onRefresh,
}: ServiceDetailPanelProps) {
  const { baseDomain } = usePlatform();
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [routingSaving, setRoutingSaving] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const status = container?.status ?? (service.enabled ? "stopped" : "disabled");

  const resolvedUrl = service.exposed
    ? service.domainType === "custom" && service.customDomain
      ? `https://${service.customDomain}`
      : `https://${resolveServiceHostnameLabel(projectSlugBase, service.name, service.domain)}.${baseDomain}`
    : null;

  const copy = (text: string, id: string) => {
    navigator.clipboard.writeText(text);
    setCopied(id);
    setTimeout(() => setCopied(null), 2000);
  };

  /* ── Handlers ───────────────────────────────────────────────── */

  const handleContainerAction = async (action: "start" | "stop" | "restart") => {
    setActionLoading(action);
    try {
      if (action === "start") await servicesApi.start(projectId, service.id);
      else if (action === "stop") await servicesApi.stop(projectId, service.id);
      else await servicesApi.restart(projectId, service.id);
      onRefresh();
    } finally {
      setActionLoading(null);
    }
  };

  const handleToggleEnabled = async () => {
    setSaving(true);
    try {
      await servicesApi.update(projectId, service.id, { enabled: !service.enabled });
      onRefresh();
    } finally {
      setSaving(false);
    }
  };

  const handleRoutingUpdate = async (patch: Partial<Service>) => {
    setRoutingSaving(true);
    try {
      await servicesApi.update(projectId, service.id, patch);
      onRefresh();
    } finally {
      setRoutingSaving(false);
    }
  };

  /* ── Render ─────────────────────────────────────────────────── */

  return (
    <div className="space-y-4">
      {/* ── Hero Header ────────────────────────────────────────── */}
      <div className="bg-card rounded-2xl border border-border/50 overflow-hidden">
        <div className="px-6 py-6">
          <div className="flex items-start gap-4">
            <div className="w-12 h-12 rounded-2xl bg-primary/10 flex items-center justify-center shrink-0 ring-1 ring-primary/15">
              <Container className="size-5 text-primary" />
            </div>

            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-3 flex-wrap">
                <h2 className="text-lg font-semibold text-foreground tracking-tight">{service.name}</h2>
                <StatusBadge status={status} />
              </div>

              <p className="text-sm text-muted-foreground mt-1 truncate">
                {service.image || service.build || "No image specified"}
              </p>

              {resolvedUrl && (
                <a
                  href={resolvedUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="mt-2 inline-flex items-center gap-1.5 text-sm font-medium text-blue-500 dark:text-blue-400 hover:underline"
                >
                  {resolvedUrl.replace("https://", "")}
                  <ExternalLink className="size-3.5" />
                </a>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* ── Controls ───────────────────────────────────────────── */}
      <div className="bg-card rounded-2xl border border-border/50 overflow-hidden">
        <div className="px-6 py-5">
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-2 flex-wrap">
              {container?.containerId ? (
                <>
                  {status === "running" && (
                    <>
                      <ActionButton icon={Square} label="Stop" loading={actionLoading === "stop"} onClick={() => handleContainerAction("stop")} variant="danger" />
                      <ActionButton icon={RotateCw} label="Restart" loading={actionLoading === "restart"} onClick={() => handleContainerAction("restart")} variant="warning" />
                    </>
                  )}
                  {status === "stopped" && (
                    <ActionButton icon={Play} label="Start" loading={actionLoading === "start"} onClick={() => handleContainerAction("start")} variant="success" />
                  )}
                </>
              ) : (
                <p className="text-sm text-muted-foreground">No container running</p>
              )}
            </div>

            <button
              onClick={handleToggleEnabled}
              disabled={saving}
              className={`inline-flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-medium transition-all disabled:opacity-50 ${
                service.enabled
                  ? "bg-red-500/10 text-red-600 dark:text-red-400 hover:bg-red-500/20 ring-1 ring-red-500/10"
                  : "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 hover:bg-emerald-500/20 ring-1 ring-emerald-500/10"
              }`}
            >
              {saving ? <Loader2 className="size-4 animate-spin" /> : <Power className="size-4" />}
              {service.enabled ? "Disable Service" : "Enable Service"}
            </button>
          </div>
        </div>
      </div>

      {/* ── Routing ────────────────────────────────────────────── */}
      <div className="bg-card rounded-2xl border border-border/50 overflow-hidden">
        <SectionHeader title="Routing" subtitle="Control how this service is accessed" icon={Globe} />
        <div className="px-6 pb-6">
          <RoutingSettingsCard
            projectName={projectSlugBase}
            domain={service.domain ?? ""}
            customDomain={service.customDomain ?? ""}
            domainType={service.domainType === "custom" ? "custom" : "free"}
            exposed={service.exposed}
            ports={service.ports}
            exposedPort={service.exposedPort ?? ""}
            disabled={routingSaving || !service.enabled}
            liveUrl={resolvedUrl}
            onExposedChange={(value) => handleRoutingUpdate({ exposed: value })}
            onDomainTypeChange={(value) => handleRoutingUpdate({ domainType: value })}
            onDomainChange={(value) => handleRoutingUpdate({ domain: value })}
            onCustomDomainChange={(value) => handleRoutingUpdate({ customDomain: value })}
            onExposedPortChange={(value) => handleRoutingUpdate({ exposedPort: value })}
            saveMode="explicit"
          />
          {!service.enabled && service.exposed && (
            <p className="mt-3 text-xs text-amber-600 dark:text-amber-400">
              Service is disabled — routes are inactive until the service is re-enabled.
            </p>
          )}
        </div>
      </div>

      {/* ── Network Info ───────────────────────────────────────── */}
      {(container?.containerId || (service.ports && service.ports.length > 0)) && (
        <div className="bg-card rounded-2xl border border-border/50 overflow-hidden">
          <SectionHeader title="Network" subtitle="Container networking details" icon={Network} />
          <div className="px-6 pb-6">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {service.ports && service.ports.length > 0 && (
                <InfoCard icon={Globe} label="Ports" value={service.ports.join(", ")} onCopy={() => copy(service.ports!.join(", "), "ports")} copied={copied === "ports"} />
              )}
              {container?.hostPort && (
                <InfoCard icon={Hash} label="Host Port" value={String(container.hostPort)} onCopy={() => copy(String(container.hostPort), "hostPort")} copied={copied === "hostPort"} />
              )}
              {container?.ip && (
                <InfoCard icon={Network} label="Container IP" value={container.ip} onCopy={() => copy(container.ip!, "ip")} copied={copied === "ip"} />
              )}
              {container?.containerId && (
                <InfoCard icon={Container} label="Container ID" value={container.containerId.slice(0, 12)} onCopy={() => copy(container.containerId!, "cid")} copied={copied === "cid"} />
              )}
            </div>
          </div>
        </div>
      )}

      {/* ── Configuration ──────────────────────────────────────── */}
      {(service.restart || service.command || (service.dependsOn && service.dependsOn.length > 0)) && (
        <div className="bg-card rounded-2xl border border-border/50 overflow-hidden">
          <SectionHeader title="Configuration" subtitle="Container runtime settings" icon={Settings} />
          <div className="px-6 pb-6">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {service.restart && (
                <InfoCard icon={RefreshCw} label="Restart Policy" value={service.restart} />
              )}
              {service.command && (
                <InfoCard icon={Terminal} label="Command" value={service.command} mono onCopy={() => copy(service.command!, "cmd")} copied={copied === "cmd"} />
              )}
              {service.dependsOn && service.dependsOn.length > 0 && (
                <InfoCard icon={Layers} label="Depends On" value={service.dependsOn.join(", ")} />
              )}
            </div>
          </div>
        </div>
      )}

      {/* ── Environment Variables ──────────────────────────────── */}
      {service.environment && Object.keys(service.environment).length > 0 && (
        <div className="bg-card rounded-2xl border border-border/50 overflow-hidden">
          <SectionHeader
            title="Environment Variables"
            subtitle={`${Object.keys(service.environment).length} variable${Object.keys(service.environment).length !== 1 ? "s" : ""} configured`}
            icon={Variable}
          />
          <div className="px-6 pb-6">
            <div className="rounded-xl bg-muted/30 border border-border/40 divide-y divide-border/30 max-h-64 overflow-y-auto">
              {Object.entries(service.environment).map(([k, v]) => (
                <div key={k} className="flex items-center gap-3 px-4 py-2.5 group">
                  <span className="text-sm font-mono font-medium text-foreground shrink-0">{k}</span>
                  <span className="text-sm text-muted-foreground">=</span>
                  <span className="text-sm font-mono text-muted-foreground truncate flex-1">{v}</span>
                  <button
                    onClick={() => copy(`${k}=${v}`, `env-${k}`)}
                    className="opacity-0 group-hover:opacity-100 p-1 hover:bg-muted rounded transition-all shrink-0"
                  >
                    {copied === `env-${k}` ? <Check className="size-3.5 text-emerald-500" /> : <Copy className="size-3.5 text-muted-foreground" />}
                  </button>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* ── Volumes ────────────────────────────────────────────── */}
      {service.volumes && service.volumes.length > 0 && (
        <div className="bg-card rounded-2xl border border-border/50 overflow-hidden">
          <SectionHeader
            title="Volumes"
            subtitle={`${service.volumes.length} mount${service.volumes.length !== 1 ? "s" : ""}`}
            icon={HardDrive}
          />
          <div className="px-6 pb-6">
            <div className="rounded-xl bg-muted/30 border border-border/40 divide-y divide-border/30">
              {service.volumes.map((vol) => (
                <div key={vol} className="flex items-center gap-3 px-4 py-2.5 group">
                  <span className="text-sm font-mono text-muted-foreground truncate flex-1">{vol}</span>
                  <button
                    onClick={() => copy(vol, `vol-${vol}`)}
                    className="opacity-0 group-hover:opacity-100 p-1 hover:bg-muted rounded transition-all shrink-0"
                  >
                    {copied === `vol-${vol}` ? <Check className="size-3.5 text-emerald-500" /> : <Copy className="size-3.5 text-muted-foreground" />}
                  </button>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ── Primitives ─────────────────────────────────────────────────────── */

function SectionHeader({ title, subtitle, icon: Icon }: { title: string; subtitle?: string; icon: React.ComponentType<{ className?: string }> }) {
  return (
    <div className="flex items-center gap-3 px-6 pt-5 pb-4">
      <div className="w-8 h-8 rounded-lg bg-muted/50 flex items-center justify-center shrink-0">
        <Icon className="size-4 text-muted-foreground" />
      </div>
      <div>
        <h3 className="text-sm font-semibold text-foreground">{title}</h3>
        {subtitle && <p className="text-xs text-muted-foreground mt-0.5">{subtitle}</p>}
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, { dot: string; badge: string; label: string }> = {
    running: { dot: "bg-emerald-500", badge: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 ring-1 ring-emerald-500/20", label: "Running" },
    stopped: { dot: "bg-muted-foreground/30", badge: "bg-muted/60 text-muted-foreground/70 ring-1 ring-border/50", label: "Stopped" },
    disabled: { dot: "bg-muted-foreground/20", badge: "bg-muted/40 text-muted-foreground/50 ring-1 ring-border/30", label: "Disabled" },
    failed: { dot: "bg-red-500", badge: "bg-red-500/10 text-red-600 dark:text-red-400 ring-1 ring-red-500/20", label: "Failed" },
    starting: { dot: "bg-amber-500", badge: "bg-amber-500/10 text-amber-600 dark:text-amber-400 ring-1 ring-amber-500/20", label: "Starting" },
  };
  const s = map[status] ?? map.stopped;
  return (
    <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold ${s.badge}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${s.dot}`} />
      {s.label}
    </span>
  );
}

function ActionButton({ icon: Icon, label, loading, onClick, variant }: {
  icon: React.ComponentType<{ className?: string }>; label: string; loading: boolean; onClick: () => void; variant: "success" | "danger" | "warning";
}) {
  const colors = {
    success: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 hover:bg-emerald-500/20 ring-1 ring-emerald-500/10",
    danger: "bg-red-500/10 text-red-600 dark:text-red-400 hover:bg-red-500/20 ring-1 ring-red-500/10",
    warning: "bg-amber-500/10 text-amber-600 dark:text-amber-400 hover:bg-amber-500/20 ring-1 ring-amber-500/10",
  };
  return (
    <button onClick={(e) => { e.stopPropagation(); onClick(); }} disabled={loading}
      className={`inline-flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-medium transition-all disabled:opacity-50 ${colors[variant]}`}>
      {loading ? <Loader2 className="size-4 animate-spin" /> : <Icon className="size-4" />}
      {label}
    </button>
  );
}

function InfoCard({ icon: Icon, label, value, mono, onCopy, copied }: {
  icon: React.ComponentType<{ className?: string }>; label: string; value: string; mono?: boolean; onCopy?: () => void; copied?: boolean;
}) {
  return (
    <div className="flex items-center gap-3 px-4 py-3 rounded-xl bg-muted/30 border border-border/40 group">
      <Icon className="size-4 text-muted-foreground shrink-0" />
      <div className="flex-1 min-w-0">
        <p className="text-xs text-muted-foreground">{label}</p>
        <p className={`text-sm font-medium text-foreground truncate mt-0.5 ${mono ? "font-mono" : ""}`}>{value}</p>
      </div>
      {onCopy && (
        <button
          onClick={onCopy}
          className="opacity-0 group-hover:opacity-100 p-1.5 hover:bg-muted rounded-lg transition-all shrink-0"
        >
          {copied ? <Check className="size-3.5 text-emerald-500" /> : <Copy className="size-3.5 text-muted-foreground" />}
        </button>
      )}
    </div>
  );
}
