"use client";

import React, { useState } from "react";
import { usePlatform } from "@/context/PlatformContext";
import { servicesApi, type Service, type ServiceContainer } from "@/lib/api/services";
import { resolveServiceHostnameLabel } from "@repo/core";
import { useRouter } from "next/navigation";
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
  ArrowLeft,
  Settings2,
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
  const router = useRouter();
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const status = container?.status ?? (service.enabled ? "stopped" : "disabled");

  const resolvedUrl = service.exposed
    ? service.domainType === "custom" && service.customDomain
      ? `https://${service.customDomain}`
      : `https://${resolveServiceHostnameLabel(projectSlugBase, service.name, service.domain)}.${baseDomain}`
    : null;

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

  /* ── Render ─────────────────────────────────────────────────── */

  return (
    <div className="bg-card rounded-3xl border border-border/50 overflow-hidden shadow-[0_20px_60px_-40px_rgba(0,0,0,0.7)]">
      {/* ── Header ─────────────────────────────────────────────── */}
      <div className="flex items-start gap-3 px-6 py-5 border-b border-border/50">
        <div className="w-11 h-11 rounded-2xl bg-primary/10 flex items-center justify-center shrink-0 ring-1 ring-primary/15">
          <Container className="size-[18px] text-muted-foreground" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className="text-base font-semibold text-foreground truncate">{service.name}</h3>
            <StatusBadge status={status} />
          </div>
          <p className="text-[13px] text-muted-foreground truncate mt-1">
            {service.image || service.build || "—"}
          </p>
          {resolvedUrl && (
            <a
              href={resolvedUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-2 inline-flex items-center gap-1.5 text-[12px] font-medium text-blue-500 dark:text-blue-400 hover:underline"
            >
              {resolvedUrl.replace("https://", "")}
              <ExternalLink className="size-3" />
            </a>
          )}
        </div>
        <button
          onClick={onClose}
          className="inline-flex items-center gap-2 px-3 py-2 rounded-xl text-[13px] font-medium text-muted-foreground hover:bg-foreground/[0.06] transition-colors shrink-0"
        >
          <ArrowLeft className="size-4" />
          Back
        </button>
      </div>

      <div className="divide-y divide-border/30">
        {/* ── Status & Actions ──────────────────────────────────── */}
        <Section title="Status" icon={Power}>
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
              <p className="text-[12px] text-muted-foreground">No container running.</p>
            )}

            <div className="ml-auto">
              <button
                onClick={handleToggleEnabled}
                disabled={saving}
                className={`inline-flex items-center gap-1.5 px-3.5 py-2 rounded-2xl text-[12px] font-medium transition-colors disabled:opacity-50 ${
                  service.enabled
                    ? "bg-red-500/10 text-red-600 dark:text-red-400 hover:bg-red-500/20"
                    : "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 hover:bg-emerald-500/20"
                }`}
              >
                {saving ? <Loader2 className="size-3 animate-spin" /> : <Power className="size-3" />}
                {service.enabled ? "Disable" : "Enable"}
              </button>
            </div>
          </div>
        </Section>

        {/* ── Routing ───────────────────────────────────────────── */}
        <Section title="Routing" icon={Globe}>
          <div className="space-y-4">
            <div className="rounded-2xl border border-border/40 bg-muted/20 p-4 space-y-3">
              <div className="flex items-center justify-between gap-3">
                <span className="text-[13px] font-medium text-foreground">Exposure</span>
                <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-semibold ${service.exposed ? "bg-blue-500/10 text-blue-600 dark:text-blue-400" : "bg-muted/60 text-muted-foreground/70"}`}>
                  <span className={`w-1.5 h-1.5 rounded-full ${service.exposed ? "bg-blue-500" : "bg-muted-foreground/40"}`} />
                  {service.exposed ? "Public" : "Internal"}
                </span>
              </div>

              {service.exposed ? (
                <>
                  <InfoRow icon={Globe} label="Mode" value={service.domainType === "custom" ? "Custom domain" : "Free subdomain"} />
                  <InfoRow icon={Hash} label="Port" value={service.exposedPort || "Auto"} />
                  {resolvedUrl && <InfoRow icon={Globe} label="Live URL" value={resolvedUrl.replace("https://", "")} />}
                </>
              ) : (
                <p className="text-[12px] text-muted-foreground">This service is internal only. Manage public routing from the Domains tab.</p>
              )}
            </div>

            <button
              onClick={() => router.push(`/projects/${projectId}/domains?service=${service.id}`)}
              className="inline-flex items-center gap-2 px-4 py-2.5 rounded-2xl text-[13px] font-medium bg-primary/10 text-primary hover:bg-primary/15 transition-colors"
            >
              <Settings2 className="size-4" />
              Edit In Domains Tab
            </button>
          </div>
        </Section>

        {/* ── Network ───────────────────────────────────────────── */}
        {(container?.containerId || (service.ports && service.ports.length > 0)) && (
          <Section title="Network" icon={Network}>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
              {service.ports && service.ports.length > 0 && <InfoRow icon={Globe} label="Ports" value={service.ports.join(", ")} />}
              {container?.hostPort && <InfoRow icon={Hash} label="Host Port" value={String(container.hostPort)} />}
              {container?.ip && <InfoRow icon={Network} label="Container IP" value={container.ip} />}
              {container?.containerId && <InfoRow icon={Container} label="Container" value={container.containerId.slice(0, 12)} />}
            </div>
          </Section>
        )}

        {/* ── Configuration ─────────────────────────────────────── */}
        {(service.restart || service.command || (service.dependsOn && service.dependsOn.length > 0)) && (
          <Section title="Configuration" icon={Terminal}>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
              {service.restart && <InfoRow icon={RefreshCw} label="Restart" value={service.restart} />}
              {service.command && <InfoRow icon={Terminal} label="Command" value={service.command} />}
              {service.dependsOn && service.dependsOn.length > 0 && <InfoRow icon={Layers} label="Depends On" value={service.dependsOn.join(", ")} />}
            </div>
          </Section>
        )}

        {/* ── Environment ───────────────────────────────────────── */}
        {service.environment && Object.keys(service.environment).length > 0 && (
          <Section title={`Environment (${Object.keys(service.environment).length})`} icon={Variable}>
            <div className="rounded-xl bg-muted/30 border border-border/40 px-3 py-2 space-y-1 max-h-48 overflow-y-auto">
              {Object.entries(service.environment).map(([k, v]) => (
                <div key={k} className="flex items-baseline gap-2 text-[12px] font-mono">
                  <span className="text-foreground/80 shrink-0">{k}</span>
                  <span className="text-muted-foreground">=</span>
                  <span className="text-muted-foreground truncate">{v}</span>
                </div>
              ))}
            </div>
          </Section>
        )}

        {/* ── Volumes ───────────────────────────────────────────── */}
        {service.volumes && service.volumes.length > 0 && (
          <Section title="Volumes" icon={Terminal}>
            <div className="rounded-xl bg-muted/30 border border-border/40 px-3 py-2 space-y-1">
              {service.volumes.map((vol) => (
                <p key={vol} className="text-[12px] font-mono text-muted-foreground truncate">{vol}</p>
              ))}
            </div>
          </Section>
        )}
      </div>
    </div>
  );
}

/* ── Primitives ─────────────────────────────────────────────────────── */

function Section({ title, icon: Icon, children }: { title: string; icon: React.ComponentType<{ className?: string }>; children: React.ReactNode }) {
  return (
    <div className="px-6 py-5 space-y-4">
      <div className="flex items-center gap-2">
        <Icon className="size-3.5 text-muted-foreground" />
        <span className="text-[11px] font-medium text-muted-foreground uppercase tracking-[0.18em]">{title}</span>
      </div>
      {children}
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, { dot: string; badge: string; label: string }> = {
    running: { dot: "bg-emerald-500", badge: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400", label: "Running" },
    stopped: { dot: "bg-muted-foreground/30", badge: "bg-muted/60 text-muted-foreground/70", label: "Stopped" },
    disabled: { dot: "bg-muted-foreground/20", badge: "bg-muted/40 text-muted-foreground/50", label: "Disabled" },
    failed: { dot: "bg-red-500", badge: "bg-red-500/10 text-red-600 dark:text-red-400", label: "Failed" },
    starting: { dot: "bg-amber-500", badge: "bg-amber-500/10 text-amber-600 dark:text-amber-400", label: "Starting" },
  };
  const s = map[status] ?? map.stopped;
  return (
    <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-semibold ${s.badge}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${s.dot}`} />
      {s.label}
    </span>
  );
}

function ActionButton({ icon: Icon, label, loading, onClick, variant }: {
  icon: React.ComponentType<{ className?: string }>; label: string; loading: boolean; onClick: () => void; variant: "success" | "danger" | "warning";
}) {
  const colors = {
    success: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 hover:bg-emerald-500/20",
    danger: "bg-red-500/10 text-red-600 dark:text-red-400 hover:bg-red-500/20",
    warning: "bg-amber-500/10 text-amber-600 dark:text-amber-400 hover:bg-amber-500/20",
  };
  return (
    <button onClick={(e) => { e.stopPropagation(); onClick(); }} disabled={loading}
      className={`inline-flex items-center gap-1.5 px-3 py-2 rounded-xl text-[13px] font-medium transition-colors disabled:opacity-50 ${colors[variant]}`}>
      {loading ? <Loader2 className="size-3.5 animate-spin" /> : <Icon className="size-3.5" />}
      {label}
    </button>
  );
}

function InfoRow({ icon: Icon, label, value }: { icon: React.ComponentType<{ className?: string }>; label: string; value: string }) {
  return (
    <div className="flex items-center gap-2.5">
      <Icon className="size-3.5 text-muted-foreground shrink-0" />
      <span className="text-[12px] text-muted-foreground shrink-0">{label}</span>
      <span className="text-[12px] font-medium text-foreground truncate">{value}</span>
    </div>
  );
}
