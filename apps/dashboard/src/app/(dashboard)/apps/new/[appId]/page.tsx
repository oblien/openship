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
} from "lucide-react";
import {
  getAppTemplate,
  getAppSettings,
  getAppEndpoints,
  flattenSettingFields,
  envToSettingValue,
  settingToEnvValue,
  type AppSettingField,
  type AppEndpoint,
} from "@repo/core";
import { appsApi, deployApi, servicesApi } from "@/lib/api";
import { getApiErrorMessage } from "@/lib/api/client";
import { AppSettingsForm, fk, type FormValue } from "@/components/app-settings/AppSettingsForm";
import {
  AppDestinationPicker,
  type AppDestination,
} from "@/components/deploy/AppDestinationPicker";
import PublicEndpointsCard from "@/components/routing/PublicEndpointsCard";
import { createPublicEndpoint, type PublicEndpoint } from "@/context/deployment/types";
import {
  CleanDeployProgressCard,
  labelForStatus,
  firstPublicHost,
} from "@/components/deploy/CleanDeployProgress";
import { useToast } from "@/context/ToastContext";
import { useI18n, interpolate } from "@/components/i18n-provider";
import { usePlatform } from "@/context/PlatformContext";
import { useCloud } from "@/context/CloudContext";
import { OptionCard } from "@/app/(dashboard)/(deployment)/deploy/[slug]/components/DeployTargetStep";
import { AppLogo } from "@/components/AppLogo";
import { PageContainer } from "@/components/ui/PageContainer";
import { encodeProjectSlug } from "@/utils/repoSlug";

/**
 * Dedicated app-install wizard — a CLEAN business-only wrapper over the existing
 * deploy pipeline. No ports/services/routes/logs: the app's template defines
 * what to ask (install-step business fields + whether it needs a public URL);
 * the template's known ports drive routing. It's a pure client orchestration of
 * existing endpoints — install → apply settings + domain → buildAccess — with a
 * clean progress view (polling build status, no raw logs). "Advanced" hands off
 * to the technical /deploy wizard.
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

export default function AppInstallPage() {
  const params = useParams();
  const router = useRouter();
  const { t } = useI18n();
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
  // Reopening a draft app passes its existing project id — adopt it instead of
  // creating a duplicate (the backend also get-or-creates, this avoids the call).
  const adoptedProjectId = useSearchParams().get("projectId");
  // Bundled template is the instant fallback; the runtime catalog (overlay-fresh
  // from the API) is fetched so a repo-fresh app opens + installs without a redeploy.
  const bundledTemplate = useMemo(() => getAppTemplate(appId), [appId]);
  const [template, setTemplate] = useState(bundledTemplate);
  useEffect(() => {
    setTemplate(bundledTemplate);
    let cancelled = false;
    appsApi
      .template(appId)
      .then((r) => {
        if (!cancelled && r?.data) setTemplate(r.data);
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
  // `endpoints` derive one http endpoint per exposed service (unchanged behavior).
  const appEndpoints = useMemo(() => (template ? getAppEndpoints(template) : []), [template]);
  const needsExposure = appEndpoints.length > 0;
  // The endpoint whose URL headlines the "done" screen (first web endpoint).
  const primaryHttp = useMemo(() => appEndpoints.find((e) => e.kind === "http"), [appEndpoints]);

  const [values, setValues] = useState<Record<string, FormValue>>(() => {
    const seed: Record<string, FormValue> = {};
    for (const f of installFields) seed[fk(f.service, f.key)] = envToSettingValue(f, undefined);
    return seed;
  });
  // Per-endpoint exposure choice, keyed by `${service}:${port}`.
  //  http: mode port|domain — free-vs-custom is chosen inside the domain detail
  //        (the PublicEndpointsCard toggle), so it's not duplicated as a mode.
  //  tcp:  mode publish|internal.
  type Expo =
    | { kind: "http"; mode: "port" | "domain"; ep: PublicEndpoint }
    | { kind: "tcp"; mode: "publish" | "internal" };
  const [expo, setExpo] = useState<Record<string, Expo>>(() => {
    const out: Record<string, Expo> = {};
    for (const e of appEndpoints) {
      out[endpointKey(e)] =
        e.kind === "http"
          ? {
              kind: "http",
              // A domain defaults on when Cloud is connected (free subdomain);
              // otherwise start port-only (a domain still works via Custom).
              mode: cloudConnected ? "domain" : "port",
              ep: createPublicEndpoint({ domainType: "free" }),
            }
          : { kind: "tcp", mode: "publish" };
    }
    return out;
  });
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

  const [phase, setPhase] = useState<Phase>("form");
  const [busy, setBusy] = useState(false);
  const [deploymentId, setDeploymentId] = useState<string | null>(null);
  const [projectId, setProjectId] = useState<string | null>(adoptedProjectId);
  const [progress, setProgress] = useState(0);
  const [phaseLabel, setPhaseLabel] = useState("");
  const [liveUrl, setLiveUrl] = useState<string | null>(null);
  const [logs, setLogs] = useState("");
  const [errorMsg, setErrorMsg] = useState("");

  // Unknown / non-installable / flow apps don't belong here.
  useEffect(() => {
    if (!template || template.kind === "flow" || !template.available) {
      router.replace("/apps/new");
    }
  }, [template, appId, router]);

  // ── Clean progress poll (status only, never raw logs) ──────────────────────
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(() => {
    if (phase !== "installing" || !deploymentId) return;
    let stopped = false;
    const tick = async () => {
      try {
        const res = await deployApi.getBuildStatus(deploymentId);
        const s = res?.data ?? res ?? {};
        const status: string = s.deploymentStatus ?? s.status ?? "queued";
        setProgress(typeof s.progress === "number" ? s.progress : 0);
        setPhaseLabel(labelForStatus(status, w));
        if (typeof s.logs === "string") setLogs(s.logs);
        if (status === "ready") {
          // Headline URL = the primary web endpoint. Port-only → host:port
          // (server host / localhost; cloud has no host binding → no link);
          // domain → the assigned public host.
          const primaryState = primaryHttp ? expo[endpointKey(primaryHttp)] : undefined;
          if (primaryState?.kind === "http" && primaryState.mode === "port") {
            const host =
              destination?.deployTarget === "server"
                ? destination.serverHost
                : destination?.deployTarget === "local"
                  ? "localhost"
                  : null;
            // Port-only reachability is the PUBLISHED host port, not the
            // container port (they differ when the template remaps, e.g. 8203:80).
            const reachablePort = primaryHttp
              ? hostPortForEndpoint(template?.services, primaryHttp)
              : 0;
            setLiveUrl(host && primaryHttp ? `http://${host}:${reachablePort}` : null);
          } else if (primaryState?.kind === "http") {
            setLiveUrl(firstPublicHost(s?.config?.publicEndpoints, baseDomain));
          } else {
            setLiveUrl(null);
          }
          setPhase("done");
        } else if (["failed", "cancelled", "partial_failure", "rejected"].includes(status)) {
          setErrorMsg(s.failureMessage || w.installFailed);
          setPhase("error");
        }
      } catch {
        /* transient — keep polling */
      }
    };
    void tick();
    pollRef.current = setInterval(() => {
      if (!stopped) void tick();
    }, 2000);
    return () => {
      stopped = true;
      if (pollRef.current) clearInterval(pollRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, deploymentId, baseDomain]);

  if (!template) return null;

  const setField = (f: AppSettingField, v: FormValue) =>
    setValues((prev) => ({ ...prev, [fk(f.service, f.key)]: v }));

  /** Business-field changes vs the template defaults → the settings to persist. */
  const settingChanges = () => {
    const out: { service: string; key: string; value: string }[] = [];
    for (const f of installFields) {
      const cur = values[fk(f.service, f.key)];
      const def = envToSettingValue(f, undefined);
      if (cur !== def && !(f.secret && cur === "")) {
        out.push({ service: f.service, key: f.key, value: settingToEnvValue(f, cur ?? "") });
      }
    }
    return out;
  };

  /** Apply each endpoint's exposure choice to its service, via the same
   *  service-update endpoint the project Domains tab uses (custom domains
   *  auto-create the pending domain row + SSL through the backend):
   *   http port   → unexpose (deploy port-only, reachable at host:port);
   *   http free   → managed subdomain (chosen slug or the template default);
   *   http custom → the user's domain;
   *   tcp publish → keep the published host port (no-op — the template seeds it);
   *   tcp internal→ strip the published port (reachable only inside the project). */
  const applyEndpoints = async (pid: string) => {
    if (!needsExposure) return;
    const svcRes = await servicesApi.list(pid);
    const services = svcRes?.services ?? [];
    const byName = new Map(services.map((s) => [s.name, s]));
    for (const e of appEndpoints) {
      const svc = byName.get(e.service);
      const st = expo[endpointKey(e)];
      if (!svc || !st) continue;
      if (st.kind === "http") {
        if (st.mode === "port") {
          // Unexpose so preflight skips the free-domain gate. Empty publicEndpoints
          // sent explicitly — updateService merges otherwise, re-exposing it.
          await servicesApi.update(pid, svc.id, { exposed: false, publicEndpoints: [] });
        } else if (st.ep.domainType === "custom") {
          const custom = st.ep.customDomain.trim().toLowerCase();
          if (custom)
            await servicesApi.update(pid, svc.id, {
              exposed: true,
              domainType: "custom",
              customDomain: custom,
            });
        } else {
          const slug = st.ep.domain.trim().toLowerCase();
          // Blank slug = keep the template's baked free subdomain.
          await servicesApi.update(pid, svc.id, {
            exposed: true,
            domainType: "free",
            ...(slug ? { domain: slug } : {}),
          });
        }
      } else if (st.mode === "internal") {
        // Drop the published host mapping for this port; leave any others.
        const ports = ((svc.ports as string[] | null) ?? []).filter((p) => {
          const parts = String(p).split(":");
          return Number(parts[parts.length - 1]) !== e.port;
        });
        await servicesApi.update(pid, svc.id, { ports });
      }
      // tcp publish → no-op (template already publishes the port).
    }
  };

  const install = async () => {
    if (busy) return;
    const httpStates = appEndpoints
      .filter((e) => e.kind === "http")
      .map((e) => expo[endpointKey(e)])
      .filter((s): s is Extract<Expo, { kind: "http" }> => s?.kind === "http");
    // A custom-domain endpoint needs its domain filled in.
    if (
      httpStates.some(
        (s) => s.mode === "domain" && s.ep.domainType === "custom" && !s.ep.customDomain.trim(),
      )
    ) {
      showToast(w.customRequired, "error");
      return;
    }
    // Free subdomains route through Openship Cloud. If it isn't connected,
    // requireCloud pops the same connect modal the deploy wizard uses and
    // returns false — bail so the user connects first, then re-clicks Install.
    if (
      httpStates.some((s) => s.mode === "domain" && s.ep.domainType === "free") &&
      !requireCloud({ feature: w.routeFreeLabel })
    ) {
      return;
    }
    setBusy(true);
    setDeploymentId(null);
    setLogs("");
    // Flips true the moment a deployment is actually created. A preflight
    // failure rejects buildAccess BEFORE that, so `started` stays false and the
    // catch surfaces a toast instead of the full-screen error card.
    let started = false;
    try {
      // Reuse an adopted / already-created draft; only create when we have none.
      let pid = adoptedProjectId ?? projectId;
      if (!pid) {
        const res = await appsApi.install({ templateId: appId, name: appName.trim() || undefined });
        const data = res.data;
        if (data.kind !== "template") {
          router.push((data as { flowHref?: string }).flowHref ?? "/apps");
          return;
        }
        pid = data.projectId;
      }
      setProjectId(pid);

      const changes = settingChanges();
      if (changes.length > 0) await appsApi.updateSettings(pid, changes);
      await applyEndpoints(pid);

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
      setPhaseLabel(w.progressPreparing);
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
   *  already-created draft so we never create a duplicate project. */
  const goAdvanced = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const pid = adoptedProjectId ?? projectId;
      if (pid) {
        router.push(`/deploy/${encodeProjectSlug(pid)}`);
        return;
      }
      const res = await appsApi.install({ templateId: appId });
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
        onGoToProject={() => projectId && router.push(`/projects/${projectId}`)}
        onViewBuild={() => deploymentId && router.push(`/build/${deploymentId}`)}
        onRetry={() => setPhase("form")}
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
          <div>
            <h1 className="text-xl font-semibold text-foreground">{template.name}</h1>
            <p className="text-sm text-muted-foreground">{template.description}</p>
          </div>
        </div>

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
              />
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
                            <OptionCard
                              value="port"
                              selected={st.mode === "port"}
                              onSelect={() => setExpoMode(key, "port")}
                              icon={<Network className="size-4" />}
                              label={w.routePortLabel}
                              description={w.routePortDesc}
                            />
                            <OptionCard
                              value="domain"
                              selected={st.mode === "domain"}
                              onSelect={() => setExpoMode(key, "domain")}
                              icon={<Globe className="size-4" />}
                              label={w.routeDomainLabel}
                              description={w.routeDomainDesc}
                            />
                            {/* Free-vs-custom + the domain/slug input live here only. */}
                            {st.mode === "domain" && (
                              <div className="mt-3">
                                <PublicEndpointsCard
                                  projectName={template.name}
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
                            <OptionCard
                              value="publish"
                              selected={st.mode === "publish"}
                              onSelect={() => setExpoMode(key, "publish")}
                              icon={<Network className="size-4" />}
                              label={w.tcpPublishLabel}
                              description={w.tcpPublishDesc}
                            />
                            <OptionCard
                              value="internal"
                              selected={st.mode === "internal"}
                              onSelect={() => setExpoMode(key, "internal")}
                              icon={<Lock className="size-4" />}
                              label={w.tcpInternalLabel}
                              description={w.tcpInternalDesc}
                            />
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
                <AppDestinationPicker value={destination} onChange={setDestination} allowLocal />
              </div>
            </div>

            {/* Actions */}
            <div className="space-y-2">
              <button
                type="button"
                onClick={install}
                disabled={busy}
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
