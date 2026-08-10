"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import {
  Loader2,
  ArrowRight,
  ArrowLeft,
  SlidersHorizontal,
  Network,
  Globe,
  Lock,
  AlertTriangle,
} from "lucide-react";
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
  isValidCustomHostname,
  normalizeCustomHostname,
  normalizeServiceLabel,
  slugify,
  type AppSettingField,
  type AppEndpoint,
  type InstallPhaseId,
  type InstallPhaseStatus,
} from "@repo/core";
import { appsApi, deployApi, servicesApi, projectsApi } from "@/lib/api";
import type { InstallAppRoute } from "@/lib/api/apps";
import { type Service } from "@/lib/api/services";
import { connectionsApi } from "@/lib/api/connections";
import { getApiErrorMessage } from "@/lib/api/client";
import {
  AppSettingsForm,
  fk,
  type FormValue,
  type FormValidity,
} from "@/components/app-settings/AppSettingsForm";
import {
  AppDestinationPicker,
  type AppDestination,
} from "@/components/deploy/AppDestinationPicker";
import PublicEndpointsCard from "@/components/routing/PublicEndpointsCard";
import { createPublicEndpoint, type PublicEndpoint } from "@/context/deployment/types";
import { resolvePublicEndpointHostname } from "@/lib/public-endpoint-payload";
import {
  CleanDeployProgressCard,
  firstPublicHost,
} from "@/components/deploy/CleanDeployProgress";
import { useBuildStream } from "@/hooks/useSSEConnection";
import type { ServiceStatusEvent } from "@/lib/sseMessageProcessors";
import { useToast } from "@/context/ToastContext";
import { useI18n, interpolate } from "@/components/i18n-provider";
import { usePlatform } from "@/context/PlatformContext";
import { useCloud } from "@/context/CloudContext";
import { defaultDomainType } from "@/lib/default-domain-type";
import { OptionCard } from "@/app/(dashboard)/(deployment)/deploy/[slug]/components/DeployTargetStep";
import { AppLogo } from "@/components/AppLogo";
import { VerifiedBadge } from "@/components/apps/VerifiedBadge";
import { PageContainer } from "@/components/ui/PageContainer";
import { encodeProjectSlug } from "@/utils/repoSlug";
import { parseContainerPort } from "@/utils/compose-ports";

/**
 * Dedicated app-install wizard — a CLEAN business-only wrapper over the existing
 * deploy pipeline. No ports/services/routes/logs: the app's template defines
 * what to ask (install-step business fields + whether it needs a public URL);
 * the template's known ports drive routing. It's a pure client orchestration of
 * existing endpoints — install → apply settings + domain → buildAccess — with a
 * JSON-mapped progress view: it ATTACHES to the running build over SSE and maps
 * the real backend phase/service boundaries onto an authored stepper, with logs
 * demoted to a foldable detail. "Advanced" hands off to the technical /deploy
 * wizard.
 */

type Phase = "form" | "installing" | "done" | "error";

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
 * Per-endpoint exposure choice, keyed by `${service}:${port}`.
 *  http: mode port|domain — free-vs-custom is chosen inside the domain detail
 *        (the PublicEndpointsCard toggle), so it's not duplicated as a mode.
 *  tcp:  mode publish|internal.
 */
type Expo =
  | { kind: "http"; mode: "port" | "domain"; ep: PublicEndpoint }
  | { kind: "tcp"; mode: "publish" | "internal" };

/**
 * The picker's starting state for one endpoint: the author's `defaultMode` when
 * valid for the kind, else port-only — which invents nothing.
 *
 * Cloud being CONNECTED used to pre-select `domain`, so on a Cloud instance an
 * operator who touched nothing got *.opsh.io hostnames "by choice". Connectivity
 * is a capability, not an intent. `defaultDomainType` still decides free-vs-custom
 * for the moment the operator does switch to a domain (free needs Cloud).
 */
function defaultExpo(e: AppEndpoint, cloudConnected: boolean): Expo {
  if (e.kind === "http") {
    const mode = e.defaultMode === "domain" || e.defaultMode === "port" ? e.defaultMode : "port";
    return {
      kind: "http",
      mode,
      ep: createPublicEndpoint({ domainType: defaultDomainType(cloudConnected) }),
    };
  }
  const mode = e.defaultMode === "internal" || e.defaultMode === "publish" ? e.defaultMode : "publish";
  return { kind: "tcp", mode };
}

/** One stored/desired public route on a service row (the `publicEndpoints` shape). */
type StoredRoute = {
  port: number;
  domainType: "free" | "custom";
  domain?: string;
  customDomain?: string;
};

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
  const { baseDomain, deployMode } = usePlatform();
  // Desktop mode → the "open on localhost / forward the port" hints are relevant
  // (a VPS is already public; a local app is already localhost).
  const isDesktop = deployMode === "desktop";
  // Free .opsh.io routing needs Openship Cloud; when it's not connected we
  // default the install to a port-only (no-domain) deploy instead of letting
  // preflight hard-fail. Forced true on SaaS/native (CloudContext).
  const { connected: cloudConnected, requireCloud } = useCloud();

  const appId = String(params?.appId ?? "");
  const searchParams = useSearchParams();
  // Reopening a draft app passes its existing project id — adopt it instead of
  // creating a duplicate (the backend also get-or-creates, this avoids the call).
  const adoptedProjectId = searchParams.get("projectId");
  // A deploy already in flight, carried in the URL (written the moment we enter
  // `installing`) so a hard refresh mid-install RESUMES the progress view —
  // re-attaching to the same SSE stream — instead of dropping back to the form.
  const resumeDeploymentId = searchParams.get("deployment");
  // Bundled template is the instant fallback; the runtime catalog (overlay-fresh
  // from the API) is fetched so a repo-fresh app opens + installs without a redeploy.
  const bundledTemplate = useMemo(() => getAppTemplate(appId), [appId]);
  const [template, setTemplate] = useState(bundledTemplate);
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
    let cancelled = false;
    appsApi
      .template(appId)
      .then((r) => {
        if (cancelled) return;
        if (r?.data) setTemplate(r.data);
        setOpenDraft(r?.draft ?? null);
      })
      .catch(() => {
        /* keep the bundled template */
      });
    return () => {
      cancelled = true;
    };
  }, [appId, bundledTemplate]);
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

  const [values, setValues] = useState<Record<string, FormValue>>(() => {
    const seed: Record<string, FormValue> = {};
    for (const f of installFields) seed[fk(f.service, f.key)] = envToSettingValue(f, undefined);
    return seed;
  });
  const [expo, setExpo] = useState<Record<string, Expo>>(() => {
    const out: Record<string, Expo> = {};
    for (const e of appEndpoints) out[endpointKey(e)] = defaultExpo(e, cloudConnected);
    return out;
  });
  // The runtime (overlay-fresh) template can declare endpoints the bundled one
  // didn't, and those arrive AFTER the state above was seeded — fill any missing
  // picker so what the wizard renders is what the install sends.
  useEffect(() => {
    setExpo((prev) => {
      const missing = appEndpoints.filter((e) => !prev[endpointKey(e)]);
      if (missing.length === 0) return prev;
      const next = { ...prev };
      for (const e of missing) next[endpointKey(e)] = defaultExpo(e, cloudConnected);
      return next;
    });
  }, [appEndpoints, cloudConnected]);
  // Author can restrict the exposure choices offered per endpoint via `allowedModes`.
  const modeAllowed = (e: AppEndpoint, mode: NonNullable<AppEndpoint["defaultMode"]>) =>
    !e.allowedModes || e.allowedModes.includes(mode);
  const setExpoMode = (key: string, mode: Expo["mode"]) =>
    setExpo((p) => (p[key] ? { ...p, [key]: { ...p[key], mode } as Expo } : p));
  const setExpoEp = (key: string, ep: PublicEndpoint) =>
    setExpo((p) => {
      const cur = p[key];
      return cur?.kind === "http" ? { ...p, [key]: { ...cur, ep } } : p;
    });
  const [destination, setDestination] = useState<AppDestination | null>(null);
  // Project name shown in Openship. Editable for a fresh install (a second
  // install of the same app auto-suffixes server-side, e.g. "Convex 2"); hidden
  // when reopening an existing draft, which already has its name.
  const [appName, setAppName] = useState(() => template?.name ?? "");

  const [phase, setPhase] = useState<Phase>(resumeDeploymentId ? "installing" : "form");
  const [busy, setBusy] = useState(false);
  // A Stop request is in flight (the cancel POST + teardown). Disables the Stop
  // button. `cancelled` records that the terminal `error` phase was a user Stop,
  // not a failure — the progress view swaps to neutral "cancelled" copy.
  const [isStopping, setIsStopping] = useState(false);
  const [cancelled, setCancelled] = useState(false);
  const [deploymentId, setDeploymentId] = useState<string | null>(resumeDeploymentId);
  const [projectId, setProjectId] = useState<string | null>(adoptedProjectId);
  const [progress, setProgress] = useState(0);
  const [phaseLabel, setPhaseLabel] = useState("");
  const [liveUrl, setLiveUrl] = useState<string | null>(null);
  const [logs, setLogs] = useState("");
  const [errorMsg, setErrorMsg] = useState("");
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
    if (!template || template.kind === "flow" || !template.available) {
      router.replace("/apps/new");
    }
  }, [template, appId, router]);

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
  const [draftSlug, setDraftSlug] = useState<string | null>(null);
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
  const rehydratedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!targetDraftId || appEndpoints.length === 0) return;
    if (rehydratedRef.current === targetDraftId) return;
    rehydratedRef.current = targetDraftId;
    let cancelled = false;
    void (async () => {
      const [info, svcRes] = await Promise.all([
        projectsApi.getInfo(targetDraftId).catch(() => null),
        servicesApi.list(targetDraftId).catch(() => null),
      ]);
      if (cancelled) return;
      const project = info?.data?.project as { slug?: string; name?: string } | undefined;
      setDraftSlug(project?.slug ?? project?.name ?? null);
      const services = (svcRes?.services ?? []) as Service[];
      if (services.length > 0) {
        setExpo((prev) => ({ ...prev, ...rehydrateExpo(appEndpoints, services, cloudConnected) }));
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetDraftId, appEndpoints]);

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
   *  host:port (server host / localhost; cloud has no host binding → no link);
   *  domain → the persisted public host. Reads the SAME derivation the poll used. */
  const deriveLiveUrl = async (config?: {
    publicEndpoints?: Array<{ domain?: string; customDomain?: string; domainType?: string }>;
  }) => {
    const primaryState = primaryHttp ? expo[endpointKey(primaryHttp)] : undefined;
    if (primaryState?.kind === "http" && primaryState.mode === "port") {
      const host =
        destination?.deployTarget === "server"
          ? destination.serverHost
          : destination?.deployTarget === "local"
            ? "localhost"
            : null;
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
  const resolveTerminal = async (fallback: { ok: boolean; message?: string }) => {
    if (settledRef.current || !deploymentId) return;
    settledRef.current = true;
    let status = "";
    let s: any = {};
    try {
      const res = await deployApi.getBuildStatus(deploymentId);
      s = res?.data ?? res ?? {};
      status = s.deploymentStatus ?? s.status ?? "";
      // A cancelled deploy (user Stop, or resuming one) is a neutral outcome, not
      // a failure — flag it so the error screen reads as "cancelled".
      if (status === "cancelled") setCancelled(true);
      // Prefer the server's full accumulated log over the streamed fragments.
      if (typeof s.logs === "string" && s.logs.length >= logs.length) setLogs(s.logs);
    } catch {
      /* fall back to the SSE outcome below */
    }
    const failed = ["failed", "cancelled", "partial_failure", "action_required", "rejected"];
    if (status === "ready" || (status === "" && fallback.ok)) {
      await deriveLiveUrl(s?.config);
      setPhase("done");
    } else if (failed.includes(status) || (status === "" && !fallback.ok)) {
      setErrorMsg(s.failureMessage || fallback.message || w.installFailed);
      setPhase("error");
    } else {
      // Still not settled in the DB but SSE said it's over — trust the stream.
      if (fallback.ok) {
        await deriveLiveUrl(s?.config);
        setPhase("done");
      } else {
        setErrorMsg(fallback.message || w.installFailed);
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
      onFailure: (message) => void resolveTerminal({ ok: false, message }),
      onCanceled: (message) => {
        setCancelled(true);
        void resolveTerminal({ ok: false, message: message || w.installCancelled });
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
        if (
          ["ready", "failed", "cancelled", "partial_failure", "action_required", "rejected"].includes(
            status,
          )
        ) {
          await resolveTerminal({ ok: status === "ready", message: s.failureMessage });
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
      await resolveTerminal({ ok: false, message: w.installCancelled });
    } catch (err) {
      // The build likely already finished in the race — let the stream/terminal
      // read settle it, and undo the optimistic cancel flag.
      setCancelled(false);
      showToast(getApiErrorMessage(err, w.stopFailed), "error");
    } finally {
      setIsStopping(false);
    }
  };

  if (!template) return null;

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
  const applyDraftRouting = async (pid: string) => {
    const choices = routeChoices();
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
        exposed: publicEndpoints.length > 0,
        publicEndpoints,
        ...(publicEndpoints[0] ? { domainType: publicEndpoints[0].domainType } : {}),
      });
    }
  };

  /** The routing choice, gated exactly as the server gates it — a custom endpoint
   *  needs its hostname AND that hostname has to be a hostname, and a free one
   *  needs Openship Cloud (requireCloud pops the same connect modal the deploy
   *  wizard uses). Null = don't proceed.
   *
   *  The shape gate is not decoration: `myhost` / `host:8443` / `host/path` used to
   *  reach the API, fail deep inside the service write, and leave a project row
   *  behind with no services. */
  const validatedRouteChoices = async (): Promise<InstallAppRoute[] | null> => {
    const routes = routeChoices();
    if (routes.some((r) => r.mode === "custom" && !r.customDomain)) {
      showToast(w.customRequired, "error");
      return null;
    }
    const malformed = routes.find(
      (r) => r.mode === "custom" && !isValidCustomHostname(r.customDomain ?? ""),
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
    return routes;
  };

  const install = async () => {
    if (busy) return;
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
    const routes = await validatedRouteChoices();
    if (!routes) return;
    setBusy(true);
    setDeploymentId(null);
    setLogs("");
    // Reset the live stepper so a re-install starts from a clean slate.
    setPhases({});
    setServices([]);
    setProgress(0);
    setLiveUrl(null);
    setCancelled(false);
    settledRef.current = false;
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
        await applyDraftRouting(pid);
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

      const dep = await deployApi.buildAccess({
        projectId: pid,
        serviceDeploymentMode: "services",
        // Where to install — reuses the deploy wizard's target selection.
        // Undefined falls back to the project/meta default server-side.
        deployTarget: destination?.deployTarget,
        serverId: destination?.deployTarget === "server" ? destination.serverId : undefined,
      });
      const depId =
        dep?.data?.deployment_id ?? dep?.data?.deploymentId ?? dep?.deployment_id ?? null;
      setDeploymentId(depId);
      started = true;
      // Persist the deployment id in the URL so a hard refresh mid-install
      // resumes the progress view (re-attaches to the same SSE stream) instead
      // of dropping back to the form. Client-only; best-effort.
      if (depId) {
        try {
          const url = new URL(window.location.href);
          url.searchParams.set("deployment", depId);
          if (pid) url.searchParams.set("projectId", pid);
          window.history.replaceState(null, "", url.toString());
        } catch {
          /* resume just won't survive a reload */
        }
      }
      setPhaseLabel(w.phaseQueued);
      setPhase("installing");
    } catch (err) {
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
    } finally {
      setBusy(false);
    }
  };

  /** Advanced escape: hand off to the technical wizard, reusing an adopted /
   *  already-created draft so we never create a duplicate project. The routing
   *  picked so far travels with the create write — the /deploy wizard then edits
   *  real stored routes instead of ones the server guessed. */
  const goAdvanced = async () => {
    if (busy) return;
    const routes = await validatedRouteChoices();
    if (!routes) return;
    setBusy(true);
    try {
      const pid = adoptedProjectId ?? projectId;
      if (pid) {
        router.push(`/deploy/${encodeProjectSlug(pid)}`);
        return;
      }
      const res = await appsApi.install({ templateId: appId, routes });
      const data = res.data;
      if (data.kind === "template") {
        router.push(`/deploy/${encodeProjectSlug(data.projectId)}`);
      }
    } catch (err) {
      showToast(getApiErrorMessage(err, w.installFailed), "error");
      setBusy(false);
    }
  };

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
      settledRef.current = false;
      setPhases({});
      setServices([]);
      setLogs("");
      setProgress(0);
      setLiveUrl(null);
      setErrorMsg("");
      setDeploymentId(null);
      setCancelled(false);
      try {
        const url = new URL(window.location.href);
        url.searchParams.delete("deployment");
        window.history.replaceState(null, "", url.toString());
      } catch {
        /* non-fatal */
      }
      setPhase("form");
    };
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
        onStop={stopInstall}
        isStopping={isStopping}
        cancelled={cancelled}
      />
    );
  }

  // ── Form state ────────────────────────────────────────────────────────────
  return (
    <PageContainer outerClassName="pb-20">
      <div className="mx-auto max-w-5xl pt-6">
        {/* Back to the app catalog */}
        <button
          type="button"
          onClick={() => router.push("/apps/new")}
          className="mb-4 inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          <ArrowLeft className="size-4 rtl:rotate-180" />
          {w.back}
        </button>

        {/* Header */}
        <div className="flex items-center gap-4">
          <div className="flex size-12 items-center justify-center rounded-2xl bg-muted/60">
            <AppLogo appId={appId} className="size-7 object-contain" />
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h1 className="text-xl font-semibold text-foreground">{template.name}</h1>
              {template.verified && <VerifiedBadge iconClassName="size-[18px]" />}
            </div>
            <p className="text-sm text-muted-foreground">{template.description}</p>
          </div>
        </div>

        {/* Unverified (custom) apps: a plain-language trust warning before the form. */}
        {!template.verified && (
          <div className="mt-6 flex items-start gap-2.5 rounded-xl border border-warning/40 bg-warning/[0.05] px-4 py-3 text-sm text-warning">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" />
            <span>
              <span className="font-semibold">Custom app — not verified.</span> It deploys images you
              provided, not an official reviewed app. Review the definition and only install apps you trust.
            </span>
          </div>
        )}

        {/* Two columns: what the app needs (left) + where it goes & the deploy
            action (right, sticky). Mirrors the deploy wizard's config/sidebar
            split so the destination switch + Deploy button live together. */}
        <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-[1fr_360px]">
          {/* LEFT — business settings + public URL */}
          <div className="min-w-0 space-y-5">
            {/* Name — how the app appears in Openship. A fresh install can name
                it (a 2nd install of the same type auto-suffixes server-side);
                reopening a draft keeps its existing name, so hide it then. */}
            {!adoptedProjectId && (
              <div className="rounded-2xl border border-border/50 bg-card p-5">
                <label htmlFor="app-name" className="text-sm font-semibold text-foreground">
                  {w.nameLabel}
                </label>
                <p className="mt-0.5 text-xs text-muted-foreground">{w.nameHint}</p>
                <input
                  id="app-name"
                  type="text"
                  value={appName}
                  onChange={(e) => setAppName(e.target.value)}
                  placeholder={template.name}
                  className="mt-3 w-full rounded-xl border border-border/50 bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-2 focus:ring-primary/25"
                />
                {/* This name resolves to an existing, never-deployed draft — say so.
                    Install UPDATES that draft (its settings below are rehydrated
                    from it); rename to install a second, separate copy instead. */}
                {openDraft && targetDraftId === openDraft.projectId && (
                  <p className="mt-2 text-xs text-warning">
                    You already have a not-yet-deployed “{openDraft.name}”. Installing with this
                    name updates it — the options below are the ones it was configured with.
                    Change the name to install a separate copy.
                  </p>
                )}
              </div>
            )}

            {installFields.length > 0 && (
              <AppSettingsForm
                groups={groups}
                values={values}
                onChange={setField}
                secretSetLabel={t.projectSettings.appSettings.secretSet}
                showAdvanced
                filter={isInstallField}
                flat
                title={t.projectSettings.appSettings.modeApp}
                onValidityChange={setFormValidity}
              />
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

            {/* Exposure — asked per endpoint. Web endpoints get the domain flow
                (or port-only); databases (raw TCP) publish a port (firewall) or
                stay internal. Reuses the deploy wizard's routing core. */}
            {needsExposure && (
              <div className="rounded-2xl border border-border/50 bg-card p-5">
                <h3 className="text-sm font-semibold text-foreground">{w.exposeTitle}</h3>
                <div className="mt-4 space-y-6">
                  {appEndpoints.map((e) => {
                    const key = endpointKey(e);
                    const st = expo[key];
                    if (!st) return null;
                    return (
                      <div key={key}>
                        <div className="mb-2 flex items-center gap-2">
                          <span className="text-sm font-medium text-foreground">{e.label}</span>
                          <span className="rounded-full bg-muted/60 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/70">
                            {e.kind === "http" ? w.httpBadge : w.tcpBadge}
                          </span>
                          <span className="font-mono text-[11px] text-muted-foreground/50">
                            :{e.port}
                          </span>
                        </div>

                        {st.kind === "http" ? (
                          <div className="space-y-2">
                            {modeAllowed(e, "port") && (
                              <OptionCard
                                value="port"
                                selected={st.mode === "port"}
                                onSelect={() => setExpoMode(key, "port")}
                                icon={<Network className="size-4" />}
                                label={w.routePortLabel}
                                description={w.routePortDesc}
                              />
                            )}
                            {modeAllowed(e, "domain") && (
                              <OptionCard
                                value="domain"
                                selected={st.mode === "domain"}
                                onSelect={() => setExpoMode(key, "domain")}
                                icon={<Globe className="size-4" />}
                                label={w.routeDomainLabel}
                                description={w.routeDomainDesc}
                              />
                            )}
                            {/* Free-vs-custom + the domain/slug input live here only. */}
                            {st.mode === "domain" && (
                              <div className="mt-3">
                                <PublicEndpointsCard
                                  /* The DEFAULT free label for THIS route — the card
                                     previews it, and the installer writes exactly it
                                     when the slug is left blank. */
                                  projectName={defaultFreeLabel(e)}
                                  endpoints={[st.ep]}
                                  hasServer
                                  runtimePort={String(e.port)}
                                  allowPortEdit={false}
                                  hideHeader
                                  onChange={(eps) => eps[0] && setExpoEp(key, eps[0])}
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
                            {st.mode === "port" && isDesktop && (
                              <p className="mt-2 text-xs text-muted-foreground/70">
                                {w.desktopReachNote}
                              </p>
                            )}
                          </div>
                        ) : (
                          <div className="space-y-2">
                            {modeAllowed(e, "publish") && (
                              <OptionCard
                                value="publish"
                                selected={st.mode === "publish"}
                                onSelect={() => setExpoMode(key, "publish")}
                                icon={<Network className="size-4" />}
                                label={w.tcpPublishLabel}
                                description={w.tcpPublishDesc}
                              />
                            )}
                            {modeAllowed(e, "internal") && (
                              <OptionCard
                                value="internal"
                                selected={st.mode === "internal"}
                                onSelect={() => setExpoMode(key, "internal")}
                                icon={<Lock className="size-4" />}
                                label={w.tcpInternalLabel}
                                description={w.tcpInternalDesc}
                              />
                            )}
                            {st.mode === "publish" && (
                              <p className="mt-2 text-xs text-warning">
                                {interpolate(w.tcpFirewallNote, { port: String(e.port) })}
                              </p>
                            )}
                            {st.mode === "internal" && isDesktop && (
                              <p className="mt-2 text-xs text-muted-foreground/70">
                                {w.desktopReachNote}
                              </p>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>

          {/* RIGHT — destination + deploy action (sticky) */}
          <div className="space-y-4 lg:sticky lg:top-6 lg:self-start">
            {/* Destination — where to install (reuses the deploy target picker) */}
            <div className="rounded-2xl border border-border/50 bg-card p-5">
              <h3 className="text-sm font-semibold text-foreground">{w.destinationTitle}</h3>
              <p className="mt-0.5 text-xs text-muted-foreground">{w.destinationHint}</p>
              <div className="mt-4">
                <AppDestinationPicker value={destination} onChange={setDestination} />
              </div>
            </div>

            {/* Actions */}
            <div className="space-y-2">
              <button
                type="button"
                onClick={install}
                disabled={busy || (formValidity ? !formValidity.valid : false)}
                className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-primary px-5 py-2.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
              >
                {busy ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <ArrowRight className="size-4 rtl:rotate-180" />
                )}
                {busy ? w.installing : w.install}
              </button>
              <button
                type="button"
                onClick={goAdvanced}
                disabled={busy}
                className="inline-flex w-full items-center justify-center gap-2 rounded-xl py-2 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
              >
                <SlidersHorizontal className="size-3.5" /> {w.advanced}
              </button>
            </div>
          </div>
        </div>
      </div>
    </PageContainer>
  );
}
