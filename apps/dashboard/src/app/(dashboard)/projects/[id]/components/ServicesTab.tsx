"use client";

import { Icon as UiIcon } from "@repo/ui/icons";

import React, { useEffect, useState, useCallback, useMemo, useRef } from "react";
import Link from "next/link";
import { useProjectSettings } from "@/context/ProjectSettingsContext";
import { usePlatform } from "@/context/PlatformContext";
import { serviceKind, serviceCanStartWithoutBuild, servicesApi, sortServicesByPublicFirst, type Service, type ServiceContainer, type ServiceInput } from "@/lib/api/services";
import { getServiceStatus } from "@/components/services/ServiceStatusBadge";
import { Button } from "@/components/ui/button";
import { getApiErrorMessage, isAbortError } from "@/lib/api/client";
import { useToast } from "@/context/ToastContext";
import { serviceDisplayUrl } from "@/utils/route-display";
import { useRouter } from "next/navigation";
import { useI18n, interpolate } from "@/components/i18n-provider";

import { ServiceDetailPanel } from "./services/ServiceDetailPanel";
import { AddServiceModal } from "./services/AddServiceModal";
import { LinkedAppsCard } from "./services/LinkedAppsCard";
import { ServiceListItem } from "./services/ServiceListItem";
import { ResourceSettings } from "./ResourceSettings";

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

  const [runtime, setRuntime] = useState<{
    projectId: string;
    containers: ServiceContainer[] | null;
    loading: boolean;
    error: string | null;
  }>({ projectId: id, containers: null, loading: true, error: null });
  const runtimeRequest = useRef(0);
  const currentRuntime = runtime.projectId === id ? runtime : null;
  const containers = currentRuntime?.containers ?? null;
  const containersLoading = currentRuntime?.loading ?? true;
  const error = currentRuntime?.error ?? null;
  const [createOpen, setCreateOpen] = useState(false);
  const [driftBusy, setDriftBusy] = useState<string | null>(null);

  // Public (exposed) services lead the list — the ones users actually browse to.
  const services = useMemo(
    () => sortServicesByPublicFirst(servicesData.services),
    [servicesData.services],
  );
  // Skeleton only when there is nothing to show. containersLoading flips on
  // every refetch (and every remount of this tab), so OR-ing it raw flashed
  // the full-tab skeleton on every action and tab switch (#666) — rows render
  // fine while their runtime status is checked separately.
  const loading =
    servicesData.isLoading || (containersLoading && services.length === 0);
  const projectSlugBase = projectData.slug || projectData.name || "project";
  const selectedId = slug?.[1] ?? null;
  const hasProjectId = Boolean(id && id !== "undefined");

  const fetchData = useCallback(async () => {
    const request = ++runtimeRequest.current;
    if (!hasProjectId) {
      setRuntime({ projectId: id, containers: null, loading: false, error: null });
      return;
    }

    setRuntime((previous) => ({
      projectId: id,
      containers: previous.projectId === id ? previous.containers : null,
      loading: true,
      error: null,
    }));
    try {
      // allSettled, not all: with `all`, a rejection from the SECOND promise once
      // the first has already rejected is orphaned, and an unhandled rejection
      // surfaces as a bare runtime error overlay instead of this component's
      // error state. The container read is also the one that can time out
      // (it reflects live runtime state), so it must not take the tab down.
      const [, containersResult] = await Promise.allSettled([
        refreshServices(),
        servicesApi.containers(id),
      ]);
      if (request !== runtimeRequest.current) return;
      if (containersResult.status === "rejected") throw containersResult.reason;
      const ctRes = containersResult.value;
      if (!ctRes.success) throw new Error(t.projects.services.failedLoad);
      setRuntime({
        projectId: id,
        containers: ctRes.containers ?? [],
        loading: false,
        error: null,
      });
    } catch (e) {
      if (request !== runtimeRequest.current) return;
      // An aborted request's message is "signal is aborted without reason" —
      // useless to a user, so fall back to the generic copy for it.
      setRuntime({
        projectId: id,
        containers: null,
        loading: false,
        error: !isAbortError(e) && e instanceof Error ? e.message : t.projects.services.failedLoad,
      });
    }
  }, [hasProjectId, id, refreshServices, t.projects.services.failedLoad]);

  useEffect(() => {
    void fetchData();
    return () => {
      runtimeRequest.current += 1;
    };
  }, [fetchData]);

  const containerFor = (serviceId: string) => containers?.find((c) => c.serviceId === serviceId);

  const selectedService = services.find((s) => s.id === selectedId);

  // Null for a service with no route — it is reachable on its port, and linking
  // to a derived `<project>-<service>` host sent people to a name nobody created.
  const resolveServiceUrl = (service: Service) =>
    serviceDisplayUrl(service, {
      projectLabel: projectSlugBase,
      baseDomain,
      kind: serviceKind(service),
    });

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

    // Start just this service. Cloud Compose reuses its project workspace;
    // native Cloud services get independent workspaces. Keep the saved service
    // on failure: a lost response may mean the provider already started it.
    showToast(interpolate(t.projects.services.toastAddedDeploying, { name: data.name }), "success", t.projects.services.toastServiceTitle);
    const showStartFailure = async (message: string) => {
      await fetchData();
      showToast(message, "error", data.name);
      router.push(`/projects/${id}/services/${newServiceId}`);
    };
    servicesApi
      .start(id, newServiceId)
      .then(async (res: any) => {
        if (res?.success === false) {
          await showStartFailure(res?.error || t.projects.services.toastDeployFailed);
          return;
        }
        showToast(interpolate(t.projects.services.toastStarting, { name: data.name }), "success", t.projects.services.toastServiceTitle);
        await fetchData();
        router.push(`/projects/${id}/services/${newServiceId}`);
      })
      .catch(async (err) => {
        await showStartFailure(getApiErrorMessage(err, t.projects.services.toastDeployFailed));
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
      <div className="space-y-5 animate-pulse" aria-busy="true">
        <div className="flex h-8 items-center justify-between gap-4" aria-hidden="true">
          <div className="h-4 w-32 rounded bg-muted" />
          <div className="h-8 w-24 rounded-lg bg-muted" />
        </div>
        <div className="overflow-hidden rounded-2xl border border-border/50 bg-card divide-y divide-border/40" aria-hidden="true">
          {[1, 2, 3].map((i) => (
            <div key={i} className="flex items-center gap-3 px-4 py-3.5">
              <div className="size-10 shrink-0 rounded-xl bg-muted" />
              <div className="min-w-0 flex-1 space-y-2">
                <div className="h-4 w-32 max-w-full rounded bg-muted" />
                <div className="h-3 w-48 max-w-full rounded bg-muted/60" />
              </div>
              <div className="h-3 w-14 shrink-0 rounded bg-muted/60" />
            </div>
          ))}
        </div>
      </div>
    );
  }

  /* ── Error state ───────────────────────────────────────────────── */
  // Full-tab error only when there is nothing to show. A failed refetch with
  // rows on screen keeps them and reports the failure inline — blanking a
  // working list on a transient 5xx was the same complaint as the skeleton
  // flash (#666).
  const failure = error || servicesData.error;
  if (failure && services.length === 0) {
    return (
      <div className="bg-card rounded-2xl border border-border/50 p-8 text-center">
        <UiIcon name="alert-circle" className="size-8 text-danger mx-auto mb-3" />
        <p className="text-sm font-medium text-foreground mb-1">{t.projects.services.failedLoad}</p>
        <p className="text-xs text-muted-foreground mb-4">{error || servicesData.error}</p>
        <button
          onClick={fetchData}
          className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-[13px] font-medium bg-foreground/[0.06] text-foreground hover:bg-foreground/[0.1] transition-colors"
        >
          <UiIcon name="refresh" className="size-3.5" />
          {t.projects.services.retry}
        </button>
      </div>
    );
  }

  /* ── Empty state ───────────────────────────────────────────────── */
  if (services.length === 0) {
    return (
      <div className="space-y-5">
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
              <UiIcon name="plus" className="size-4" />
              {t.projects.services.addService}
            </button>
            <button
              onClick={fetchData}
              className="inline-flex items-center gap-2 px-6 py-3 bg-muted/50 text-foreground text-sm font-medium rounded-xl hover:bg-muted transition-colors"
            >
              <UiIcon name="refresh" className="size-4" />
              {t.projects.services.refresh}
            </button>
          </div>
        </div>
        {/* A project can have a linked app before it has any service of its own
            (wired at creation, not deployed yet) — don't hide the link behind
            the empty state. */}
        {hasProjectId && <LinkedAppsCard projectId={id} />}
        <AddServiceModal
          projectId={id}
          open={createOpen}
          projectName={projectSlugBase}
          isCloudProject={projectData?.deployTarget === "cloud"}
          onClose={() => setCreateOpen(false)}
          onSubmit={handleCreateService}
        />
      </div>
    );
  }

  const errorNotice = failure && (
    <div className="flex items-center gap-2 rounded-xl border border-danger/30 bg-danger/[0.06] px-3 py-2 text-xs text-danger">
      <UiIcon name="alert-circle" className="size-3.5 shrink-0" />
      <span className="min-w-0 flex-1">{failure}</span>
      <button onClick={fetchData} className="font-medium underline underline-offset-2">
        {t.projects.services.retry}
      </button>
    </div>
  );

  /* ── Service list + detail panel ───────────────────────────────── */
  if (selectedService) {
    return (
      <div className="space-y-4">
        {errorNotice}
        <ServiceDetailPanel
          // Key by service id so switching services (via the header switcher)
          // remounts on the tab carried in the URL, with per-service state fresh.
          key={selectedService.id}
          service={selectedService}
          container={containerFor(selectedService.id)}
          containerChecking={containersLoading}
          projectId={id}
          projectSlugBase={projectSlugBase}
          initialTab={slug?.[2]}
          onRefresh={fetchData}
          onBack={closeService}
          onDeleted={closeService}
          projectType={(projectData as { projectType?: string })?.projectType}
          activeDeploymentId={projectData?.activeDeploymentId}
          deployTarget={projectData?.deployTarget}
          serverId={(projectData as { serverId?: string | null })?.serverId}
          siblingServices={servicesData.services}
        />
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-sm font-medium text-foreground">
          {interpolate(
            services.length === 1 ? t.projects.services.countOne : t.projects.services.countOther,
            { count: String(services.length) },
          )}
        </h2>
        <div className="flex items-center gap-1.5">
          <Button asChild variant="ghost" size="sm">
            <Link href={`/projects/${id}/topology`}>
              <UiIcon name="network" />
              {t.projects.sidebar.tabs.topology}
            </Link>
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-8"
            onClick={fetchData}
            title={t.projects.services.refresh}
            aria-label={t.projects.services.refresh}
          >
            <UiIcon name="refresh" className={containersLoading ? "animate-spin" : undefined} />
            <span className="sr-only">{t.projects.services.refresh}</span>
          </Button>
          <Button type="button" size="sm" onClick={() => setCreateOpen(true)}>
            <UiIcon name="plus" />
            {t.projects.services.addService}
          </Button>
        </div>
      </div>

      {/* Upstream compose drift — edited services whose repo values changed */}
      {driftedServices.length > 0 && (
        <div className="rounded-2xl border border-warning-border bg-warning-bg p-5">
          <div className="flex items-center gap-2.5">
            <UiIcon name="warning" className="size-4 text-warning" />
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
                      <span className="min-w-0 flex-1 break-all font-mono">
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

      {errorNotice}

      <div className="@container/services-list">
        <ul className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 overflow-hidden rounded-2xl border border-border/50 bg-card divide-y divide-border/40 @lg/services-list:grid-cols-[minmax(0,1fr)_5rem_auto] @2xl/services-list:gap-x-5">
          {services.map((service) => (
            <ServiceListItem
              key={service.id}
              service={service}
              status={getServiceStatus(service, containerFor(service.id), containersLoading)}
              href={`/projects/${id}/services/${service.id}`}
              resolvedUrl={resolveServiceUrl(service)}
            />
          ))}
        </ul>
      </div>

      {/* Apps wired into this project — not services we own (no container, no
          start/stop), but part of what it runs against. */}
      <LinkedAppsCard projectId={id} />

      {/* Project-wide cpu/memory caps. This lives here (not only in the Runtime
          tab) because the Runtime tab is HIDDEN for a service-first project —
          which is exactly the shape that had no way to change the limits its
          containers ran with. A service can still override per-service via its
          compose `mem_limit`. */}
      <ResourceSettings />

      <AddServiceModal
        projectId={id}
        open={createOpen}
        projectName={projectSlugBase}
        isCloudProject={projectData?.deployTarget === "cloud"}
        onClose={() => setCreateOpen(false)}
        onSubmit={handleCreateService}
      />
    </div>
  );
};
