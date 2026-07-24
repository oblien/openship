"use client";

import React, { useEffect, useState, useCallback, useMemo } from "react";
import { useProjectSettings } from "@/context/ProjectSettingsContext";
import { usePlatform } from "@/context/PlatformContext";
import { serviceKind, serviceCanStartWithoutBuild, servicesApi, sortServicesByPublicFirst, type Service, type ServiceContainer, type ServiceInput } from "@/lib/api/services";
import { getApiErrorMessage } from "@/lib/api/client";
import { useToast } from "@/context/ToastContext";
import { resolveServiceHostnameLabel, internalServiceAddress } from "@repo/core";
import { useRouter } from "next/navigation";
import { useI18n, interpolate } from "@/components/i18n-provider";
import type { Dictionary } from "@/i18n";
import {
  Layers,
  RefreshCw,
  Globe,
  Container,
  AlertCircle,
  AlertTriangle,
  ChevronRight,
  ArrowLeft,
  Plus,
} from "lucide-react";

import { ServiceDetailPanel } from "./services/ServiceDetailPanel";
import { AddServiceModal } from "./services/AddServiceModal";

/** Render a drift diff value (arrays → csv, objects → keys, scalars → string). */
const fmtDriftVal = (v: unknown): string => {
  if (v == null) return "—";
  if (Array.isArray(v)) return v.length ? v.join(", ") : "—";
  if (typeof v === "object") {
    const keys = Object.keys(v as Record<string, unknown>);
    return keys.length ? keys.join(", ") : "—";
  }
  return String(v) || "—";
};

/* ── Main Component ─────────────────────────────────────────────────── */

export const ServicesTab = () => {
  const { id, slug, projectData, servicesData, refreshServices } = useProjectSettings();
  const { baseDomain } = usePlatform();
  const { showToast } = useToast();
  const { t } = useI18n();
  const router = useRouter();

  const [containers, setContainers] = useState<ServiceContainer[]>([]);
  const [containersLoading, setContainersLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [driftBusy, setDriftBusy] = useState<string | null>(null);

  // Public (exposed) services lead the list — the ones users actually browse to.
  const services = useMemo(
    () => sortServicesByPublicFirst(servicesData.services),
    [servicesData.services],
  );
  const loading = servicesData.isLoading || containersLoading;
  const projectSlugBase = projectData.slug || projectData.name || "project";
  const selectedId = slug?.[1] ?? null;
  const hasProjectId = Boolean(id && id !== "undefined");

  const fetchData = useCallback(async () => {
    if (!hasProjectId) {
      setContainers([]);
      setContainersLoading(false);
      return;
    }

    try {
      setContainersLoading(true);
      setError(null);
      const [, ctRes] = await Promise.all([refreshServices(), servicesApi.containers(id)]);
      if (ctRes.success) setContainers(ctRes.containers ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : t.projects.services.failedLoad);
    } finally {
      setContainersLoading(false);
    }
  }, [hasProjectId, id, refreshServices]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const containerFor = (serviceId: string) => containers.find((c) => c.serviceId === serviceId);

  const selectedService = services.find((s) => s.id === selectedId);

  const resolveServiceUrl = (service: Service) => {
    if (!service.exposed) return null;
    if (service.domainType === "custom" && service.customDomain) {
      return `https://${service.customDomain}`;
    }
    const subdomain = resolveServiceHostnameLabel(
      projectSlugBase,
      service.name,
      service.domain,
      serviceKind(service),
    );
    return `https://${subdomain}.${baseDomain}`;
  };

  const openService = (serviceId: string) => {
    if (!hasProjectId) return;
    router.push(`/projects/${id}/services/${serviceId}`);
  };

  const closeService = () => {
    if (!hasProjectId) return;
    router.push(`/projects/${id}/services`);
  };

  const handleCreateService = async (data: ServiceInput) => {
    if (!hasProjectId) return;

    const result = await servicesApi.create(id, data);
    if (!result.success) {
      throw new Error(t.projects.services.failedCreateService);
    }

    await fetchData();

    const newServiceId = result.service?.id;
    if (!newServiceId) return;

    // Auto-launch only once there's an active deployment to attach to — the
    // backend provision REQUIRES it (throws "Deploy the project first" without
    // one), on cloud too. A source-built service can't launch via the decoupled
    // Start path (it only builds through Redeploy), so never auto-fire for one.
    const shouldLaunch =
      Boolean(projectData?.activeDeploymentId) && serviceCanStartWithoutBuild(data);

    if (!shouldLaunch) {
      // Nothing to launch against yet — keep the row and land on its detail so
      // the user can deploy/start it when ready.
      showToast(interpolate(t.projects.services.toastSavedDeploy, { name: data.name }), "success", t.projects.services.toastServiceTitle);
      router.push(`/projects/${id}/services/${newServiceId}`);
      return;
    }

    // Add = launch, via the DECOUPLED per-service path (servicesApi.start →
    // provision this one container/workspace; NO project redeploy/build/lock,
    // never touches the main app). If provisioning FAILS, roll the service back
    // (delete the row) and show the REAL error — never leave a broken,
    // half-added service behind. Only land on the detail page once it's up.
    showToast(interpolate(t.projects.services.toastAddedDeploying, { name: data.name }), "success", t.projects.services.toastServiceTitle);
    const rollback = async (message: string) => {
      await servicesApi.delete(id, newServiceId).catch(() => {});
      await fetchData();
      showToast(message, "error", data.name);
    };
    servicesApi
      .start(id, newServiceId)
      .then(async (res: any) => {
        if (res?.success === false) {
          await rollback(res?.error || t.projects.services.toastDeployFailed);
          return;
        }
        showToast(interpolate(t.projects.services.toastStarting, { name: data.name }), "success", t.projects.services.toastServiceTitle);
        await fetchData();
        router.push(`/projects/${id}/services/${newServiceId}`);
      })
      .catch(async (err) => {
        await rollback(getApiErrorMessage(err, t.projects.services.toastDeployFailed));
      });
  };

  const resolveDrift = useCallback(
    async (serviceId: string, action: "accept" | "keep", name: string) => {
      if (!hasProjectId) return;
      setDriftBusy(serviceId);
      try {
        const res =
          action === "accept"
            ? await servicesApi.acceptDrift(id, serviceId)
            : await servicesApi.keepDrift(id, serviceId);
        if (res.success === false) throw new Error(t.projects.services.requestFailed);
        showToast(
          action === "accept"
            ? interpolate(t.projects.services.toastAppliedRepo, { name })
            : interpolate(t.projects.services.toastKeptEdits, { name }),
          "success",
          t.projects.services.toastServiceTitle,
        );
        await fetchData();
      } catch (e) {
        showToast(e instanceof Error ? e.message : t.projects.services.failedResolveDrift, "error", name);
      } finally {
        setDriftBusy(null);
      }
    },
    [hasProjectId, id, showToast, fetchData, t],
  );

  const driftedServices = services.filter((s) => s.drift && s.drift.changes.length > 0);

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
  if (error || servicesData.error) {
    return (
      <div className="bg-card rounded-2xl border border-border/50 p-8 text-center">
        <AlertCircle className="size-8 text-danger mx-auto mb-3" />
        <p className="text-sm font-medium text-foreground mb-1">{t.projects.services.failedLoad}</p>
        <p className="text-xs text-muted-foreground mb-4">{error || servicesData.error}</p>
        <button
          onClick={fetchData}
          className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-[13px] font-medium bg-foreground/[0.06] text-foreground hover:bg-foreground/[0.1] transition-colors"
        >
          <RefreshCw className="size-3.5" />
          {t.projects.services.retry}
        </button>
      </div>
    );
  }

  /* ── Empty state ───────────────────────────────────────────────── */
  if (services.length === 0) {
    return (
      <>
        <div className="bg-card rounded-2xl border border-border/50 px-6 pb-10 text-center">
          {/* SVG illustration - central app card linked to three service
              nodes (database, cache, queue). Uses the same `th-*` token
              palette as the deployments empty state so the visual language
              stays consistent across the app. */}
          <div className="relative mx-auto w-72 h-44">
            <svg className="absolute inset-0 w-full h-full" viewBox="0 0 288 180" fill="none">
              {/* Decorative dots scattered behind */}
              <circle cx="22" cy="46" r="4" fill="var(--th-on-10)" />
              <circle cx="42" cy="138" r="6" fill="var(--th-on-08)" />
              <circle cx="262" cy="38" r="3" fill="var(--th-on-12)" />
              <circle cx="270" cy="128" r="5" fill="var(--th-on-06)" />
              <path d="M16 110l2-4 2 4-4-2 4 0-4 2z" fill="var(--th-on-16)" />
              <path d="M256 154l1.5-3 1.5 3-3-1.5 3 0-3 1.5z" fill="var(--th-on-12)" />

              {/* Dashed connector lines from app card to each service */}
              <path
                d="M144 78 Q 90 70 60 76"
                stroke="var(--th-on-12)"
                strokeWidth="1.5"
                strokeDasharray="3 3"
                fill="none"
              />
              <path
                d="M144 92 Q 144 130 144 138"
                stroke="var(--th-on-12)"
                strokeWidth="1.5"
                strokeDasharray="3 3"
                fill="none"
              />
              <path
                d="M156 78 Q 200 70 228 76"
                stroke="var(--th-on-12)"
                strokeWidth="1.5"
                strokeDasharray="3 3"
                fill="none"
              />

              {/* Central "app" card */}
              <rect
                x="112"
                y="56"
                width="64"
                height="48"
                rx="10"
                fill="var(--th-card-bg)"
                stroke="var(--th-bd-default)"
                strokeWidth="1"
              />
              <rect x="112" y="56" width="64" height="14" rx="10" fill="var(--th-sf-05)" />
              <circle cx="122" cy="63" r="2" fill="#ef4444" fillOpacity="0.6" />
              <circle cx="130" cy="63" r="2" fill="#eab308" fillOpacity="0.6" />
              <circle cx="138" cy="63" r="2" fill="#22c55e" fillOpacity="0.6" />
              <rect x="120" y="78" width="32" height="3" rx="1.5" fill="var(--th-on-12)" />
              <rect x="120" y="85" width="48" height="2.5" rx="1.25" fill="var(--th-on-08)" />
              <rect x="120" y="91" width="40" height="2.5" rx="1.25" fill="var(--th-on-08)" />

              {/* Service node: Database (left) - stacked cylinders */}
              <g transform="translate(34, 50)">
                <ellipse cx="26" cy="6" rx="20" ry="5" fill="var(--th-sf-04)" stroke="var(--th-bd-subtle)" strokeWidth="1" />
                <path d="M6 6 L6 22 Q 6 27 26 27 Q 46 27 46 22 L 46 6" fill="var(--th-sf-03)" stroke="var(--th-bd-subtle)" strokeWidth="1" />
                <ellipse cx="26" cy="6" rx="20" ry="5" fill="var(--th-card-bg)" stroke="var(--th-bd-default)" strokeWidth="1" />
                <ellipse cx="26" cy="22" rx="20" ry="5" fill="var(--th-card-bg)" stroke="var(--th-bd-default)" strokeWidth="1" />
                <line x1="6" y1="6" x2="6" y2="22" stroke="var(--th-bd-default)" strokeWidth="1" />
                <line x1="46" y1="6" x2="46" y2="22" stroke="var(--th-bd-default)" strokeWidth="1" />
              </g>

              {/* Service node: Cache (bottom) - lightning bolt in chip */}
              <g transform="translate(124, 124)">
                <rect width="40" height="32" rx="8" fill="var(--th-card-bg)" stroke="var(--th-bd-default)" strokeWidth="1" />
                <path
                  d="M22 8 L 14 18 L 19 18 L 17 24 L 25 14 L 20 14 L 22 8 Z"
                  fill="var(--th-on-30)"
                  stroke="var(--th-on-40)"
                  strokeWidth="0.5"
                />
              </g>

              {/* Service node: Queue/Container (right) - stacked rounded rects */}
              <g transform="translate(202, 50)">
                <rect x="6" y="14" width="40" height="18" rx="4" fill="var(--th-sf-04)" stroke="var(--th-bd-subtle)" strokeWidth="1" />
                <rect x="3" y="7" width="40" height="18" rx="4" fill="var(--th-sf-03)" stroke="var(--th-bd-subtle)" strokeWidth="1" />
                <rect x="0" y="0" width="40" height="18" rx="4" fill="var(--th-card-bg)" stroke="var(--th-bd-default)" strokeWidth="1" />
                <circle cx="6" cy="9" r="1.5" fill="var(--th-on-30)" />
                <rect x="12" y="7.5" width="22" height="3" rx="1.5" fill="var(--th-on-12)" />
                <rect x="12" y="12.5" width="14" height="2.5" rx="1.25" fill="var(--th-on-08)" />
              </g>
            </svg>
          </div>

          <h3 className="text-lg font-medium text-foreground/80 mb-2">
            {t.projects.services.emptyTitle}
          </h3>
          <p className="text-sm text-muted-foreground max-w-sm mx-auto mb-8 leading-relaxed">
            {t.projects.services.emptyDescription}
          </p>

          <div className="flex flex-col sm:flex-row items-center justify-center gap-3">
            <button
              onClick={() => setCreateOpen(true)}
              className="inline-flex items-center gap-2 px-6 py-3 bg-primary text-primary-foreground text-sm font-medium rounded-xl hover:bg-primary/90 transition-all hover:shadow-lg hover:shadow-primary/25 hover:-translate-y-0.5"
            >
              <Plus className="size-4" />
              {t.projects.services.addService}
            </button>
            <button
              onClick={fetchData}
              className="inline-flex items-center gap-2 px-6 py-3 bg-muted/50 text-foreground text-sm font-medium rounded-xl hover:bg-muted transition-colors"
            >
              <RefreshCw className="size-4" />
              {t.projects.services.refresh}
            </button>
          </div>
        </div>
        <AddServiceModal
          open={createOpen}
          projectName={projectSlugBase}
          isCloudProject={projectData?.deployTarget === "cloud"}
          onClose={() => setCreateOpen(false)}
          onSubmit={handleCreateService}
        />
      </>
    );
  }

  /* ── Service list + detail panel ───────────────────────────────── */
  if (selectedService) {
    return (
      <div className="space-y-4">
        {/* Slim breadcrumb row — the panel's hero is the single heading. */}
        <div className="flex items-center justify-between gap-4">
          <button
            onClick={closeService}
            className="inline-flex items-center gap-2 px-3 py-2 rounded-xl text-[13px] font-medium bg-foreground/[0.06] text-foreground hover:bg-foreground/[0.1] transition-colors"
          >
            <ArrowLeft className="size-3.5 rtl:rotate-180" />
            {t.projects.services.allServices}
          </button>
          <button
            onClick={fetchData}
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl text-[13px] font-medium bg-foreground/[0.06] text-foreground hover:bg-foreground/[0.1] transition-colors"
          >
            <RefreshCw className="size-3.5" />
            {t.projects.services.refresh}
          </button>
        </div>

        <ServiceDetailPanel
          // Key by service id so switching services (via the header switcher)
          // remounts on the tab carried in the URL, with per-service state fresh.
          key={selectedService.id}
          service={selectedService}
          container={containerFor(selectedService.id)}
          projectId={id}
          projectSlugBase={projectSlugBase}
          initialTab={slug?.[2]}
          onRefresh={fetchData}
          onDeleted={closeService}
          projectType={(projectData as { projectType?: string })?.projectType}
          activeDeploymentId={projectData?.activeDeploymentId}
          deployTarget={projectData?.deployTarget}
          siblingServices={servicesData.services}
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
                {interpolate(
                  services.length === 1 ? t.projects.services.countOne : t.projects.services.countOther,
                  { count: String(services.length) },
                )}
              </h3>
              <p className="text-xs text-muted-foreground mt-0.5">
                {t.projects.services.chooseService}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={fetchData}
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl text-[13px] font-medium bg-foreground/[0.06] text-foreground hover:bg-foreground/[0.1] transition-colors"
            >
              <RefreshCw className="size-3.5" />
              {t.projects.services.refresh}
            </button>
            <button
              onClick={() => setCreateOpen(true)}
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl text-[13px] font-medium bg-primary text-primary-foreground hover:bg-primary/90 transition-colors"
            >
              <Plus className="size-3.5" />
              {t.projects.services.addService}
            </button>
          </div>
        </div>
      </div>

      {/* Upstream compose drift — edited services whose repo values changed */}
      {driftedServices.length > 0 && (
        <div className="rounded-2xl border border-warning-border bg-warning-bg p-5">
          <div className="flex items-center gap-2.5">
            <AlertTriangle className="size-4 text-warning" />
            <h4 className="text-sm font-semibold text-foreground">
              {interpolate(
                driftedServices.length === 1
                  ? t.projects.services.driftCountOne
                  : t.projects.services.driftCountOther,
                { count: String(driftedServices.length) },
              )}
            </h4>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            {t.projects.services.driftDescription}
          </p>
          <div className="mt-4 space-y-3">
            {driftedServices.map((svc) => (
              <div key={svc.id} className="rounded-xl border border-border/50 bg-card p-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <span className="text-sm font-semibold text-foreground">{svc.name}</span>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      disabled={driftBusy === svc.id}
                      onClick={() => resolveDrift(svc.id, "keep", svc.name)}
                      className="rounded-lg border border-border/60 px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-muted/60 disabled:opacity-50"
                    >
                      {t.projects.services.keepMine}
                    </button>
                    <button
                      type="button"
                      disabled={driftBusy === svc.id}
                      onClick={() => resolveDrift(svc.id, "accept", svc.name)}
                      className="rounded-lg bg-warning-solid px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-warning-solid/90 disabled:opacity-50"
                    >
                      {t.projects.services.acceptUpstream}
                    </button>
                  </div>
                </div>
                <div className="mt-3 space-y-1.5">
                  {svc.drift!.changes.map((ch) => (
                    <div key={ch.field} className="flex items-start gap-2 text-xs">
                      <span className="mt-0.5 w-24 shrink-0 font-mono text-muted-foreground">
                        {ch.field}
                      </span>
                      <span className="min-w-0 flex-1 font-mono">
                        <span className="text-danger/80 line-through">
                          {fmtDriftVal(ch.from)}
                        </span>
                        <span className="mx-1.5 text-muted-foreground">→</span>
                        <span className="text-success">
                          {fmtDriftVal(ch.to)}
                        </span>
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="bg-card rounded-2xl border border-border/50 divide-y divide-border/30 overflow-hidden">
        {services.map((svc) => {
          const ct = containerFor(svc.id);
          const status = ct?.status ?? (svc.enabled ? "stopped" : "disabled");
          const resolvedUrl = resolveServiceUrl(svc);
          const isMonorepo = serviceKind(svc) === "monorepo";

          // Monorepo sub-app subtitle assembled from the metadata each
          // row already carries: rootDirectory (apps/dashboard) · framework
          // (Next.js) · port (3202) → resolved URL (example.opsh.io).
          // Each segment is shown only if present - keeps the line short
          // for sub-apps that haven't been fully filled in yet.
          const monorepoBits: string[] = [];
          if (svc.rootDirectory) monorepoBits.push(svc.rootDirectory);
          if (svc.framework) monorepoBits.push(svc.framework);
          if (svc.exposedPort) monorepoBits.push(interpolate(t.projects.services.port, { port: String(svc.exposedPort) }));
          const subtitle = isMonorepo
            ? monorepoBits.join(" · ")
            : svc.image || svc.build || "";
          const urlHost = resolvedUrl?.replace("https://", "");

          // Published host port (first `host:container` mapping) — what the
          // service is reachable on off-box; falls back to the managed-route
          // target port. Surfaced as a chip so port-only services (e.g. Kong on
          // 8000) show WHERE they listen even without a domain.
          const hostPort =
            ((svc.ports as string[] | null) ?? [])
              .map((p) => {
                const parts = String(p).split(":");
                return parts.length >= 2 ? Number(parts[parts.length - 2]) : NaN;
              })
              .find((n) => Number.isFinite(n)) ??
            (svc.exposedPort ? Number(svc.exposedPort) : undefined);

          return (
            <button
              key={svc.id}
              onClick={() => openService(svc.id)}
              className="w-full flex items-center gap-4 px-5 py-4 text-start transition-colors hover:bg-foreground/[0.025]"
            >
              <div className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0 bg-muted/50">
                <Container className="size-[18px] text-muted-foreground" />
              </div>

              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-[14px] font-semibold text-foreground truncate">
                    {svc.name}
                  </span>
                  <span
                    className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase tracking-[0.12em] ${svc.exposed ? "bg-success-bg text-success" : "bg-muted/60 text-muted-foreground/70"}`}
                  >
                    <Globe className="size-2.5" />
                    {svc.exposed ? t.projects.services.public : t.projects.services.internal}
                  </span>
                  {hostPort !== undefined && Number.isFinite(hostPort) && (
                    <span className="inline-flex items-center rounded-full bg-muted/60 px-2 py-0.5 font-mono text-[10px] font-semibold text-muted-foreground/70">
                      :{hostPort}
                    </span>
                  )}
                  {svc.drift && svc.drift.changes.length > 0 && (
                    <span className="inline-flex items-center gap-1 rounded-full bg-warning-bg px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-warning">
                      <AlertTriangle className="size-2.5" />
                      {t.projects.services.upstreamChange}
                    </span>
                  )}
                </div>
                <p className="text-[12px] text-muted-foreground truncate mt-1">
                  {isMonorepo ? (
                    // Monorepo: "apps/dashboard · Next.js · port 3202 → my-app.opsh.io"
                    <>
                      {subtitle}
                      {urlHost && (
                        <>
                          {subtitle && " → "}
                          <span className="text-foreground/80">{urlHost}</span>
                        </>
                      )}
                      {!subtitle && !urlHost && "-"}
                    </>
                  ) : svc.exposed && urlHost ? (
                    // Exposed compose service — its public URL.
                    urlHost
                  ) : ct?.ip ? (
                    // Internal service that's running — its real internal IP on
                    // the openship network (what the user actually wants to see).
                    <span className="font-mono">{ct.ip}</span>
                  ) : (
                    // Not running yet — fall back to the stable address SIBLINGS
                    // use to reach it (service-name:port).
                    <span className="font-mono">
                      {internalServiceAddress(svc.name, svc.ports as string[])}
                    </span>
                  )}
                </p>
              </div>

              <div className="flex items-center gap-3 shrink-0">
                <StatusBadge status={status} t={t} />
                <ChevronRight className="size-4 text-muted-foreground/50 rtl:rotate-180" />
              </div>
            </button>
          );
        })}
      </div>

      <AddServiceModal
        open={createOpen}
        projectName={projectSlugBase}
        isCloudProject={projectData?.deployTarget === "cloud"}
        onClose={() => setCreateOpen(false)}
        onSubmit={handleCreateService}
      />
    </div>
  );
};

/* ── Status Badge ───────────────────────────────────────────────────── */

function StatusBadge({ status, t }: { status: string; t: Dictionary }) {
  const map: Record<string, { dot: string; badge: string; label: string }> = {
    running: {
      dot: "bg-success-solid",
      badge: "bg-success-bg text-success",
      label: t.projects.serviceStatus.running,
    },
    stopped: {
      dot: "bg-muted-foreground/30",
      badge: "bg-muted/60 text-muted-foreground/70",
      label: t.projects.serviceStatus.stopped,
    },
    disabled: {
      dot: "bg-muted-foreground/20",
      badge: "bg-muted/40 text-muted-foreground/50",
      label: t.projects.serviceStatus.disabled,
    },
    failed: {
      dot: "bg-danger-solid",
      badge: "bg-danger-bg text-danger",
      label: t.projects.serviceStatus.failed,
    },
    starting: {
      dot: "bg-warning-solid",
      badge: "bg-warning-bg text-warning",
      label: t.projects.serviceStatus.starting,
    },
  };
  const s = map[status] ?? map.stopped;
  return (
    <span
      className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] font-semibold ${s.badge}`}
    >
      <span className={`w-1.5 h-1.5 rounded-full ${s.dot}`} />
      {s.label}
    </span>
  );
}
