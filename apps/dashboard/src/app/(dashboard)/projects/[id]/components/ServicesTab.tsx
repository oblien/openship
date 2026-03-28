"use client";

import React, { useEffect, useState, useCallback } from "react";
import { useProjectSettings } from "@/context/ProjectSettingsContext";
import { usePlatform } from "@/context/PlatformContext";
import { servicesApi, type Service, type ServiceContainer } from "@/lib/api/services";
import { resolveServiceHostnameLabel } from "@repo/core";
import { useRouter } from "next/navigation";
import {
  Layers,
  RefreshCw,
  Globe,
  Container,
  AlertCircle,
  Loader2,
  ChevronRight,
  ArrowLeft,
} from "lucide-react";
import { ServiceDetailPanel } from "./services/ServiceDetailPanel";

/* ── Main Component ─────────────────────────────────────────────────── */

export const ServicesTab = () => {
  const { id, slug, projectData } = useProjectSettings();
  const { baseDomain } = usePlatform();
  const router = useRouter();

  const [services, setServices] = useState<Service[]>([]);
  const [containers, setContainers] = useState<ServiceContainer[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);

  const projectSlugBase = projectData.slug || projectData.name || "project";
  const selectedId = slug?.[1] ?? null;

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
      if (res.success) setServices(res.services ?? []);
    } finally {
      setSyncing(false);
    }
  };

  const containerFor = (serviceId: string) =>
    containers.find((c) => c.serviceId === serviceId);

  const selectedService = services.find((s) => s.id === selectedId);

  const resolveServiceUrl = (service: Service) => {
    if (!service.exposed) return null;
    if (service.domainType === "custom" && service.customDomain) {
      return `https://${service.customDomain}`;
    }
    const subdomain = resolveServiceHostnameLabel(projectSlugBase, service.name, service.domain);
    return `https://${subdomain}.${baseDomain}`;
  };

  const openService = (serviceId: string) => {
    router.push(`/projects/${id}/services/${serviceId}`);
  };

  const closeService = () => {
    router.push(`/projects/${id}/services`);
  };

  /* ── Loading state ─────────────────────────────────────────────── */
  if (loading) {
    return (
      <div className="space-y-3">
        {[1, 2, 3].map((i) => (
          <div key={i} className="bg-card rounded-2xl border border-border/50 p-4 animate-pulse">
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
        <button onClick={fetchData} className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-[13px] font-medium bg-foreground/[0.06] text-foreground hover:bg-foreground/[0.1] transition-colors">
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
        <button onClick={handleSync} disabled={syncing} className="inline-flex items-center gap-1.5 px-4 py-2.5 rounded-xl text-[13px] font-medium bg-primary text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50">
          {syncing ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
          Sync from Compose
        </button>
      </div>
    );
  }

  /* ── Service list + detail panel ───────────────────────────────── */
  if (selectedService) {
    return (
      <div className="space-y-5">
        <div className="bg-card rounded-2xl border border-border/50 p-5">
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-3 min-w-0">
              <button
                onClick={closeService}
                className="inline-flex items-center gap-2 px-3 py-2 rounded-xl text-[13px] font-medium bg-foreground/[0.06] text-foreground hover:bg-foreground/[0.1] transition-colors shrink-0"
              >
                <ArrowLeft className="size-3.5" />
                All services
              </button>
              <div className="min-w-0">
                <h3 className="text-sm font-semibold text-foreground truncate">
                  {selectedService.name}
                </h3>
                <p className="text-xs text-muted-foreground mt-0.5 truncate">
                  Service settings, routing, ports, logs, and container controls.
                </p>
              </div>
            </div>

            <button
              onClick={fetchData}
              disabled={syncing}
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl text-[13px] font-medium bg-foreground/[0.06] text-foreground hover:bg-foreground/[0.1] transition-colors disabled:opacity-50 shrink-0"
            >
              {syncing ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
              Refresh
            </button>
          </div>
        </div>

        <ServiceDetailPanel
          service={selectedService}
          container={containerFor(selectedService.id)}
          projectId={id}
          projectSlugBase={projectSlugBase}
          onClose={closeService}
          onRefresh={fetchData}
        />
      </div>
    );
  }

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
                Choose a service to open its full settings screen.
              </p>
            </div>
          </div>
          <button onClick={handleSync} disabled={syncing} className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl text-[13px] font-medium bg-foreground/[0.06] text-foreground hover:bg-foreground/[0.1] transition-colors disabled:opacity-50">
            {syncing ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
            Sync
          </button>
        </div>
      </div>

      <div className="bg-card rounded-2xl border border-border/50 divide-y divide-border/30 overflow-hidden">
        {services.map((svc) => {
          const ct = containerFor(svc.id);
          const status = ct?.status ?? (svc.enabled ? "stopped" : "disabled");
          const resolvedUrl = resolveServiceUrl(svc);

          return (
            <button
              key={svc.id}
              onClick={() => openService(svc.id)}
              className="w-full flex items-center gap-4 px-5 py-4 text-left transition-colors hover:bg-foreground/[0.025]"
            >
              <div className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0 bg-muted/50">
                <Container className="size-[18px] text-muted-foreground" />
              </div>

              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-[14px] font-semibold text-foreground truncate">{svc.name}</span>
                  <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase tracking-[0.12em] ${svc.exposed ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400" : "bg-muted/60 text-muted-foreground/70"}`}>
                    <Globe className="size-2.5" />
                    {svc.exposed ? "Connected" : "Not Connected"}
                  </span>
                </div>
                <p className="text-[12px] text-muted-foreground truncate mt-1">
                  {resolvedUrl?.replace("https://", "") ?? (svc.image || svc.build || "—")}
                </p>
              </div>

              <div className="flex items-center gap-3 shrink-0">
                <button
                  onClick={(event) => {
                    event.stopPropagation();
                    router.push(`/projects/${id}/domains?service=${svc.id}`);
                  }}
                  className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl text-[12px] font-medium bg-primary/10 text-primary hover:bg-primary/15 transition-colors"
                >
                  Edit
                </button>
                <StatusBadge status={status} />
                <ChevronRight className="size-4 text-muted-foreground/50" />
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
};

/* ── Status Badge ───────────────────────────────────────────────────── */

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
    <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] font-semibold ${s.badge}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${s.dot}`} />
      {s.label}
    </span>
  );
}
