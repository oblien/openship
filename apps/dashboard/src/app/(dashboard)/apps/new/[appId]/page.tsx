"use client";

import { Icon as UiIcon } from "@repo/ui/icons";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import {
  getAppTemplate,
  getAppSettings,
  getAppEndpoints,
  getAppPrepareSteps,
  getAppFirstLogin,
  flattenSettingFields,
  envToSettingValue,
  settingToEnvValue,
  isFieldVisible,
  resolveLocalized,
  declaredServiceRoutes,
  defaultAppRouteLabel,
  installServicePorts,
  serviceRoutingPatch,
  isValidCustomHostname,
  normalizeCustomHostname,
  normalizeServiceLabel,
  slugify,
  formatCpuCores,
  formatMemoryMb,
  hasMinResources,
  type AppSettingField,
  type AppEndpoint,
  type AppInstallEndpoint as StoredRoute,
  type InstallPhaseId,
  type InstallPhaseStatus,
} from "@repo/core";
import { appsApi, deployApi, servicesApi, projectsApi } from "@/lib/api";
import type { AppHostFitView, InstallAppRoute } from "@/lib/api/apps";
import { type Service } from "@/lib/api/services";
import { connectionsApi } from "@/lib/api/connections";
import { ApiError, getApiErrorMessage } from "@/lib/api/client";
import {
  AppSettingsForm,
  fk,
  withSettingDefaults,
  type FormValue,
  type FormValidity,
} from "@/components/app-settings/AppSettingsForm";
import {
  AppDestinationPicker,
  type AppDestination,
} from "@/components/deploy/AppDestinationPicker";
import { workspaceBillingHref } from "@/components/billing/BillingWorkspaceContext";
import { RoutingSettingsCard } from "@/components/routing/RoutingSettingsCard";
import { createPublicEndpoint, type PublicEndpoint } from "@/context/deployment/types";
import { resolvePublicEndpointHostname } from "@/lib/public-endpoint-payload";
import {
  CleanDeployProgressCard,
  firstPublicHost,
  type DeploySummaryRow,
} from "@/components/deploy/CleanDeployProgress";
import { useBuildStream } from "@/hooks/useSSEConnection";
import type { ServiceStatusEvent } from "@/lib/sseMessageProcessors";
import { useToast } from "@/context/ToastContext";
import { useI18n, interpolate } from "@/components/i18n-provider";
import { usePlatform } from "@/context/PlatformContext";
import { useCloud } from "@/context/CloudContext";
import { useModal } from "@/context/ModalContext";
import { useCloudDeployPricing } from "@/hooks/useCloudDeployPricing";
import { cloudDeployFailure } from "@/lib/cloud-deploy-pricing";
import { LocalDeployComingSoonModal } from "@/components/LocalDeployComingSoonModal";
import { useLocalDeployGate } from "@/hooks/useLocalDeployGate";
import { defaultDomainType } from "@/lib/default-domain-type";
import {
  defaultAppEndpointExposure,
  getAppEndpointModes,
  type AppEndpointExposure as Expo,
} from "@/lib/app-endpoint-exposure";
import { installSettledMessage } from "@/lib/install-settled-message";
import { appInstallDnsTargets, attachDeploymentDomainIds } from "@/lib/deployment-dns";
import { AppLogo } from "@/components/AppLogo";
import { AppDomainConfirmation } from "@/components/apps/AppDomainConfirmation";
import { VerifiedBadge } from "@/components/apps/VerifiedBadge";
import { HostingBadge } from "@/components/apps/HostingBadge";
import { UnverifiedBadge } from "@/components/apps/UnverifiedBadge";
import DnsRecordsModal from "@/components/domains/DnsRecordsModal";
import { PageContainer } from "@/components/ui/PageContainer";
import { CustomSelect } from "@/components/ui/CustomSelect";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { encodeProjectSlug } from "@/utils/repoSlug";
import { parseContainerPort } from "@/utils/compose-ports";

/** Catalog-driven app installer using the shared deployment pipeline. Business
 * settings and endpoint choices are saved before deployment; the progress view
 * maps the existing build stream onto the app's phases and shared log console.
 * Advanced hands the saved draft to the full deployment wizard. */

type Phase = "form" | "installing" | "done" | "error";
type ReadStatus = "loading" | "ready" | "error";

const isInstallField = (f: AppSettingField) => f.installStep === true;

/** Stable key for an exposable endpoint (service + container port). */
const endpointKey = (e: AppEndpoint) => `${e.service}:${e.port}`;

/**
 * The reachable HOST port for a port-only URL — the left side of the service's
 * `host:container` mapping (e.g. "8203:80" → 8203), NOT the container/exposed
 * port (which is only the edge's routing target for domain deploys). Falls back
 * to the endpoint's own port when host==container or the mapping is absent.
 */
function hostPortForEndpoint(
  services: ReadonlyArray<{ name: string; ports?: readonly string[] }> | undefined,
  ep: AppEndpoint,
): number {
  const svc = services?.find((s) => s.name === ep.service);
  for (const spec of svc?.ports ?? []) {
    const parts = String(spec).split(":");
    if (parts.length >= 2 && Number(parts[parts.length - 1]) === ep.port) {
      const host = Number(parts[parts.length - 2]);
      if (Number.isFinite(host)) return host;
    }
  }
  return ep.port;
}

/** Container port a compose `ports` spec serves, as a number ("8203:80" → 80). */
function containerPortOf(spec: string): number {
  return Number(parseContainerPort(spec));
}

/**
 * The routing ALREADY stored on a service row for one endpoint's port, or null
 * when that port isn't routed. Reads the multi-route array when present, and
 * falls back to the scalar columns only for a single-route row that targets this
 * port — so a re-opened draft reflects what was persisted, never a re-derivation.
 */
function storedRouteFor(
  svc: Service,
  port: number,
): { domainType: "free" | "custom"; domain?: string; customDomain?: string } | null {
  const stored = svc.publicEndpoints ?? [];
  const hit = stored.find((e) => e.port === port);
  if (hit) return { domainType: hit.domainType, domain: hit.domain, customDomain: hit.customDomain };
  if (stored.length > 0 || !svc.exposed) return null;
  const scalarPort = Number(svc.exposedPort);
  if (Number.isFinite(scalarPort) && scalarPort !== port) return null;
  return {
    domainType: svc.domainType === "custom" ? "custom" : "free",
    domain: svc.domain ?? undefined,
    customDomain: svc.customDomain ?? undefined,
  };
}

/**
 * Pickers for an ADOPTED draft, seeded from what the project's services actually
 * carry. Without this, re-opening a draft came back on the template defaults, so
 * a second Install click could quietly install different routing than the first.
 */
function rehydrateExpo(
  endpoints: readonly AppEndpoint[],
  services: readonly Service[],
  cloudConnected: boolean,
): Record<string, Expo> {
  const byName = new Map(services.map((s) => [s.name, s]));
  const out: Record<string, Expo> = {};
  for (const e of endpoints) {
    const svc = byName.get(e.service);
    if (!svc) continue;
    if (e.kind === "http") {
      const stored = storedRouteFor(svc, e.port);
      out[endpointKey(e)] = stored
        ? {
            kind: "http",
            mode: "domain",
            ep: createPublicEndpoint({
              port: String(e.port),
              domainType: stored.domainType,
              domain: stored.domain ?? "",
              customDomain: stored.customDomain ?? "",
            }),
          }
        : {
            kind: "http",
            mode: "port",
            ep: createPublicEndpoint({ domainType: defaultDomainType(cloudConnected) }),
          };
    } else {
      const published = ((svc.ports as string[] | null) ?? []).some(
        (p) => containerPortOf(p) === e.port,
      );
      out[endpointKey(e)] = { kind: "tcp", mode: published ? "publish" : "internal" };
    }
  }
  return out;
}

/** The output id a source app offers as its primary connectable value — its first
 *  `provides` bundle ref, else the recommended (or first) connection output.
 *  Read from the BUNDLED catalog; an overlay-only source app resolves to null
 *  (the manual "Use in a project" flow remains the fallback). */
function primaryProvidedOutputId(sourceAppTemplateId: string | undefined): string | null {
  const tpl = sourceAppTemplateId ? getAppTemplate(sourceAppTemplateId) : undefined;
  if (!tpl) return null;
  const provRef = tpl.provides?.[0]?.outputRefs?.[0];
  if (provRef) return provRef;
  const outs = tpl.connection?.outputs ?? [];
  return (outs.find((o) => o.recommended) ?? outs[0])?.id ?? null;
}

export default function AppInstallPage() {
  const params = useParams();
  const router = useRouter();
  const { t, locale } = useI18n();
  const w = t.projectSettings.appInstall;
  const { showToast } = useToast();
  const { baseDomain, deployMode, selfHosted } = usePlatform();
  // Desktop mode → the "open on localhost / forward the port" hints are relevant
  // (a VPS is already public; a local app is already localhost).
  const isDesktop = deployMode === "desktop";
  // Cloud status selects free vs. custom domains; the template's routing intent
  // is the same for Cloud, self-hosted, and local targets.
  const { connected: cloudConnected, loading: cloudLoading, requireCloud } = useCloud();
  const { showModal, hideModal } = useModal();
  // Desktop mode: apps can't run on this machine yet — see useLocalDeployGate.
  const localDeployGate = useLocalDeployGate();

  const appId = String(params?.appId ?? "");
  const searchParams = useSearchParams();
  // Reopening a draft app passes its existing project id — adopt it instead of
  // creating a duplicate (the backend also get-or-creates, this avoids the call).
  const adoptedProjectId = searchParams.get("projectId");
  const cancelInstallConfirmation = useRef<(() => void) | null>(null);
  useEffect(() => () => cancelInstallConfirmation.current?.(), [appId, adoptedProjectId]);
  // A deploy already in flight, carried in the URL (written the moment we enter
  // `installing`) so a hard refresh mid-install RESUMES the progress view —
  // re-attaching to the same SSE stream — instead of dropping back to the form.
  const resumeDeploymentId = searchParams.get("deployment");
  // Bundled template is the instant fallback; the runtime catalog (overlay-fresh
  // from the API) is fetched so a repo-fresh app opens + installs without a redeploy.
  const bundledTemplate = useMemo(() => getAppTemplate(appId), [appId]);
  const [template, setTemplate] = useState(bundledTemplate);
  // The runtime read also discovers an existing draft. The bundled template
  // can render immediately, but cannot authorize installing over unknown routes.
  const [catalogRead, setCatalogRead] = useState<{ appId: string; status: ReadStatus }>({
    appId,
    status: "loading",
  });
  const [catalogRevision, setCatalogRevision] = useState(0);
  const catalogStatus = catalogRead.appId === appId ? catalogRead.status : "loading";
  // The org's existing not-yet-deployed draft of this app, if any. The catalog
  // tiles link here WITHOUT ?projectId, so without this the wizard had no idea a
  // draft existed — it showed template defaults while Install landed on the draft.
  const [openDraft, setOpenDraft] = useState<{
    projectId: string;
    slug: string;
    name: string;
  } | null>(null);
  useEffect(() => {
    setTemplate(bundledTemplate);
    setCatalogRead({ appId, status: "loading" });
    setOpenDraft(null);
    let cancelled = false;
    appsApi
      .template(appId)
      .then((r) => {
        if (cancelled) return;
        if (r?.data) setTemplate(r.data);
        setOpenDraft(r?.draft ?? null);
        setCatalogRead({ appId, status: "ready" });
      })
      .catch((error) => {
        if (cancelled) return;
        if (error instanceof ApiError && error.status === 404) {
          setTemplate(undefined);
          setCatalogRead({ appId, status: "ready" });
        } else {
          setCatalogRead({ appId, status: "error" });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [appId, bundledTemplate, catalogRevision]);
  const groups = useMemo(() => (template ? getAppSettings(template) : []), [template]);
  const installFields = useMemo(
    () => flattenSettingFields(groups).filter(isInstallField),
    [groups],
  );
  // Each thing the app exposes, asked about per endpoint. `http` endpoints are
  // web UIs/APIs (domain-routable or port-only); `tcp` endpoints are raw ports
  // (a database) — publish + firewall, or keep internal. Apps without explicit
  // `endpoints` derive one http endpoint per DECLARED ROUTE, so a multi-port
  // service gets one picker per port instead of an unseen server-side default.
  const appEndpoints = useMemo(() => (template ? getAppEndpoints(template) : []), [template]);
  const needsExposure = appEndpoints.length > 0;
  // `slugSuffix` of the declared route behind each endpoint — the second half of
  // its default free label (`<project>-<service>-<suffix>`).
  const suffixByEndpoint = useMemo(() => {
    const out = new Map<string, string | undefined>();
    for (const svc of template?.services ?? []) {
      for (const r of declaredServiceRoutes(svc)) out.set(`${svc.name}:${r.port}`, r.slugSuffix);
    }
    return out;
  }, [template]);
  // The endpoint whose URL headlines the "done" screen (first web endpoint).
  const primaryHttp = useMemo(() => appEndpoints.find((e) => e.kind === "http"), [appEndpoints]);

  // Declared connections this app NEEDS from another project (e.g. a DATABASE_URL
  // from a database app). Drives an install-time source picker + one-click wire;
  // inert for apps that declare none. Candidates = same-org app projects matching
  // the requirement's category.
  const requires = useMemo(() => template?.requires ?? [], [template]);
  type Candidate = { id: string; name: string; appTemplateId?: string; category?: string };
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  // requirement.id → chosen source project id ("" = none/skip).
  const [connChoices, setConnChoices] = useState<Record<string, string>>({});
  useEffect(() => {
    if (requires.length === 0) return;
    projectsApi
      .getHome()
      .then((res) => {
        const raw = (res?.projects ?? []) as Array<{ id?: string; name?: string; appTemplateId?: string }>;
        setCandidates(
          raw
            .filter((p) => p.id && p.appTemplateId)
            .map((p) => ({
              id: p.id!,
              name: p.name ?? p.id!,
              appTemplateId: p.appTemplateId,
              category: p.appTemplateId ? getAppTemplate(p.appTemplateId)?.category : undefined,
            })),
        );
      })
      .catch(() => setCandidates([]));
  }, [requires.length]);
  const candidatesFor = (category?: string) =>
    candidates.filter((p) => !category || p.category === category);

  const [values, setValues] = useState<Record<string, FormValue>>(() =>
    withSettingDefaults(installFields),
  );
  useEffect(() => {
    setValues((previous) => withSettingDefaults(installFields, previous));
  }, [installFields]);
  const [expo, setExpo] = useState<Record<string, Expo>>(() => {
    const out: Record<string, Expo> = {};
    if (cloudLoading && !cloudConnected) return out;
    for (const e of appEndpoints) out[endpointKey(e)] = defaultAppEndpointExposure(e, cloudConnected);
    return out;
  });
  // The runtime (overlay-fresh) template can declare endpoints the bundled one
  // didn't, and those arrive AFTER the state above was seeded — fill any missing
  // picker so what the wizard renders is what the install sends.
  useEffect(() => {
    // Wait for the initial domain-provider choice (free vs. custom); only fill
    // missing choices, never reset saved routes or user edits.
    if (cloudLoading && !cloudConnected) return;
    setExpo((prev) => {
      const missing = appEndpoints.filter((e) => !prev[endpointKey(e)]);
      if (missing.length === 0) return prev;
      const next = { ...prev };
      for (const e of missing) next[endpointKey(e)] = defaultAppEndpointExposure(e, cloudConnected);
      return next;
    });
  }, [appEndpoints, cloudConnected, cloudLoading]);
  const [destination, setDestination] = useState<AppDestination | null>(null);
  const [destinationReady, setDestinationReady] = useState(false);
  const showCloudPricing = useCloudDeployPricing(destination?.workspaceId);
  const cloudDestination = destination?.deployTarget === "cloud" || (!destination && !selfHosted);
  const exposureModeLabels = {
    domain: { label: w.routeDomainLabel, description: w.routeDomainDesc },
    port: {
      label: cloudDestination ? w.domainNone : w.routePortLabel,
      description: cloudDestination ? w.routePortCloudDesc : w.routePortDesc,
    },
    publish: { label: w.tcpPublishLabel, description: w.tcpPublishDesc },
    internal: { label: w.tcpInternalLabel, description: w.tcpInternalDesc },
  };
  const setExpoMode = (key: string, mode: Expo["mode"]) =>
    setExpo((p) => (p[key] ? { ...p, [key]: { ...p[key], mode } as Expo } : p));
  const setExpoEp = (key: string, updates: Partial<PublicEndpoint>) =>
    setExpo((p) => {
      const cur = p[key];
      return cur?.kind === "http" ? { ...p, [key]: { ...cur, ep: { ...cur.ep, ...updates } } } : p;
    });

  // Header description: clamped to two lines with a More/Less toggle, because a
  // heavy app's blurb runs long enough to push the form below the fold.
  //
  // Whether the toggle appears is MEASURED (scrollHeight vs clientHeight), not
  // guessed from a character count — a count that's right at this width offers
  // "More" on a description that isn't clamped, or worse, hides truncated text on
  // a narrow viewport. Re-measured on resize for the same reason. The measurement
  // is skipped while expanded (where the two heights are equal by definition, so
  // measuring would clear the flag and remove the way back).
  const descRef = useRef<HTMLParagraphElement | null>(null);
  const [descExpanded, setDescExpanded] = useState(false);
  const [descClamped, setDescClamped] = useState(false);
  useEffect(() => {
    const el = descRef.current;
    if (!el || descExpanded) return;
    const measure = () => setDescClamped(el.scrollHeight > el.clientHeight + 1);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [descExpanded, template?.description]);

  // Project name shown in Openship. Editable for a fresh install (a second
  // install of the same app auto-suffixes server-side, e.g. "Convex 2"); hidden
  // when reopening an existing draft, which already has its name.
  const [appName, setAppName] = useState(() => template?.name ?? "");

  const [phase, setPhase] = useState<Phase>(resumeDeploymentId ? "installing" : "form");
  const [busy, setBusy] = useState(false);
  const submitting = useRef(false);
  // A Stop request is in flight (the cancel POST + teardown). Disables the Stop
  // button. `cancelled` records that the terminal `error` phase was a user Stop,
  // not a failure — the progress view swaps to neutral "cancelled" copy.
  const [isStopping, setIsStopping] = useState(false);
  const [cancelled, setCancelled] = useState(false);
  const [deploymentId, setDeploymentId] = useState<string | null>(resumeDeploymentId);
  const activeDeployment = useRef<string | null>(resumeDeploymentId);
  useEffect(() => {
    activeDeployment.current = deploymentId;
    return () => { if (activeDeployment.current === deploymentId) activeDeployment.current = null; };
  }, [deploymentId]);
  const [projectId, setProjectId] = useState<string | null>(adoptedProjectId);
  const [progress, setProgress] = useState(0);
  // Epoch ms this install started, for the progress panel's elapsed clock. Set
  // when we enter `installing`, and on a mid-install refresh from the build's own
  // `buildStartedAt` so the resumed view doesn't restart the clock at zero.
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [phaseLabel, setPhaseLabel] = useState("");
  const [liveUrl, setLiveUrl] = useState<string | null>(null);
  const [logs, setLogs] = useState("");
  const [errorMsg, setErrorMsg] = useState("");
  const [cloudFailure, setCloudFailure] = useState<ApiError | null>(null);
  const shownRecovery = useRef<string | null>(null);
  // The JSON-mapped install stepper's live state: real backend phase boundaries
  // (images → services → app-setup → ready) and per-service statuses, both fed by
  // SSE and replayed on reconnect. Empty object = all-pending preview.
  const [phases, setPhases] = useState<Partial<Record<InstallPhaseId, InstallPhaseStatus>>>({});
  const [services, setServices] = useState<ServiceStatusEvent[]>([]);
  // Validity of the install-step business fields (required + per-field rules),
  // reported by AppSettingsForm. Null when there are no install fields.
  const [formValidity, setFormValidity] = useState<FormValidity | null>(null);

  // Unknown / non-installable / flow apps don't belong here.
  useEffect(() => {
    if (catalogStatus !== "ready") return;
    if (!template || template.kind === "flow" || !template.available) {
      router.replace("/apps/new");
    }
  }, [catalogStatus, template, appId, router]);

  // ── Draft re-entry: show what's persisted, not the template defaults ───────
  /** The project label the installer will build free hostnames from — its slug,
   *  which is `slugify(name)`. Same input the server uses, so the label previewed
   *  here is the label persisted there. */
  const projectLabel = slugify(appName.trim() || template?.name || "");
  // The draft this Install will land on: the one in the URL, or the org's open
  // draft while the typed name still resolves to it (the exact match the
  // installer itself makes, on `slugify(name)`).
  const targetDraftId =
    adoptedProjectId ?? (openDraft && projectLabel === openDraft.slug ? openDraft.projectId : null);

  const declaresResources = hasMinResources(template?.minResources);
  const [hostFit, setHostFit] = useState<AppHostFitView | null>(null);
  const [capacityLoading, setCapacityLoading] = useState(false);
  const [capacityRevision, setCapacityRevision] = useState(0);
  // Match the install target, including a draft created before DNS was cancelled.
  const capacityProjectId = adoptedProjectId ?? projectId ?? targetDraftId;
  useEffect(() => {
    const templateId = template?.id;
    if (!templateId || !destinationReady || (!cloudDestination && !declaresResources)) {
      setHostFit(null);
      setCapacityLoading(false);
      return;
    }
    let live = true;
    setHostFit(null);
    setCapacityLoading(true);
    void appsApi
      .hostFit(templateId, {
        deployTarget: cloudDestination ? "cloud" : destination?.deployTarget,
        serverId: destination?.serverId,
        projectId: capacityProjectId ?? undefined,
      })
      .then((res) => {
        if (live) setHostFit(res.data);
      })
      .catch(() => {
        // Preview failure never substitutes for the deployment's authoritative check.
        if (live) setHostFit(null);
      })
      .finally(() => {
        if (live) setCapacityLoading(false);
      });
    return () => {
      live = false;
    };
  }, [
    declaresResources,
    template?.id,
    destination,
    destinationReady,
    cloudDestination,
    selfHosted,
    capacityProjectId,
    capacityRevision,
  ]);

  // Checkout opens separately, preserving the form. Refresh the plan when the
  // operator returns; no polling or automatic deployment follows an upgrade.
  useEffect(() => {
    if (selfHosted) return;
    const refresh = () => setCapacityRevision((value) => value + 1);
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [selfHosted]);
  const needsCloudUpgrade = cloudDestination && hostFit?.cloud?.status === "upgrade";
  const checkingCloudCapacity = cloudDestination && capacityLoading;

  const [draftRouting, setDraftRouting] = useState<
    | { projectId: string; status: "ready"; slug: string | null }
    | { projectId: string; status: "error" }
    | null
  >(null);
  const currentDraftRouting = draftRouting?.projectId === targetDraftId ? draftRouting : null;
  const draftRoutingReady =
    !targetDraftId || !needsExposure || currentDraftRouting?.status === "ready";
  const draftSlug = currentDraftRouting?.status === "ready" ? currentDraftRouting.slug : null;
  const configurationReady = catalogStatus === "ready" && draftRoutingReady;
  const exposureReady =
    configurationReady && appEndpoints.every((e) => Boolean(expo[endpointKey(e)]));
  const configurationError =
    catalogStatus === "error"
      ? w.catalogLoadFailed
      : currentDraftRouting?.status === "error"
        ? w.routingLoadFailed
        : null;
  const routeControlsDisabled =
    busy || !draftRoutingReady || (catalogStatus !== "ready" && !adoptedProjectId);
  /** The default free subdomain LABEL for one endpoint — identical to what the
   *  installer writes when the slug field is left blank (shared helper), so the
   *  preview can't promise a hostname the install won't create. */
  const defaultFreeLabel = (e: AppEndpoint) =>
    defaultAppRouteLabel(
      draftSlug ?? projectLabel,
      e.service,
      suffixByEndpoint.get(endpointKey(e)),
    );
  // Rehydrate ONCE per draft. Keyed by id, not by effect deps: `appEndpoints` gets
  // a new identity when the overlay-fresh template lands, and re-running then
  // would overwrite picker edits the operator had already made.
  useEffect(() => {
    if (!targetDraftId) {
      setDraftRouting(null);
      return;
    }
    if (draftRouting?.projectId === targetDraftId) return;
    let cancelled = false;
    void Promise.all([projectsApi.getInfo(targetDraftId), servicesApi.list(targetDraftId)])
      .then(([info, svcRes]) => {
        if (cancelled) return;
        const project = info?.data?.project as { slug?: string; name?: string; workspaceId?: string; serverId?: string; serverName?: string; deployTarget?: string } | undefined;
        if (!project || !Array.isArray(svcRes?.services))
          throw new Error("Incomplete draft response");
        if (!selfHosted || project.deployTarget === "cloud" || project.workspaceId) {
          setDestination({ deployTarget: "cloud", workspaceId: project.workspaceId ?? undefined, serverId: project.serverId ?? undefined, serverName: project.serverName });
        } else if (project.serverId) {
          setDestination({ deployTarget: "server", serverId: project.serverId, serverName: project.serverName });
        }
        // A catalog update can cancel the pending read. Only mark the draft
        // restored after its routes are applied, including an empty service list.
        setExpo((prev) => ({
          ...prev,
          ...rehydrateExpo(appEndpoints, svcRes.services, cloudConnected),
        }));
        setDraftRouting({
          projectId: targetDraftId,
          status: "ready",
          slug: project.slug ?? (project.name ? slugify(project.name) : null),
        });
      })
      .catch(() => {
        if (!cancelled) setDraftRouting({ projectId: targetDraftId, status: "error" });
      });
    return () => {
      cancelled = true;
    };
  }, [targetDraftId, appEndpoints, draftRouting, cloudConnected, selfHosted]);

  /**
   * The URL an endpoint is ACTUALLY reachable at, read back from the service rows
   * the deploy just routed. The done screen used to look for
   * `buildStatus.config.publicEndpoints`, which a services/compose deploy never
   * carries — so a Free or Custom install always finished with no "Open app" link,
   * the one case where a link exists. Reading the persisted routing also means the
   * URL shown is the hostname that was stored, not one recomputed from intent.
   */
  const persistedRouteUrl = async (pid: string, ep: AppEndpoint): Promise<string | null> => {
    const svcRes = await servicesApi.list(pid).catch(() => null);
    const svc = ((svcRes?.services ?? []) as Service[]).find((s) => s.name === ep.service);
    const stored = svc ? storedRouteFor(svc, ep.port) : null;
    if (!stored) return null;
    const host = resolvePublicEndpointHostname(stored, baseDomain);
    return host ? `https://${host}` : null;
  };

  // ── Live install progress over SSE (attach to the running build) ───────────
  // The install phase labels for the stepper header line.
  const phaseHeaderLabel: Record<InstallPhaseId, string> = {
    images: w.phaseImages,
    services: w.phaseServices,
    "app-setup": w.phaseAppSetup,
    ready: w.phaseReady,
  };

  /** Headline URL for the done screen = the primary web endpoint. Port-only →
   *  `serverHost:port` (cloud has no host binding → no link); domain → the
   *  persisted public host. Reads the SAME derivation the poll used.
   *
   *  A server row is the only destination that yields a host, and that's why the
   *  picker no longer offers a "this machine" card: it carried no `sshHost`, so a
   *  port-only install on a VPS advertised `http://localhost:<port>`. */
  const deriveLiveUrl = async (config?: {
    publicEndpoints?: Array<{ domain?: string; customDomain?: string; domainType?: string }>;
  }) => {
    const primaryState = primaryHttp ? expo[endpointKey(primaryHttp)] : undefined;
    if (primaryState?.kind === "http" && primaryState.mode === "port") {
      const host = destination?.deployTarget === "server" ? destination.serverHost : null;
      // Port-only reachability is the PUBLISHED host port, not the container port
      // (they differ when the template remaps, e.g. 8203:80).
      const reachablePort = primaryHttp ? hostPortForEndpoint(template?.services, primaryHttp) : 0;
      setLiveUrl(host && primaryHttp ? `http://${host}:${reachablePort}` : null);
    } else if (primaryState?.kind === "http" && primaryHttp && projectId) {
      setLiveUrl(
        (await persistedRouteUrl(projectId, primaryHttp)) ??
          firstPublicHost(config?.publicEndpoints, baseDomain),
      );
    } else {
      setLiveUrl(null);
    }
  };

  // Terminal detection is resolved ONCE per install with a single authoritative
  // `getBuildStatus` read — the SSE `complete` collapses `partial_failure` /
  // `action_required` / `reconciling` into a plain success/failure, so the true
  // DB status (and the precise liveUrl) comes from the read, not the stream.
  const settledRef = useRef(false);
  const attachDeployment = useCallback((response: Awaited<ReturnType<typeof deployApi.buildAccess>>, targetPid: string) => {
    const depId = response?.data?.deployment_id ?? response?.data?.deploymentId ?? response?.deployment_id;
    if (typeof depId !== "string" || !depId) throw new Error(w.installFailed);
    settledRef.current = false;
    shownRecovery.current = null;
    activeDeployment.current = depId;
    setProjectId(targetPid);
    setDeploymentId(depId);
    setLogs("");
    setPhases({});
    setServices([]);
    setProgress(0);
    setLiveUrl(null);
    setCancelled(false);
    setErrorMsg("");
    setCloudFailure(null);
    setPhaseLabel(w.phaseQueued);
    setStartedAt(Date.now());
    setPhase("installing");
    try {
      const url = new URL(window.location.href);
      url.searchParams.set("deployment", depId);
      url.searchParams.set("projectId", targetPid);
      window.history.replaceState(null, "", url.toString());
    } catch {
      /* resume just won't survive a reload */
    }
  }, [w.installFailed, w.phaseQueued]);
  const retryDeployment = useCallback(async function retry(): Promise<void> {
    if (!deploymentId || !projectId || submitting.current) return;
    submitting.current = true;
    setBusy(true);
    try {
      attachDeployment(await deployApi.buildRedeploy(deploymentId), projectId);
    } catch (error) {
      if (!showCloudPricing(error, retry)) showToast(getApiErrorMessage(error, w.installFailed), "error");
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }, [deploymentId, projectId, attachDeployment, showCloudPricing, showToast, w.installFailed]);
  useEffect(() => {
    if (phase !== "error" || !cloudFailure || !deploymentId || shownRecovery.current === deploymentId) return;
    if (showCloudPricing(cloudFailure, retryDeployment)) shownRecovery.current = deploymentId;
  }, [phase, cloudFailure, deploymentId, showCloudPricing, retryDeployment]);
  const resolveTerminal = async (fallback: {
    ok: boolean;
    message?: string;
    errorCode?: string;
    errorDetails?: Record<string, unknown>;
    /** This resolution is a CANCEL (the user's Stop, or an SSE `cancelled`), even
     *  if the DB row hasn't caught up yet. Load-bearing: a cancel must never
     *  inherit the generic failure message — see `settledMessage`. */
    cancelled?: boolean;
  }) => {
    if (settledRef.current || !deploymentId || activeDeployment.current !== deploymentId) return;
    settledRef.current = true;
    let status = "";
    let s: any = {};
    try {
      const res = await deployApi.getBuildStatus(deploymentId);
      if (activeDeployment.current !== deploymentId) return;
      s = res?.data ?? res ?? {};
      status = s.deploymentStatus ?? s.status ?? "";
      // Prefer the server's full accumulated log over the streamed fragments.
      if (typeof s.logs === "string" && s.logs.length >= logs.length) setLogs(s.logs);
    } catch {
      /* fall back to the SSE outcome below */
    }
    if (activeDeployment.current !== deploymentId) return;
    // A cancelled deploy (user Stop, or resuming one) is a neutral outcome, not a
    // failure — flag it so the error screen reads as "cancelled".
    const isCancel = status === "cancelled" || fallback.cancelled === true;
    if (isCancel) setCancelled(true);
    const failureProjectId = typeof s.project_id === "string" ? s.project_id : projectId;
    if (failureProjectId) setProjectId(failureProjectId);
    setCloudFailure(isCancel ? null : cloudDeployFailure({
      errorCode: s.errorCode ?? fallback.errorCode,
      errorDetails: s.errorCode ? s.errorDetails : fallback.errorDetails,
      errorMessage: s.failureMessage ?? s.errorMessage ?? fallback.message,
      projectId: failureProjectId,
    }));
    // The reason under the verdict — or nothing. A cancel never inherits the
    // failure fallback; see `installSettledMessage` for why.
    const settledMessage = () =>
      installSettledMessage({
        isCancel,
        serverMessage: s.failureMessage,
        streamMessage: fallback.message,
        failedFallback: w.installFailed,
      });
    const failed = ["failed", "cancelled", "partial_failure", "action_required", "rejected"];
    // `no_changes` is a SUCCESS: every service was already up to date and the live
    // stack is the one this install wanted. Treating it as terminal-but-unhandled
    // would show "Install failed" over a working app.
    if (status === "ready" || status === "no_changes" || (status === "" && fallback.ok)) {
      await deriveLiveUrl(s?.config);
      setPhase("done");
    } else if (failed.includes(status) || (status === "" && !fallback.ok)) {
      setErrorMsg(settledMessage());
      setPhase("error");
    } else {
      // Still not settled in the DB but SSE said it's over — trust the stream.
      if (fallback.ok) {
        await deriveLiveUrl(s?.config);
        setPhase("done");
      } else {
        setErrorMsg(settledMessage());
        setPhase("error");
      }
    }
  };

  const build = useBuildStream({
    callbacks: {
      onInstallPhase: (p) => {
        setPhases((prev) => ({ ...prev, [p.id]: p.status }));
        if (p.status === "active") setPhaseLabel(p.label || phaseHeaderLabel[p.id]);
      },
      onServiceStatus: (svc) => {
        setServices((prev) => {
          const key = svc.serviceId || svc.serviceName;
          const idx = prev.findIndex((x) => (x.serviceId || x.serviceName) === key);
          if (idx === -1) return [...prev, svc];
          const next = [...prev];
          next[idx] = svc;
          return next;
        });
      },
      onLog: (_message, rawText) => {
        if (rawText) setLogs((prev) => prev + rawText);
      },
      onProgress: (_step, pct) => {
        if (typeof pct === "number") setProgress(pct);
      },
      onSuccess: () => void resolveTerminal({ ok: true }),
      onFailure: (message, errorCode, errorDetails) => void resolveTerminal({ ok: false, message, errorCode, errorDetails }),
      onCanceled: () => {
        setCancelled(true);
        // The stream's cancel message is a fixed "Build cancelled" — the verdict
        // again, not a reason — so it is dropped rather than echoed under the
        // heading. A real reason, when one exists, comes off the row.
        void resolveTerminal({ ok: false, cancelled: true });
      },
    },
  });

  // Attach to the running build whenever we're on the installing screen. A single
  // upfront `getBuildStatus` read catches an ALREADY-settled deploy (e.g. resuming
  // via `?deployment=` after it finished) without waiting for a stream that may be
  // gone; otherwise we attach (startBuild=false — the build was kicked by
  // `buildAccess`, POSTing again would start a second one) and let the SSE replay
  // rebuild the stepper + service list + logs.
  const connect = build.connect;
  const disconnect = build.disconnect;
  useEffect(() => {
    if (phase !== "installing" || !deploymentId) return;
    settledRef.current = false;
    let cancelled = false;
    void (async () => {
      try {
        const res = await deployApi.getBuildStatus(deploymentId);
        const s = res?.data ?? res ?? {};
        const status: string = s.deploymentStatus ?? s.status ?? "";
        if (typeof s.progress === "number") setProgress(s.progress);
        // Resuming: keep the clock on the real start when the build reports one.
        const startedIso = Date.parse(String(s.buildStartedAt ?? ""));
        setStartedAt((prev) => prev ?? (Number.isFinite(startedIso) ? startedIso : Date.now()));
        if (
          ["ready", "failed", "cancelled", "partial_failure", "action_required", "rejected", "no_changes"].includes(
            status,
          )
        ) {
          await resolveTerminal({
            ok: status === "ready" || status === "no_changes",
            message: s.failureMessage,
            errorCode: s.errorCode,
            errorDetails: s.errorDetails,
            cancelled: status === "cancelled",
          });
          return;
        }
      } catch {
        /* live deploy — attach below */
      }
      if (!cancelled) void connect(deploymentId, false);
    })();
    return () => {
      cancelled = true;
      disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, deploymentId]);

  /** Stop an in-flight install. Aborts the build server-side (containers/images
   *  torn down, volumes kept so a retry works), then resolves the progress view
   *  to the neutral "cancelled" terminal. The SSE `cancelled`/`end` also fires —
   *  `settledRef` makes whichever lands first the single resolution. */
  const stopInstall = async () => {
    if (!deploymentId || isStopping || settledRef.current) return;
    setIsStopping(true);
    setCancelled(true);
    try {
      await deployApi.cancel(deploymentId);
      disconnect();
      await resolveTerminal({ ok: false, cancelled: true });
    } catch (err) {
      // The build likely already finished in the race — let the stream/terminal
      // read settle it, and undo the optimistic cancel flag.
      setCancelled(false);
      showToast(getApiErrorMessage(err, w.stopFailed), "error");
    } finally {
      setIsStopping(false);
    }
  };

  const configurationNotice = !configurationReady && (
    <div role={configurationError ? "alert" : "status"} className="space-y-3 rounded-2xl bg-card p-4">
      <p className="flex items-start gap-2 text-sm text-muted-foreground">
        <UiIcon
          name={configurationError ? "warning" : "spinner"}
          className={`mt-0.5 size-4 shrink-0 ${configurationError ? "text-warning" : "animate-spin"}`}
        />
        {configurationError ?? w.configurationLoading}
      </p>
      {configurationError && (
        <Button
          type="button"
          variant="secondary"
          onClick={() => {
            if (catalogStatus === "error") {
              setCatalogRead({ appId, status: "loading" });
              setCatalogRevision((value) => value + 1);
            } else {
              setDraftRouting(null);
            }
          }}
        >
          {w.retryConfiguration}
        </Button>
      )}
    </div>
  );

  if (!template) return <PageContainer>{configurationNotice}</PageContainer>;

  const setField = (f: AppSettingField, v: FormValue) =>
    setValues((prev) => ({ ...prev, [fk(f.service, f.key)]: v }));

  /** Business-field changes vs the template defaults → the settings to persist.
   *  Skips fields hidden by their `showIf` (their value shouldn't be applied). */
  const settingChanges = () => {
    const valueGet = (service: string, key: string) => values[fk(service, key)];
    const out: { service: string; key: string; value: string }[] = [];
    for (const f of installFields) {
      if (!isFieldVisible(f, valueGet)) continue;
      const cur = values[fk(f.service, f.key)];
      const def = envToSettingValue(f, undefined);
      if (cur !== def && !(f.secret && cur === "")) {
        out.push({ service: f.service, key: f.key, value: settingToEnvValue(f, cur ?? "") });
      }
    }
    return out;
  };

  /** The routing decision, in the shape the install write takes. This is the ONLY
   *  way an app install gets a public hostname — the server invents none, so an
   *  endpoint that isn't here (or is here as `port`) deploys port-only. */
  const routeChoices = (): InstallAppRoute[] => {
    const out: InstallAppRoute[] = [];
    for (const e of appEndpoints) {
      if (e.kind !== "http") continue; // tcp endpoints are ports, never hostnames
      const st = expo[endpointKey(e)];
      if (st?.kind !== "http") continue;
      if (st.mode === "port") {
        out.push({ service: e.service, port: e.port, mode: "port" });
      } else if (st.ep.domainType === "custom") {
        out.push({
          service: e.service,
          port: e.port,
          mode: "custom",
          // The SAME normalizer the API stores with, so a pasted `https://host/`
          // is sent as the hostname that gets persisted.
          customDomain: normalizeCustomHostname(st.ep.customDomain),
        });
      } else {
        // Blank = "the default label", which the installer resolves with the same
        // helper this wizard previews (defaultFreeLabel) — so the operator's
        // untouched choice and the stored hostname can't diverge.
        const slug = st.ep.domain.trim() ? normalizeServiceLabel(st.ep.domain) : "";
        out.push({ service: e.service, port: e.port, mode: "free", ...(slug ? { domain: slug } : {}) });
      }
    }
    return out;
  };

  /** Raw-TCP exposure: `internal` strips this port's published host mapping
   *  (reachable only inside the project); `publish` is a no-op — the template
   *  already publishes it. Ports, not routing: no hostname is involved. */
  const applyTcpExposure = async (pid: string) => {
    const tcp = appEndpoints.filter((e) => e.kind === "tcp" && expo[endpointKey(e)]?.mode === "internal");
    if (tcp.length === 0) return;
    const svcRes = await servicesApi.list(pid);
    const byName = new Map((svcRes?.services ?? []).map((s) => [s.name, s]));
    for (const e of tcp) {
      const svc = byName.get(e.service);
      if (!svc) continue;
      const ports = ((svc.ports as string[] | null) ?? []).filter((p) => containerPortOf(p) !== e.port);
      await servicesApi.update(pid, svc.id, { ports });
    }
  };

  /** Re-apply routing to a project this wizard was handed by id (`?projectId=`),
   *  where there's no name to match a draft on so the install write can't adopt it.
   *
   *  One write per service, and it always sends the FULL `publicEndpoints` array:
   *  scalars alone lose to the stored array, which is how a custom-domain choice
   *  used to come back as a free route (and then 403 on a disconnected instance).
   *  Nothing is carried over: the wizard now asks about every DECLARED route, so a
   *  stored route for an unasked port is one no operator was ever shown. */
  const applyDraftRouting = async (pid: string, choices: InstallAppRoute[]) => {
    if (choices.length === 0) return;
    const svcRes = await servicesApi.list(pid);
    const services = (svcRes?.services ?? []) as Service[];
    for (const svc of services) {
      const mine = choices.filter((c) => c.service === svc.name);
      if (mine.length === 0) continue;
      const publicEndpoints: StoredRoute[] = mine.flatMap((c): StoredRoute[] =>
        c.mode === "custom"
          ? [{ port: c.port, domainType: "custom", customDomain: c.customDomain! }]
          : c.mode === "free"
            ? [
                {
                  port: c.port,
                  domainType: "free",
                  // Same default label the installer would write for this port,
                  // suffix included — a shared helper, so a secondary route can't
                  // collide with its primary by losing the suffix.
                  domain:
                    c.domain ||
                    storedRouteFor(svc, c.port)?.domain ||
                    defaultAppRouteLabel(
                      draftSlug || projectLabel,
                      svc.name,
                      suffixByEndpoint.get(`${svc.name}:${c.port}`),
                    ),
                },
              ]
            : [],
      );
      await servicesApi.update(pid, svc.id, {
        ...serviceRoutingPatch({ exposed: publicEndpoints.length > 0, publicEndpoints }),
        ports: installServicePorts(
          svc.name,
          template?.services?.find((service) => service.name === svc.name)?.ports,
          choices,
          svc.ports as string[] | null,
        ),
      });
    }
  };

  /** Keep one submission pending through either confirmation. Leaving the
   * installer cancels it so a stale modal cannot create or deploy a project. */
  const confirmInstall = (
    content: (confirm: () => void, cancel: () => void) => React.ReactNode,
    maxWidth: string,
  ) =>
    new Promise<boolean>((resolve) => {
      let modalId = "";
      let settled = false;
      const settle = (proceed: boolean) => {
        if (settled) return;
        settled = true;
        cancelInstallConfirmation.current = null;
        resolve(proceed);
      };
      const finish = (proceed: boolean) => {
        settle(proceed);
        hideModal(modalId);
      };
      const cancel = () => finish(false);
      cancelInstallConfirmation.current = cancel;
      modalId = showModal({
        maxWidth,
        width: "100%",
        showCloseButton: false,
        onClose: () => settle(false),
        customContent: content(() => finish(true), cancel),
      });
    });

  /** Validate hostnames and managed-domain access before any writes. A missing
   *  custom hostname can become port-only only after explicit confirmation, and
   *  only when the catalog allows it. Null = don't proceed.
   *
   *  The shape gate is not decoration: `myhost` / `host:8443` / `host/path` used to
   *  reach the API, fail deep inside the service write, and leave a project row
   *  behind with no services. */
  const validatedRouteChoices = async (): Promise<InstallAppRoute[] | null> => {
    const routes = routeChoices();
    const missing = routes.filter((route) => route.mode === "custom" && !route.customDomain);
    if (
      routes
        .filter(
          (route) => route.mode === "port" || (route.mode === "custom" && !route.customDomain),
        )
        .some((route) => {
          const endpoint = appEndpoints.find(
            (e) => e.service === route.service && e.port === route.port,
          );
          return !endpoint || !getAppEndpointModes(endpoint).includes("port");
        })
    ) {
      showToast(w.customRequired, "error");
      return null;
    }
    const malformed = routes.find(
      (r) => r.mode === "custom" && r.customDomain && !isValidCustomHostname(r.customDomain),
    );
    if (malformed) {
      showToast(
        `"${malformed.customDomain}" isn't a valid domain name. Use a hostname like app.example.com — no scheme, port or path.`,
        "error",
      );
      return null;
    }
    if (routes.some((r) => r.mode === "free") && !(await requireCloud("managed-project-domain"))) {
      return null;
    }
    const withoutDomains = appEndpoints.filter((endpoint) => {
      if (endpoint.kind !== "http" || !getAppEndpointModes(endpoint).includes("domain"))
        return false;
      const route = routes.find((r) => r.service === endpoint.service && r.port === endpoint.port);
      return (
        (route?.mode === "custom" && !route.customDomain) ||
        (route?.mode === "port" && (endpoint.scope === "public" || endpoint.scope === undefined))
      );
    });
    // An empty Free field asks the server to generate a route. Confirm that
    // intent without freezing the preview label: a second installation may get
    // a suffixed project name and must keep its own default hostname.
    const automaticEndpoints = appEndpoints.filter((endpoint) => {
      const route = routes.find((r) => r.service === endpoint.service && r.port === endpoint.port);
      return route?.mode === "free" && !route.domain;
    });
    if (withoutDomains.length === 0 && automaticEndpoints.length === 0) return routes;

    const confirmed = await confirmInstall(
      (confirm, cancel) => (
        <AppDomainConfirmation
          endpoints={withoutDomains}
          automaticEndpoints={automaticEndpoints}
          cloud={cloudDestination}
          onClose={cancel}
          onAddDomains={() => {
            setExpo((previous) => {
              const next = { ...previous };
              for (const endpoint of withoutDomains) {
                const key = endpointKey(endpoint);
                const current = next[key];
                if (current?.kind === "http") next[key] = { ...current, mode: "domain" };
              }
              return next;
            });
            cancel();
            requestAnimationFrame(() => {
              const section = document
                .getElementById(`endpoint-${endpointKey(withoutDomains[0] ?? automaticEndpoints[0]!)}`)
                ?.closest("section");
              const field =
                section?.querySelector<HTMLElement>("input:not([disabled])") ??
                section?.querySelector<HTMLElement>("button:not([disabled])");
              field?.scrollIntoView?.({ block: "center" });
              field?.focus();
            });
          }}
          onConfirm={confirm}
        />
      ),
      "480px",
    );
    if (!confirmed) return null;
    // Only an explicit confirmation can turn an empty custom-domain choice
    // into no routing. Carry this same plan through new and adopted drafts.
    setExpo((previous) => {
      const next = { ...previous };
      for (const route of missing) {
        const key = `${route.service}:${route.port}`;
        const current = next[key];
        if (current?.kind === "http") next[key] = { ...current, mode: "port" };
      }
      return next;
    });
    return routes.map((route) =>
      route.mode === "custom" && !route.customDomain
        ? { service: route.service, port: route.port, mode: "port" }
        : route,
    );
  };

  const withSubmission = (run: () => Promise<void>) => async () => {
    if (submitting.current || busy || !exposureReady) return;
    submitting.current = true;
    setBusy(true);
    try {
      await run();
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  };

  const install = withSubmission(async () => {
    if (!destinationReady) return;
    // Business-field validity gate (required + per-field rules). The form reports
    // this; block with a clear message rather than shipping an invalid install.
    if (formValidity && !formValidity.valid) {
      showToast(
        formValidity.missingRequiredKeys.length > 0
          ? "Fill in the required fields before installing."
          : "Fix the highlighted fields before installing.",
        "error",
      );
      return;
    }
    // A non-optional declared connection must have a source chosen.
    const unmet = requires.filter((r) => !r.optional && !connChoices[r.id]);
    if (unmet.length > 0) {
      showToast(
        `Choose a source for: ${unmet.map((r) => resolveLocalized(r.label, locale)).join(", ")}`,
        "error",
      );
      return;
    }
    // Installing TO Openship Cloud needs a cloud connection — the same hard gate
    // the deploy wizard applies at Continue. Without it the pick was a dead end:
    // the install failed deep in preflight with no way to act on it.
    if (destination?.deployTarget === "cloud" && !cloudConnected) {
      if (!(await requireCloud("cloud-deploy-target"))) return;
    }
    // TODO: temporary desktop gate (useLocalDeployGate). Desktop mode controls
    // remote servers; an app can't run on this machine yet. Every install here is
    // a new one (a draft isn't deployed), so there's nothing to strand.
    if (
      localDeployGate.blocks({
        deployTarget: destination?.deployTarget,
        serverId: destination?.deployTarget === "server" ? destination.serverId : undefined,
      })
    ) {
      let modalId = "";
      modalId = showModal({
        customContent: (
          <LocalDeployComingSoonModal
            action="install"
            onClose={() => hideModal(modalId)}
            onServerAdded={(server) =>
              setDestination({
                deployTarget: "server",
                serverId: server.id,
                serverHost: server.sshHost ?? undefined,
                serverName: server.name ?? undefined,
              })
            }
          />
        ),
        maxWidth: "460px",
      });
      return;
    }
    const routes = await validatedRouteChoices();
    if (!routes) return;
    // Flips true the moment a deployment is actually created. A preflight
    // failure rejects buildAccess BEFORE that, so `started` stays false and the
    // catch surfaces a toast instead of the full-screen error card.
    let started = false;
    try {
      // Reuse an adopted / already-created draft; only create when we have none.
      // A fresh install carries the routing IN the create write (one atomic write
      // per service); an existing draft has no create write, so it's re-applied.
      let pid = adoptedProjectId ?? projectId;
      if (!pid) {
        const res = await appsApi.install({
          templateId: appId,
          serverId: destination?.serverId,
          name: appName.trim() || undefined,
          routes,
        });
        const data = res.data;
        if (data.kind !== "template") {
          router.push((data as { flowHref?: string }).flowHref ?? "/apps");
          return;
        }
        pid = data.projectId;
      } else {
        await applyDraftRouting(pid, routes);
      }
      setProjectId(pid);

      const changes = settingChanges();
      if (changes.length > 0) await appsApi.updateSettings(pid, changes);
      await applyTcpExposure(pid);

      // Wire declared connections BEFORE deploy so the injected env is present.
      // Best-effort (mirrors domains — never fails the deploy); the required gate
      // above already ensured a source is chosen for non-optional requirements.
      for (const req of requires) {
        const src = connChoices[req.id];
        if (!src) continue;
        const cand = candidates.find((p) => p.id === src);
        const outputId = primaryProvidedOutputId(cand?.appTemplateId);
        if (!outputId) continue;
        try {
          await connectionsApi.bundle(pid, {
            sourceProjectId: src,
            items: [{ outputId, envKey: req.envKey }],
            mode: req.mode,
          });
        } catch (err) {
          showToast(getApiErrorMessage(err, "Couldn't wire a connection"), "error");
        }
      }

      const startDeploy = async (targetPid: string) => {
        try {
          const dep = await deployApi.buildAccess({
            projectId: targetPid,
            serviceDeploymentMode: "services",
            // Where to install — reuses the deploy wizard's target selection.
            // Undefined falls back to the project/meta default server-side.
            deployTarget: destination?.deployTarget,
            serverId: destination?.serverId,
          });
          attachDeployment(dep, targetPid);
          started = true;
        } catch (err) {
          if (!started && showCloudPricing(err, () => startDeploy(targetPid))) return;
          const msg = getApiErrorMessage(err, w.installFailed).replace(
            /^Pre-deploy checks failed:\s*/i,
            "",
          );
          if (started) {
            setErrorMsg(msg);
            setPhase("error");
          } else {
            showToast(msg, "error");
          }
        }
      };

      // Pre-deploy DNS gate (custom domains): surface the records to add
      // or auto-configure BEFORE the deploy so DNS is pointed when the first-deploy
      // SSL attempt runs.
      const pendingDnsTargets = appInstallDnsTargets(routes ?? []);
      if (pendingDnsTargets.length > 0) {
        const projectInfo = await projectsApi.getInfo(pid).catch(() => null);
        const domainRows = Array.isArray(projectInfo?.data?.project?.domains)
          ? projectInfo.data.project.domains
          : [];
        const dnsTargets = attachDeploymentDomainIds(pendingDnsTargets, domainRows);
        if (dnsTargets.length > 0) {
          const confirmed = await confirmInstall(
            (confirm, cancel) => (
              <DnsRecordsModal
                targets={dnsTargets}
                serverId={destination?.serverId}
                confirmLabel={w.install}
                onConfirm={confirm}
                onCancel={cancel}
              />
            ),
            "560px",
          );
          if (!confirmed) return;
        }
      }

      await startDeploy(pid);
    } catch (err) {
      if (!started && showCloudPricing(err)) return;
      // Strip the server's "Pre-deploy checks failed:" prefix for a cleaner
      // message. Nothing deployed yet → toast + stay on the form; a deploy that
      // already started keeps the log-bearing error card (with build details).
      const msg = getApiErrorMessage(err, w.installFailed).replace(
        /^Pre-deploy checks failed:\s*/i,
        "",
      );
      if (started) {
        setErrorMsg(msg);
        setPhase("error");
      } else {
        showToast(msg, "error");
      }
    }
  });

  /** Advanced escape: hand off to the technical wizard, reusing an adopted /
   *  already-created draft so we never create a duplicate project. The routing
   *  picked so far travels with the create write — the /deploy wizard then edits
   *  real stored routes instead of ones the server guessed. */
  const goAdvanced = withSubmission(async () => {
    if (!destinationReady) return;
    const routes = await validatedRouteChoices();
    if (!routes) return;
    try {
      const pid = adoptedProjectId ?? projectId;
      if (pid) {
        await applyDraftRouting(pid, routes);
        router.push(`/deploy/${encodeProjectSlug(pid)}`);
        return;
      }
      const res = await appsApi.install({
        templateId: appId,
        serverId: destination?.serverId,
        name: appName.trim() || undefined,
        routes,
      });
      const data = res.data;
      if (data.kind === "template") {
        router.push(`/deploy/${encodeProjectSlug(data.projectId)}`);
      }
    } catch (err) {
      showToast(getApiErrorMessage(err, w.installFailed), "error");
    }
  });

  // ── Progress / done / error states (shared clean progress view) ────────────
  if (phase === "installing" || phase === "done" || phase === "error") {
    // Authored install-setup step copy for the stepper sub-list, and the app's
    // default first-login creds for the done screen — both from the app JSON.
    const appSetupSteps = getAppPrepareSteps(template).map((s) => ({
      id: s.capture,
      label: resolveLocalized(s.title, locale) || s.capture,
    }));
    const fl = getAppFirstLogin(template);
    const firstLogin = fl
      ? {
          username: resolveLocalized(fl.username, locale) || undefined,
          password: resolveLocalized(fl.password, locale) || undefined,
          note: resolveLocalized(fl.note, locale) || undefined,
        }
      : undefined;
    // Leaving the progress view (Retry / Back to form): drop the persisted
    // deployment id so a subsequent refresh doesn't resume a finished/failed run.
    const resetToForm = () => {
      activeDeployment.current = null;
      settledRef.current = false;
      setPhases({});
      setServices([]);
      setLogs("");
      setProgress(0);
      setLiveUrl(null);
      setErrorMsg("");
      setCloudFailure(null);
      setDeploymentId(null);
      setCancelled(false);
      setStartedAt(null);
      try {
        const url = new URL(window.location.href);
        url.searchParams.delete("deployment");
        window.history.replaceState(null, "", url.toString());
      } catch {
        /* non-fatal */
      }
      setPhase("form");
    };

    // What this install was configured WITH — the aside's read-out, and the thing
    // an operator can't get from the stepper or the logs. Every row is read from
    // the pickers' own state, so it shows the configuration that was sent, never
    // one re-derived from the template. A value this view can't know (the
    // destination after a mid-install refresh — only the routing pickers
    // rehydrate) is left out rather than guessed.
    const summary: DeploySummaryRow[] = [];
    const destinationValue = destination?.serverName || (
      destination?.deployTarget === "cloud"
        ? t.deploy.targetStep.options.cloud
        : (destination?.serverHost || ""));
    if (destinationValue) {
      summary.push({
        id: "destination",
        label: w.summaryDestination,
        value: destinationValue,
        mono: destination?.deployTarget === "server" && !destination.serverName,
      });
    }
    for (const e of appEndpoints) {
      const st = expo[endpointKey(e)];
      if (!st) continue;
      const id = `ep-${endpointKey(e)}`;
      const hostPort = hostPortForEndpoint(template.services, e);
      if (st.kind === "http" && st.mode === "domain") {
        // The hostname the install will actually write — same resolver the
        // routing payload uses, seeded with the same default label.
        const host = resolvePublicEndpointHostname(
          {
            domainType: st.ep.domainType,
            domain: st.ep.domain.trim() ? normalizeServiceLabel(st.ep.domain) : defaultFreeLabel(e),
            customDomain: normalizeCustomHostname(st.ep.customDomain),
          },
          baseDomain,
        );
        if (host) summary.push({ id, label: e.label, value: host, mono: true });
      } else if (st.kind === "tcp" && st.mode === "internal") {
        summary.push({ id, label: e.label, value: w.tcpInternalLabel });
      } else {
        // Port-only web, or a published database port: the reachable HOST port.
        summary.push({
          id,
          label: e.label,
          value: destination?.serverHost ? `${destination.serverHost}:${hostPort}` : `:${hostPort}`,
          mono: true,
        });
      }
    }
    const serviceCount = template.services?.length ?? 0;
    if (serviceCount > 0) {
      summary.push({ id: "services", label: w.summaryServices, value: String(serviceCount) });
    }
    for (const req of requires) {
      const sourceName = candidates.find((p) => p.id === connChoices[req.id])?.name;
      if (sourceName) {
        summary.push({
          id: `req-${req.id}`,
          label: resolveLocalized(req.label, locale),
          value: sourceName,
        });
      }
    }
    // The business fields the operator filled in. Secrets are never shown, and a
    // boolean is skipped rather than rendered as a bare "true"; capped so a
    // settings-heavy app doesn't push the actions off a short viewport.
    const fieldValueOf = (service: string, key: string) => values[fk(service, key)];
    for (const f of installFields) {
      if (summary.length >= 10) break;
      if (f.secret || f.type === "boolean" || !isFieldVisible(f, fieldValueOf)) continue;
      const raw = values[fk(f.service, f.key)];
      if (typeof raw !== "string" || raw.trim() === "") continue;
      summary.push({
        id: `set-${f.service}-${f.key}`,
        label: f.label,
        value: f.options?.find((o) => o.value === raw)?.label ?? raw.trim(),
      });
    }
    if (declaresResources) {
      const needs = [
        template.minResources?.memoryMb
          ? interpolate(w.needsMemory, { value: formatMemoryMb(template.minResources.memoryMb) })
          : null,
        template.minResources?.cpuCores ? formatCpuCores(template.minResources.cpuCores) : null,
      ]
        .filter(Boolean)
        .join(" · ");
      if (needs) summary.push({ id: "resources", label: w.needsTitle, value: needs });
    }

    return (
      <CleanDeployProgressCard
        appId={appId}
        title={template.name}
        description={template.description}
        phase={phase}
        progress={progress}
        phaseLabel={phaseLabel}
        liveUrl={liveUrl}
        logs={logs}
        errorMsg={errorMsg}
        deploymentId={deploymentId}
        phases={phases}
        services={services}
        appSetupSteps={appSetupSteps}
        firstLogin={firstLogin}
        summary={summary}
        startedAt={startedAt}
        connect={
          projectId
            ? {
                projectId,
                appTemplateId: appId,
                serverId: destination?.deployTarget === "server" ? destination.serverId : null,
                deployTarget: destination?.deployTarget ?? null,
              }
            : undefined
        }
        onGoToProject={() => projectId && router.push(`/projects/${projectId}`)}
        onViewBuild={() => deploymentId && router.push(`/build/${deploymentId}`)}
        onRetry={resetToForm}
        recoveryAction={cloudFailure ? {
          label: cloudFailure.status === 409 ? t.billing.capacityEditor.title : t.billing.deployGate.manageBilling,
          pending: busy,
          onClick: () => { showCloudPricing(cloudFailure, retryDeployment); },
        } : undefined}
        onStop={stopInstall}
        isStopping={isStopping}
        cancelled={cancelled}
      />
    );
  }

  // ── Form state ────────────────────────────────────────────────────────────
  const singleSettingsCard = template.installLayout?.settings === "single";
  const splitSettingsCards = template.installLayout?.settings === "split";
  // Existing drafts keep their project name. The same field is used in the
  // standalone card and catalog-authored layouts.
  const nameField = !adoptedProjectId && (
    <div className="min-w-0">
      <label htmlFor="app-name" className="block text-sm font-medium text-foreground">
        {w.nameLabel}
      </label>
      <Input
        id="app-name"
        type="text"
        value={appName}
        disabled={busy}
        onChange={(e) => setAppName(e.target.value)}
        placeholder={template.name}
        variant="filled"
        className="mt-2"
      />
      <p className="mt-1.5 text-xs text-muted-foreground">{w.nameHint}</p>
      {openDraft && targetDraftId === openDraft.projectId && (
        <p className="mt-2 text-xs text-warning">
          You already have a not-yet-deployed “{openDraft.name}”. Installing with this
          name updates it — the options below are the ones it was configured with.
          Change the name to install a separate copy.
        </p>
      )}
    </div>
  );

  return (
    <PageContainer outerClassName="pb-20">
      <div className="@container/app-install">
        {/* Back to the app catalog */}
        <button
          type="button"
          onClick={() => router.push("/apps/new")}
          className="mb-4 inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          <UiIcon name="arrow-left" className="size-4 rtl:rotate-180" />
          {w.back}
        </button>

        {/* Header. The caveats that used to sit under this as two full-width
            yellow banners now hang off the chips beside the name — see
            HostingBadge / UnverifiedBadge. `shrink-0` on the logo tile is
            load-bearing: it's a flex child next to a multi-line description, so
            without it the 48px tile gets squeezed narrower than it is tall, and the
            image inside — itself a row flex item, so also shrinkable — narrows with
            it and the mark reads as stretched. (`AppLogo` already applies
            `object-contain`; the fix is the box, not the fit.) */}
        <div className="flex items-center gap-4">
          <div className="flex size-12 shrink-0 items-center justify-center rounded-2xl bg-muted/60">
            <AppLogo appId={appId} className="size-7" />
          </div>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-xl font-semibold text-foreground">{template.name}</h1>
              {template.verified && <VerifiedBadge iconClassName="size-[18px]" />}
              <HostingBadge hosting={template.hosting} />
              {template.custom && <UnverifiedBadge />}
            </div>
            <p
              ref={descRef}
              className={`text-sm text-muted-foreground ${descExpanded ? "" : "line-clamp-2"}`}
            >
              {template.description}
            </p>
            {(descClamped || descExpanded) && (
              <button
                type="button"
                onClick={() => setDescExpanded((v) => !v)}
                className="mt-0.5 text-xs font-medium text-muted-foreground/80 transition-colors hover:text-foreground"
              >
                {descExpanded ? w.descLess : w.descMore}
              </button>
            )}
          </div>
        </div>

        {/* Two columns: what the app needs (left) + where it goes & the deploy
            action (right, sticky). Mirrors the deploy wizard's config/sidebar
            split so the destination switch + Deploy button live together. */}
        <div className="mt-6 grid grid-cols-1 items-start gap-6 @5xl/app-install:grid-cols-[minmax(0,1fr)_340px]">
          {/* LEFT — business settings + public URL */}
          <div className="min-w-0 space-y-5">
            {(nameField || installFields.length > 0) && (
              <div
                className={
                  splitSettingsCards
                    ? "grid grid-cols-[repeat(auto-fit,minmax(min(100%,18rem),1fr))] gap-5"
                    : "space-y-5"
                }
              >
                {!singleSettingsCard && nameField && (
                  <div className="rounded-2xl bg-card p-5">{nameField}</div>
                )}

                {(installFields.length > 0 || (singleSettingsCard && nameField)) && (
                  <AppSettingsForm
                    groups={groups}
                    values={values}
                    onChange={setField}
                    secretSetLabel={t.projectSettings.appSettings.secretSet}
                    showAdvanced
                    filter={isInstallField}
                    flat={template.installLayout?.settings !== "grouped"}
                    columns={template.installLayout?.columns}
                    leadingContent={singleSettingsCard ? nameField : undefined}
                    title={splitSettingsCards ? undefined : t.projectSettings.appSettings.modeApp}
                    onValidityChange={setFormValidity}
                  />
                )}
              </div>
            )}

            {/* Declared connections — this app needs a value (e.g. DATABASE_URL)
                from another app you've installed. Pick a source per requirement;
                wired in one shot after install. Inert when the app declares none. */}
            {requires.length > 0 && (
              <div className="rounded-2xl border border-border/50 bg-card p-5">
                <h3 className="text-sm font-semibold text-foreground">Connect services</h3>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  This app connects to other apps you&apos;ve installed. Pick a source for each.
                </p>
                <div className="mt-4 space-y-4">
                  {requires.map((req) => {
                    const opts = candidatesFor(req.category);
                    return (
                      <div key={req.id}>
                        <label className="text-sm font-medium text-foreground">
                          {resolveLocalized(req.label, locale)}
                          {!req.optional && <span className="ms-0.5 text-danger">*</span>}
                        </label>
                        <select
                          className="mt-2 w-full rounded-xl border border-border/50 bg-background px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/25"
                          value={connChoices[req.id] ?? ""}
                          onChange={(e) =>
                            setConnChoices((p) => ({ ...p, [req.id]: e.target.value }))
                          }
                        >
                          <option value="">{req.optional ? "None" : "Select an app…"}</option>
                          {opts.map((p) => (
                            <option key={p.id} value={p.id}>
                              {p.name}
                            </option>
                          ))}
                        </select>
                        {opts.length === 0 && (
                          <p className="mt-1.5 text-xs text-warning">
                            No matching app installed yet — install one first, then connect.
                          </p>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Routing — asked per endpoint. Web endpoints get the domain flow
                (or port-only); databases (raw TCP) publish a port (firewall) or
                stay internal. Reuses the deploy wizard's routing core. */}
            {needsExposure && (
              <div className="@container/app-routes rounded-2xl bg-card p-5">
                <h3 className="text-sm font-semibold text-foreground">{w.exposeTitle}</h3>
                <fieldset
                  disabled={routeControlsDisabled}
                  className="mt-4 grid min-w-0 grid-cols-1 items-start gap-4 @min-[38rem]/app-routes:grid-cols-2"
                >
                  {appEndpoints.map((e) => {
                    const key = endpointKey(e);
                    const st = expo[key];
                    if (!st) {
                      return (
                        <div
                          key={key}
                          aria-busy="true"
                          className="h-48 animate-pulse rounded-xl bg-muted/40"
                        />
                      );
                    }
                    const modes = getAppEndpointModes(e);
                    return (
                      <section
                        key={key}
                        aria-labelledby={`endpoint-${key}`}
                        className="min-w-0 space-y-3 rounded-xl bg-card p-4"
                      >
                        <div className="flex items-center justify-between gap-3">
                          <h4
                            id={`endpoint-${key}`}
                            title={e.label}
                            className="min-w-0 truncate text-sm font-medium text-foreground"
                          >
                            {e.label}
                          </h4>
                          <span className="shrink-0 rounded-md bg-muted/60 px-2 py-1 text-xs text-muted-foreground">
                            {e.kind === "http" ? w.httpBadge : w.tcpBadge}
                            <span className="ms-1.5 font-mono">{e.port}</span>
                          </span>
                        </div>

                        <CustomSelect
                          aria-label={`${e.label}: ${w.exposeTitle}`}
                          value={st.mode}
                          options={modes.map((value) => ({ value, ...exposureModeLabels[value] }))}
                          onChange={(mode) => setExpoMode(key, mode)}
                          variant="filled"
                          triggerClassName="bg-muted/60 hover:bg-muted"
                          disabled={routeControlsDisabled || modes.length < 2}
                        />

                        {st.kind === "http" ? (
                          <>
                            {/* One editor per declared route; the template owns the ports. */}
                            {st.mode === "domain" && (
                              <div>
                                <RoutingSettingsCard
                                  disabled={routeControlsDisabled}
                                  /* The DEFAULT free label for THIS route — the card
                                     previews it, and the installer writes exactly it
                                     when the slug is left blank. */
                                  projectName={defaultFreeLabel(e)}
                                  domain={st.ep.domain}
                                  customDomain={st.ep.customDomain}
                                  domainType={st.ep.domainType}
                                  onDomainChange={(domain) => setExpoEp(key, { domain })}
                                  onCustomDomainChange={(customDomain) =>
                                    setExpoEp(key, { customDomain })
                                  }
                                  onDomainTypeChange={(domainType) =>
                                    setExpoEp(key, { domainType })
                                  }
                                />
                                {st.ep.domainType === "free" && !cloudConnected && (
                                  <p className="mt-2 text-xs text-warning">
                                    {w.routeFreeNeedsCloud}
                                  </p>
                                )}
                                {st.ep.domainType === "custom" &&
                                  st.ep.customDomain.trim() !== "" &&
                                  !isValidCustomHostname(
                                    normalizeCustomHostname(st.ep.customDomain),
                                  ) && (
                                    <p className="mt-2 text-xs text-danger">
                                      Enter a hostname like app.example.com — no scheme, port or
                                      path.
                                    </p>
                                  )}
                              </div>
                            )}
                            {st.mode === "port" && (
                              <p className="text-xs leading-relaxed text-muted-foreground">
                                {cloudDestination ? w.routePortCloudDesc : w.routePortDesc}
                                {isDesktop && !cloudDestination && <> {w.desktopReachNote}</>}
                              </p>
                            )}
                          </>
                        ) : (
                          <>
                            {st.mode === "publish" && (
                              <p className="text-xs leading-relaxed text-warning">
                                {interpolate(w.tcpFirewallNote, { port: String(e.port) })}
                              </p>
                            )}
                            {st.mode === "internal" && (
                              <p className="text-xs leading-relaxed text-muted-foreground">
                                {w.tcpInternalDesc}
                                {isDesktop && !cloudDestination && <> {w.desktopReachNote}</>}
                              </p>
                            )}
                          </>
                        )}
                      </section>
                    );
                  })}
                </fieldset>
              </div>
            )}
          </div>

          {/* RIGHT — destination + deploy action (sticky) */}
          <div className="min-w-0 space-y-4 @5xl/app-install:sticky @5xl/app-install:top-6">
            {/* Destination — where to install (reuses the deploy target picker) */}
            <div className="rounded-2xl bg-card p-5">
              <h3 className="text-sm font-semibold text-foreground">{w.destinationTitle}</h3>
              {selfHosted && (
                <p className="mt-0.5 text-xs text-muted-foreground">{w.destinationHint}</p>
              )}

              {/* State the app's own floor before the picker, so the choice is
                  informed rather than corrected afterwards. */}
              {declaresResources && (
                <p className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground">
                  <UiIcon name="cpu" className="size-3.5 shrink-0" />
                  <span className="font-medium text-foreground">{w.needsTitle}:</span>
                  {[
                    template.minResources?.memoryMb
                      ? interpolate(w.needsMemory, {
                          value: formatMemoryMb(template.minResources.memoryMb),
                        })
                      : null,
                    template.minResources?.cpuCores
                      ? interpolate(w.needsCpu, {
                          value: formatCpuCores(template.minResources.cpuCores),
                        })
                      : null,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </p>
              )}

              <div className="mt-4">
                <AppDestinationPicker
                  value={destination}
                  onChange={setDestination}
                  onReadyChange={setDestinationReady}
                  readOnly={!!targetDraftId || !!projectId}
                  disabled={busy || !!targetDraftId || !!projectId}
                  disabledReason={targetDraftId || projectId ? t.billing.workspaces.savedDestinationHint : undefined}
                />
              </div>

              {/* Declared minimum vs. the destination's measured capacity. Shown
                  only on a real shortfall — an unmeasurable box reports "unknown",
                  which is never one. */}
              {needsCloudUpgrade && (
                <div
                  role="status"
                  className="mt-4 space-y-2 rounded-xl bg-warning/10 px-3.5 py-3 text-sm"
                >
                  <p className="font-medium text-warning">{w.cloudFitTitle}</p>
                  <p className="text-xs leading-relaxed text-muted-foreground">
                    {hostFit?.cloud?.message}
                  </p>
                  <button
                    type="button"
                    onClick={() => setCapacityRevision((value) => value + 1)}
                    disabled={capacityLoading || busy}
                    className="inline-flex items-center gap-1.5 rounded-lg text-xs font-medium text-foreground hover:underline focus-visible:outline-primary disabled:opacity-50"
                  >
                    <UiIcon name="refresh" className="size-3.5" />
                    {w.checkCapacityAgain}
                  </button>
                </div>
              )}
              {hostFit?.cloud?.status === "unavailable" && (
                <p role="status" className="mt-3 text-xs text-muted-foreground">
                  {w.cloudFitUnavailable}
                </p>
              )}
              {hostFit && !hostFit.fit.ok && (
                <div className="mt-4 flex items-start gap-2.5 rounded-xl bg-warning/10 px-3.5 py-3 text-xs text-warning">
                  <UiIcon name="warning" className="mt-0.5 size-4 shrink-0" />
                  <div className="space-y-1">
                    <p className="font-semibold">
                      {interpolate(w.hostFitTitle, { app: template.name })}
                    </p>
                    {hostFit.fit.memory && (
                      <p>
                        {interpolate(w.hostFitMemory, {
                          needed: formatMemoryMb(hostFit.fit.memory.needed),
                          available: formatMemoryMb(hostFit.fit.memory.available),
                        })}
                      </p>
                    )}
                    {hostFit.fit.cpu && (
                      <p>
                        {interpolate(w.hostFitCpu, {
                          needed: formatCpuCores(hostFit.fit.cpu.needed),
                          available: formatCpuCores(hostFit.fit.cpu.available),
                        })}
                      </p>
                    )}
                    <p className="text-warning/80">{w.hostFitHint}</p>
                  </div>
                </div>
              )}
            </div>

            {/* Actions */}
            <div className="space-y-2">
              {configurationNotice}
              {needsCloudUpgrade ? (
                <a
                  href={workspaceBillingHref("/billing/plans", destination?.workspaceId)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-primary px-5 py-3 text-sm font-medium text-primary-foreground hover:bg-primary/90 focus-visible:outline-primary"
                >
                  {w.upgradePlan}
                  <UiIcon name="arrow-up-right" className="size-4" />
                </a>
              ) : (
                <button
                  type="button"
                  onClick={install}
                  disabled={
                    busy ||
                    !destinationReady ||
                    checkingCloudCapacity ||
                    !exposureReady ||
                    (formValidity ? !formValidity.valid : false)
                  }
                  className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-primary px-5 py-3 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {busy ? (
                    <UiIcon name="spinner" className="size-4 animate-spin" />
                  ) : (
                    <UiIcon name="arrow-right" className="size-4 rtl:rotate-180" />
                  )}
                  {checkingCloudCapacity ? w.checkingCapacity : w.install}
                </button>
              )}
              <button
                type="button"
                onClick={goAdvanced}
                disabled={busy || !exposureReady || !destinationReady}
                className="inline-flex w-full items-center justify-center gap-2 rounded-xl py-2.5 text-sm font-medium text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground disabled:opacity-50"
              >
                <UiIcon name="sliders" className="size-4" /> {w.advanced}
              </button>
            </div>
          </div>
        </div>
      </div>
    </PageContainer>
  );
}
