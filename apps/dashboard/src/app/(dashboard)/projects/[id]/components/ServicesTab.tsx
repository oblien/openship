"use client";

import React, { useEffect, useState, useCallback } from "react";
import { useProjectSettings } from "@/context/ProjectSettingsContext";
import { servicesApi, type Service, type ServiceContainer } from "@/lib/api/services";
import {
  Layers,
  Play,
  Square,
  RefreshCw,
  ChevronDown,
  ChevronRight,
  Globe,
  Terminal,
  Variable,
  Container,
  AlertCircle,
  Loader2,
  Network,
  Hash,
} from "lucide-react";

/* ── Main Component ─────────────────────────────────────────────────── */

export const ServicesTab = () => {
  const { id } = useProjectSettings();

  const [services, setServices] = useState<Service[]>([]);
  const [containers, setContainers] = useState<ServiceContainer[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);

  const fetchData = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const [svcRes, ctRes] = await Promise.all([
        servicesApi.list(id),
        servicesApi.containers(id),
      ]);
      if (svcRes.success) setServices(svcRes.services ?? []);
      if (ctRes.success) setContainers(ctRes.containers ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load services");
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const handleSync = async () => {
    setSyncing(true);
    try {
      const res = await servicesApi.sync(id, []);
      if (res.success) {
        setServices(res.services ?? []);
      }
    } finally {
      setSyncing(false);
    }
  };

  const containerFor = (serviceId: string) =>
    containers.find((c) => c.serviceId === serviceId);

  /* ── Loading state ─────────────────────────────────────────────── */
  if (loading) {
    return (
      <div className="space-y-4">
        {[1, 2, 3].map((i) => (
          <div key={i} className="bg-card rounded-2xl border border-border/50 p-5 animate-pulse">
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-xl bg-muted" />
              <div className="flex-1 space-y-2">
                <div className="h-4 w-32 bg-muted rounded-lg" />
                <div className="h-3 w-48 bg-muted/60 rounded-lg" />
              </div>
            </div>
          </div>
        ))}
      </div>
    );
  }

  /* ── Error state ───────────────────────────────────────────────── */
  if (error) {
    return (
      <div className="bg-card rounded-2xl border border-border/50 p-8 text-center">
        <AlertCircle className="size-8 text-red-400 mx-auto mb-3" />
        <p className="text-sm font-medium text-foreground mb-1">Failed to load services</p>
        <p className="text-xs text-muted-foreground mb-4">{error}</p>
        <button
          onClick={fetchData}
          className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-[13px] font-medium bg-foreground/[0.06] text-foreground hover:bg-foreground/[0.1] transition-colors"
        >
          <RefreshCw className="size-3.5" />
          Retry
        </button>
      </div>
    );
  }

  /* ── Empty state ───────────────────────────────────────────────── */
  if (services.length === 0) {
    return (
      <div className="bg-card rounded-2xl border border-border/50 p-10 text-center">
        <div className="w-12 h-12 rounded-xl bg-muted/50 flex items-center justify-center mx-auto mb-4">
          <Layers className="size-6 text-muted-foreground/50" />
        </div>
        <p className="text-sm font-semibold text-foreground/80 mb-1">No services found</p>
        <p className="text-xs text-muted-foreground/60 max-w-[300px] mx-auto mb-5 leading-relaxed">
          Services are defined in your docker-compose file. Redeploy the project to sync services automatically.
        </p>
        <button
          onClick={handleSync}
          disabled={syncing}
          className="inline-flex items-center gap-1.5 px-4 py-2.5 rounded-xl text-[13px] font-medium bg-primary text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50"
        >
          {syncing ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
          Sync from Compose
        </button>
      </div>
    );
  }

  /* ── Service list ──────────────────────────────────────────────── */
  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="bg-card rounded-2xl border border-border/50 p-5">
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-primary/10 flex items-center justify-center">
              <Layers className="size-[18px] text-primary" />
            </div>
            <div>
              <h3 className="text-sm font-semibold text-foreground">
                {services.length} Service{services.length !== 1 ? "s" : ""}
              </h3>
              <p className="text-xs text-muted-foreground mt-0.5">
                Managed via docker-compose — each service runs as a container on a shared network.
              </p>
            </div>
          </div>
          <button
            onClick={handleSync}
            disabled={syncing}
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl text-[13px] font-medium bg-foreground/[0.06] text-foreground hover:bg-foreground/[0.1] transition-colors disabled:opacity-50"
          >
            {syncing ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
            Sync
          </button>
        </div>
      </div>

      {/* Service cards */}
      {services.map((svc) => {
        const ct = containerFor(svc.id);
        const expanded = expandedId === svc.id;

        return (
          <ServiceCard
            key={svc.id}
            service={svc}
            container={ct}
            expanded={expanded}
            onToggle={() => setExpandedId(expanded ? null : svc.id)}
            projectId={id}
            onRefresh={fetchData}
          />
        );
      })}
    </div>
  );
};

/* ── Service Card ───────────────────────────────────────────────────── */

function ServiceCard({
  service,
  container,
  expanded,
  onToggle,
  projectId,
  onRefresh,
}: {
  service: Service;
  container?: ServiceContainer;
  expanded: boolean;
  onToggle: () => void;
  projectId: string;
  onRefresh: () => void;
}) {
  const [toggling, setToggling] = useState(false);
  const status = container?.status ?? (service.enabled ? "stopped" : "disabled");

  const handleToggleEnabled = async () => {
    setToggling(true);
    try {
      await servicesApi.update(projectId, service.id, {
        enabled: !service.enabled,
      });
      onRefresh();
    } finally {
      setToggling(false);
    }
  };

  return (
    <div className="bg-card rounded-2xl border border-border/50 overflow-hidden">
      {/* Card header — always visible */}
      <button
        onClick={onToggle}
        className="w-full flex items-center gap-3 px-5 py-4 text-left hover:bg-foreground/[0.02] transition-colors"
      >
        <div className="flex items-center justify-center">
          {expanded ? (
            <ChevronDown className="size-4 text-muted-foreground" />
          ) : (
            <ChevronRight className="size-4 text-muted-foreground" />
          )}
        </div>

        {/* Icon */}
        <div className="w-9 h-9 rounded-xl bg-muted/60 flex items-center justify-center shrink-0">
          <Container className="size-[18px] text-muted-foreground" />
        </div>

        {/* Name & image */}
        <div className="flex-1 min-w-0">
          <p className="text-[14px] font-semibold text-foreground truncate">{service.name}</p>
          <p className="text-[12px] text-muted-foreground truncate mt-0.5">
            {service.image || service.build || "—"}
          </p>
        </div>

        {/* Status badge */}
        <StatusBadge status={status} />
      </button>

      {/* Expanded detail */}
      {expanded && (
        <div className="border-t border-border/50 px-5 py-4 space-y-4">
          {/* Quick info grid */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {service.ports && service.ports.length > 0 && (
              <InfoRow icon={Globe} label="Ports" value={service.ports.join(", ")} />
            )}
            {container?.hostPort && (
              <InfoRow icon={Hash} label="Host Port" value={String(container.hostPort)} />
            )}
            {container?.ip && (
              <InfoRow icon={Network} label="Container IP" value={container.ip} />
            )}
            {service.restart && (
              <InfoRow icon={RefreshCw} label="Restart" value={service.restart} />
            )}
            {service.command && (
              <InfoRow icon={Terminal} label="Command" value={service.command} />
            )}
            {service.dependsOn && service.dependsOn.length > 0 && (
              <InfoRow icon={Layers} label="Depends On" value={service.dependsOn.join(", ")} />
            )}
          </div>

          {/* Environment preview */}
          {service.environment && Object.keys(service.environment).length > 0 && (
            <div>
              <div className="flex items-center gap-2 mb-2">
                <Variable className="size-3.5 text-muted-foreground" />
                <span className="text-[12px] font-medium text-muted-foreground uppercase tracking-wider">
                  Environment ({Object.keys(service.environment).length})
                </span>
              </div>
              <div className="rounded-xl bg-muted/30 border border-border/40 px-3 py-2 space-y-1 max-h-40 overflow-y-auto">
                {Object.entries(service.environment).map(([k, v]) => (
                  <div key={k} className="flex items-baseline gap-2 text-[12px] font-mono">
                    <span className="text-foreground/80 shrink-0">{k}</span>
                    <span className="text-muted-foreground">=</span>
                    <span className="text-muted-foreground truncate">{v}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Volumes */}
          {service.volumes && service.volumes.length > 0 && (
            <div>
              <div className="flex items-center gap-2 mb-2">
                <Terminal className="size-3.5 text-muted-foreground" />
                <span className="text-[12px] font-medium text-muted-foreground uppercase tracking-wider">
                  Volumes
                </span>
              </div>
              <div className="rounded-xl bg-muted/30 border border-border/40 px-3 py-2 space-y-1">
                {service.volumes.map((vol) => (
                  <p key={vol} className="text-[12px] font-mono text-muted-foreground truncate">{vol}</p>
                ))}
              </div>
            </div>
          )}

          {/* Actions */}
          <div className="flex items-center gap-2 pt-1">
            <button
              onClick={handleToggleEnabled}
              disabled={toggling}
              className={`inline-flex items-center gap-1.5 px-3 py-2 rounded-xl text-[13px] font-medium transition-colors disabled:opacity-50 ${
                service.enabled
                  ? "bg-red-500/10 text-red-600 dark:text-red-400 hover:bg-red-500/20"
                  : "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 hover:bg-emerald-500/20"
              }`}
            >
              {toggling ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : service.enabled ? (
                <Square className="size-3.5" />
              ) : (
                <Play className="size-3.5" />
              )}
              {service.enabled ? "Disable" : "Enable"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/* ── Sub-components ─────────────────────────────────────────────────── */

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, { dot: string; badge: string; label: string }> = {
    running: {
      dot: "bg-emerald-500",
      badge: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
      label: "Running",
    },
    stopped: {
      dot: "bg-muted-foreground/30",
      badge: "bg-muted/60 text-muted-foreground/70",
      label: "Stopped",
    },
    disabled: {
      dot: "bg-muted-foreground/20",
      badge: "bg-muted/40 text-muted-foreground/50",
      label: "Disabled",
    },
    failed: {
      dot: "bg-red-500",
      badge: "bg-red-500/10 text-red-600 dark:text-red-400",
      label: "Failed",
    },
    starting: {
      dot: "bg-amber-500",
      badge: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
      label: "Starting",
    },
  };

  const s = map[status] ?? map.stopped;

  return (
    <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-semibold ${s.badge}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${s.dot}`} />
      {s.label}
    </span>
  );
}

function InfoRow({
  icon: Icon,
  label,
  value,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: string;
}) {
  return (
    <div className="flex items-center gap-2.5">
      <Icon className="size-3.5 text-muted-foreground shrink-0" />
      <span className="text-[12px] text-muted-foreground shrink-0">{label}</span>
      <span className="text-[12px] font-medium text-foreground truncate">{value}</span>
    </div>
  );
}
