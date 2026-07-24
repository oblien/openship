"use client";

import React, { useCallback, useRef } from "react";
import { GitBranch, Rocket, Github, Loader2, Globe, Container, Server, Layers, Check, AlertCircle, Key, Plus, Copy, ExternalLink } from "lucide-react";
import { useI18n, interpolate } from "@/components/i18n-provider";
import { CustomSelect } from "@/components/ui/CustomSelect";
import DropdownMenu from "@/components/ui/DropdownMenu";
import DomainSettings from "./DomainSettings";
import BuildSummary from "./BuildSummary";
import { useCloneStrategyGate } from "./CloneStrategyNudge";
import { DeployCredentialModal } from "@/components/deployments/DeployCredentialModal";
import { useServerGitHubConnectModal } from "@/components/github/ServerGitHubConnect";
import { useDeployment } from "@/context/DeploymentContext";
import {
  publicEndpointsNeedCloud,
  servicesNeedCloud,
  usesServiceDeployment,
  type BuildStrategy,
} from "@/context/deployment/types";
import { useCloud } from "@/context/CloudContext";
import { canUseCloudConnection, usePlatform } from "@/context/PlatformContext";
import { useGitHub } from "@/context/GitHubContext";
import { useModal } from "@/context/ModalContext";
import { useRouter, useSearchParams } from "next/navigation";
import { invalidateProjectCaches } from "@/hooks/useProjectEndpoints";
import { projectsApi, githubApi, serverGithubApi, getApiErrorMessage } from "@/lib/api";
import { useToast } from "@/context/ToastContext";

// ─── Deploy checklist for compose ────────────────────────────────────────────

const ComposeChecklist: React.FC = () => {
  const { config } = useDeployment();
  const { t } = useI18n();
  const { baseDomain } = usePlatform();
  const services = config.services || [];
  if (services.length === 0) return null;

  const exposedServices = services.filter((s) => s.exposed);
  const exposableServices = services.filter((s) => s.ports.length > 0);
  const envConfigured = services.filter(
    (s) => Object.keys(s.environment).length > 0,
  ).length;
  const totalEnvVars = services.reduce(
    (acc, s) => acc + Object.keys(s.environment).length,
    0,
  );
  const buildServices = services.filter((s) => s.build);

  const checks = [
    {
      label: t.deploy.checklist.servicesDetected,
      value: interpolate(t.deploy.checklist.servicesCount, { count: String(services.length) }),
      ok: services.length > 0,
      icon: Layers,
    },
    {
      label: t.deploy.checklist.publicDomains,
      value: exposedServices.length > 0
        ? interpolate(t.deploy.checklist.exposedOf, { exposed: String(exposedServices.length), exposable: String(exposableServices.length) })
        : interpolate(t.deploy.checklist.canBeExposed, { count: String(exposableServices.length) }),
      ok: exposedServices.length > 0,
      warn: exposedServices.length === 0 && exposableServices.length > 0,
      icon: Globe,
    },
    ...(buildServices.length > 0
      ? [{
          label: t.deploy.checklist.buildServices,
          value: interpolate(t.deploy.checklist.toBuild, { count: String(buildServices.length) }),
          ok: true,
          icon: Container,
        }]
      : []),
    {
      label: t.deploy.checklist.environment,
      value: totalEnvVars > 0
        ? interpolate(t.deploy.checklist.varsAcross, { vars: String(totalEnvVars), services: String(envConfigured) })
        : t.deploy.checklist.noEnvVars,
      ok: totalEnvVars > 0,
      icon: Key,
    },
  ];

  return (
    <div className="bg-card rounded-xl border border-border/50 p-4 space-y-3">
      <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
        {t.deploy.checklist.title}
      </p>
      <div className="space-y-2">
        {checks.map((check) => {
          const Icon = check.icon;
          return (
            <div key={check.label} className="flex items-start gap-2.5">
              <div className={`mt-0.5 p-1 rounded-md ${
                check.ok
                  ? "bg-success-bg text-success"
                  : (check as any).warn
                    ? "bg-warning-bg text-warning"
                    : "bg-muted/50 text-muted-foreground/50"
              }`}>
                {check.ok ? (
                  <Check className="size-3" />
                ) : (check as any).warn ? (
                  <AlertCircle className="size-3" />
                ) : (
                  <Icon className="size-3" />
                )}
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-foreground leading-tight">
                  {check.label}
                </p>
                <p className="text-xs text-muted-foreground leading-snug">
                  {check.value}
                </p>
              </div>
            </div>
          );
        })}
      </div>

      {/* Exposed domains quick list */}
      {exposedServices.length > 0 && (
        <div className="pt-2 border-t border-border/30 space-y-1.5">
          <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
            {t.deploy.checklist.domains}
          </p>
          {exposedServices.map((svc) => {
            const domain =
              svc.domainType === "custom" && svc.customDomain
                ? svc.customDomain
                : `${svc.domain || svc.name}.${baseDomain}`;
            return (
              <div key={svc.name} className="flex items-center gap-2">
                <Globe className="size-3 text-primary" />
                <span className="text-sm text-primary font-medium truncate">{domain}</span>
                <span className="text-xs text-muted-foreground ms-auto">{svc.name}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};

// ─── Sidebar ─────────────────────────────────────────────────────────────────

const Sidebar: React.FC = () => {
  const { config, state, updateConfig, startDeployment } = useDeployment();
  const { t } = useI18n();
  const { requireCloud } = useCloud();
  const { baseDomain, selfHosted, deployMode } = usePlatform();
  const { installUrl, state: githubState } = useGitHub();
  const { showModal, hideModal } = useModal();
  const { showToast } = useToast();
  const router = useRouter();
  const isServices = usesServiceDeployment(config);

  // Copy a ready-to-run `git clone` command with a short-lived GitHub App
  // installation token. Cloud / GitHub-App mode only — surfaces a clear
  // message otherwise (the backend 409s in gh-CLI / PAT mode).
  const handleCopyCloneToken = useCallback(async () => {
    if (!config.owner || !config.repo || config.owner === "local") {
      showToast(t.deploy.sidebar.cloneTokenNoRepo, "error", t.deploy.sidebar.cloneTokenTitle);
      return;
    }
    try {
      const { command } = await githubApi.getCloneToken(config.owner, config.repo);
      await navigator.clipboard.writeText(command);
      showToast(
        t.deploy.sidebar.cloneTokenCopied,
        "success",
        t.deploy.sidebar.cloneTokenCopiedTitle,
      );
    } catch (err) {
      showToast(getApiErrorMessage(err, t.deploy.sidebar.cloneTokenFailed), "error", t.deploy.sidebar.cloneTokenTitle);
    }
  }, [config.owner, config.repo, showToast, t]);
  const canConnectCloud = canUseCloudConnection({ selfHosted, deployMode });
  // Clone-strategy gate - only meaningful for self-hosted server deploys
  // where we need to pick how the repo gets cloned on the remote (local
  // build vs PAT vs existing GitHub credential). Opshcloud has its own
  // connect-account flow, local builds don't need a remote credential.
  const cloneGate = useCloneStrategyGate();
  const openGithubConnect = useServerGitHubConnectModal();

  // Lazy branch list. In config-edit mode the wizard hydrates from saved data
  // with only the current branch seeded (no repo round-trip on load). The full
  // list is fetched once, on first open of the branch dropdown — never for
  // local-sourced projects (no remote repo to list).
  const branchesFetchedRef = useRef(false);
  const loadBranches = useCallback(async () => {
    if (branchesFetchedRef.current) return;
    if (!config.projectId || !config.owner || config.owner === "local") return;
    // Only when the list is "thin" (config-edit seeds just the current branch);
    // the first-deploy path already preloads the full list via prepare.
    if (config.branches.length > 1) return;
    branchesFetchedRef.current = true;
    try {
      const res = await projectsApi.getBranches(config.projectId);
      const names: string[] = (res?.data ?? [])
        .map((b: { name?: string }) => b?.name)
        .filter((n: unknown): n is string => typeof n === "string" && n.length > 0);
      if (names.length) {
        const merged = Array.from(new Set([config.branch, ...names].filter(Boolean)));
        updateConfig({ branches: merged });
      }
    } catch {
      branchesFetchedRef.current = false; // allow a retry on next open
    }
  }, [config.projectId, config.owner, config.branch, config.branches.length, updateConfig]);

  const handleOpenEnvironmentCreator = useCallback(() => {
    if (!config.projectId) return;

    const params = new URLSearchParams({ createEnvironment: "1" });
    if (config.branch) {
      params.set("branch", config.branch);
    }

    router.push(`/projects/${config.projectId}?${params.toString()}`);
  }, [config.branch, config.projectId, router]);

  // Runtime isolation (Direct/Sandbox) for self-hosted server apps is now an
  // inline setting in the target step (ServerRuntimePicker) — config.runtimeMode
  // already carries the choice, so deploy proceeds with no interruption.
  const continueDeploy = useCallback(async (overrides?: { buildStrategy?: BuildStrategy }) => {
    const deploymentId = await startDeployment(overrides);
    if (deploymentId) {
      router.push(`/build/${deploymentId}`);
    }
  }, [startDeployment, router]);

  const handleDeploy = useCallback(async () => {
    if (config.deployTarget === "cloud") {
      if (!requireCloud(t.deploy.targetStep.requireCloudFeature)) return;
    }

    // ── Clone-strategy resolution (self-hosted server deploys) ──────────
    // Deterministic — never ask when the answer is knowable. Server-side clone
    // is the DEFAULT: any resolvable credential (local gh forwarded over the
    // relay, Openship App / custom PAT, or a per-server credential) lets the
    // clone run on the remote worker. We no longer flip to a local build just
    // because gh is logged in — the gh token is now forwarded for the clone,
    // which the user opted into as the default. Only an EXPLICIT "build local"
    // preference builds on this host; a genuine no-credential case surfaces the
    // modal (and even that degrades to an api-host clone server-side).
    // buildStrategy="local" already clones on the API host; cloud targets go
    // through requireCloud; local targets don't clone.
    let buildStrategyOverride: BuildStrategy | undefined;
    if (config.deployTarget === "server" && config.buildStrategy === "server") {
      const ghAvailable = !!githubState?.sources.ghCli.available;
      const appAvailable =
        !!githubState?.sources.openshipApp.connected &&
        !!githubState?.sources.openshipApp.hasInstallations;
      // gh counts as a remote credential now — forwarded over the relay on
      // desktop, or (self-hosted) it just lets the backend gracefully degrade
      // to an api-host clone rather than dead-end.
      let remoteCredential = appAvailable || cloneGate.hasGlobalToken || ghAvailable;
      const willBuildLocal = cloneGate.preference === "local";

      // The target server may hold its OWN GitHub credential (device-login
      // token / PAT / SSH key or per-repo deploy key). That's a valid remote
      // clone path the App/PAT signals above don't see, so it must suppress the
      // dead-end modal. Only worth a round-trip in the would-be dead-end — check
      // it solely when we're otherwise about to surface the modal.
      if (!willBuildLocal && !remoteCredential && config.serverId) {
        try {
          const st = await serverGithubApi.get(config.serverId);
          if (st.connected) remoteCredential = true;
        } catch {
          // Unreadable status → treat as absent and fall through to the modal.
        }
      }

      if (willBuildLocal) {
        buildStrategyOverride = "local";
      } else if (!remoteCredential && config.owner) {
        // No gh, no App, no PAT, no per-server credential — genuinely nothing to
        // clone with. This is the only case worth a modal. The deploy waits
        // until the user picks or skips.
        let goConnectServer = false;
        await new Promise<void>((resolve) => {
          let modalId = "";
          modalId = showModal({
            customContent: (
              <DeployCredentialModal
                trigger="preflight-gate"
                owner={config.owner!}
                installUrl={installUrl ?? null}
                projectId={config.projectId ?? null}
                serverId={config.serverId ?? null}
                deployTarget={config.deployTarget}
                buildStrategy={config.buildStrategy}
                selfHosted={selfHosted}
                ghCliAvailable={ghAvailable}
                hasGlobalToken={cloneGate.hasGlobalToken}
                onChoice={(choice) => {
                  if (choice.kind === "build-local") {
                    buildStrategyOverride = "local";
                    updateConfig({ buildStrategy: "local" });
                  } else if (choice.kind === "connect-server-github") {
                    goConnectServer = true;
                  }
                  hideModal(modalId);
                  resolve();
                }}
                onDismiss={() => {
                  hideModal(modalId);
                  resolve();
                }}
              />
            ),
            maxWidth: "640px",
          });
        });
        // Chose to connect the server itself → abandon this attempt and open the
        // shared connect model; deploying again once connected clones via the
        // per-server credential.
        if (goConnectServer) {
          if (config.serverId) {
            openGithubConnect(config.serverId, {
              onConnected: () =>
                showToast(
                  "GitHub connected — deploy again to continue.",
                  "success",
                  "GitHub",
                ),
            });
          }
          return;
        }
      }
      // else: a remote credential (App/PAT) is available → proceed with the
      // server-side clone; the backend resolves the token via tokenFor("remote").
    }

    if (
      !isServices &&
      !config.noPublicRoute &&
      canConnectCloud &&
      config.deployTarget !== "cloud" &&
      publicEndpointsNeedCloud(config.publicEndpoints)
    ) {
      if (!requireCloud({
        feature: interpolate(t.deploy.sidebar.freeDomainFeature, { domain: baseDomain }),
        description: interpolate(t.deploy.sidebar.freeDomainDesc, { domain: baseDomain }),
        secondaryHint: t.deploy.sidebar.freeDomainHint,
      })) return;
    }

    // Compose services with free managed domains require cloud
    if (isServices && servicesNeedCloud(config.services)) {
      if (!requireCloud({
        feature: interpolate(t.deploy.sidebar.servicesFreeDomainFeature, { domain: baseDomain }),
        description: interpolate(t.deploy.sidebar.servicesFreeDomainDesc, { domain: baseDomain }),
        secondaryHint: t.deploy.sidebar.servicesFreeDomainHint,
      })) return;
    }

    if (isServices && shouldWarnAboutUnreachableServices(config.services)) {
      let modalId = "";
      modalId = showModal({
        customContent: (
          <div className="p-6 space-y-5">
            <div className="space-y-2">
              <h3 className="text-xl font-bold text-foreground">{t.deploy.sidebar.unreachableTitle}</h3>
              <p className="text-sm leading-relaxed text-muted-foreground">
                {t.deploy.sidebar.unreachableBody}
              </p>
            </div>

            <div className="rounded-xl border border-border bg-muted/40 p-4 space-y-2">
              <p className="text-xs uppercase tracking-wide text-muted-foreground">{t.deploy.sidebar.beforeDeploying}</p>
              <ul className="space-y-1.5 text-sm text-muted-foreground">
                <li>{t.deploy.sidebar.unreachableStep1}</li>
                <li>{t.deploy.sidebar.unreachableStep2}</li>
                <li>{t.deploy.sidebar.unreachableStep3}</li>
              </ul>
            </div>

            <div className="flex items-center justify-end gap-3 pt-2">
              <button
                type="button"
                className="rounded-lg border border-border bg-muted px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-muted/80"
                onClick={() => hideModal(modalId)}
              >
                {t.deploy.sidebar.reviewServices}
              </button>
              <button
                type="button"
                className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
                onClick={async () => {
                  hideModal(modalId);
                  await continueDeploy();
                }}
              >
                {t.deploy.sidebar.deployAnyway}
              </button>
            </div>
          </div>
        ),
        maxWidth: "560px",
      });
      return;
    }

    await continueDeploy(buildStrategyOverride ? { buildStrategy: buildStrategyOverride } : undefined);
  }, [baseDomain, canConnectCloud, cloneGate.hasGlobalToken, cloneGate.preference, config.buildStrategy, config.deployTarget, config.owner, config.projectId, config.serverId, config.publicEndpoints, config.services, continueDeploy, githubState, hideModal, installUrl, isServices, openGithubConnect, requireCloud, selfHosted, showModal, showToast, updateConfig, t]);

  // Edit mode (opened from the project Runtime page with ?mode=config): the
  // finish button SAVES the config to the project and returns — no deploy, no
  // deploy gates (cloud/clone/domain checks are deploy concerns). Deploying is
  // the separate "Redeploy" action on the project page.
  const searchParams = useSearchParams();
  const isConfigMode = searchParams.get("mode") === "config";
  const [isSaving, setIsSaving] = React.useState(false);
  const handleSave = useCallback(async () => {
    setIsSaving(true);
    try {
      const projectId = await startDeployment({ saveConfigOnly: true });
      if (projectId) {
        // Bust the cached project info so the Runtime tab shows the just-saved
        // config (it's served from infoCache and would otherwise be stale), then
        // return to the Runtime tab the user edited from — not the default tab.
        invalidateProjectCaches(projectId);
        router.push(`/projects/${projectId}/runtime`);
      }
    } finally {
      setIsSaving(false);
    }
  }, [startDeployment, router]);

  return (
    <div className="lg:sticky lg:top-6 h-fit space-y-4">
      {/* Repository Info */}
      <div className="border border-border/50 rounded-xl bg-card overflow-hidden">
        <div className="flex items-center gap-1.5 px-4 pt-3 pb-0">
          <span className="w-2.5 h-2.5 rounded-full bg-foreground/15" />
          <span className="w-2.5 h-2.5 rounded-full bg-foreground/10" />
          <span className="w-2.5 h-2.5 rounded-full bg-foreground/[0.07]" />
        </div>
        <div className="p-4 pt-3">
          <div className="flex items-center gap-3">
            <Github className="size-4 text-muted-foreground shrink-0" />
            <div className="flex-1 min-w-0">
              {config.owner && config.owner !== "local" && config.repo ? (
                <a
                  href={`https://github.com/${config.owner}/${config.repo}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  title={`${config.owner}/${config.repo}`}
                  className="group inline-flex max-w-full items-center gap-1.5 text-sm font-medium text-foreground transition-colors hover:text-primary"
                >
                  <span className="truncate">{config.owner}/{config.repo}</span>
                  <ExternalLink className="size-3 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 group-hover:text-primary" />
                </a>
              ) : (
                <p className="text-sm font-medium text-foreground truncate">
                  {config.owner}/{config.repo}
                </p>
              )}
            </div>
            {config.owner && config.owner !== "local" && config.repo && (
              <DropdownMenu
                align="right"
                triggerClassName="p-1.5 -me-1 rounded-lg text-muted-foreground hover:bg-muted transition-colors"
                actions={[
                  {
                    id: "clone-token",
                    label: t.deploy.sidebar.copyCloneToken,
                    icon: <Copy className="size-4" />,
                    onClick: handleCopyCloneToken,
                  },
                ]}
              />
            )}
          </div>
          {config.branches.length > 0 && (
            <div className="mt-3">
              <CustomSelect
                value={config.branch}
                onChange={(val) => updateConfig({ branch: val })}
                onOpen={loadBranches}
                options={config.branches.map(branch => ({
                  value: branch,
                  label: branch,
                  icon: <GitBranch className="w-3.5 h-3.5" />
                }))}
                footerAction={config.projectId
                  ? {
                      label: t.deploy.sidebar.newEnvironment,
                      icon: <Plus className="w-3.5 h-3.5 text-muted-foreground" />,
                      onClick: handleOpenEnvironmentCreator,
                    }
                  : undefined}
                placeholder={t.deploy.sidebar.selectBranch}
                className="w-full"
              />
            </div>
          )}
          {config.branches.length === 0 && config.branch && (
            <div className="flex items-center gap-1 mt-2 text-xs text-muted-foreground">
              <GitBranch className="size-3" />
              {config.branch}
            </div>
          )}
        </div>
      </div>

      {/* Domain - per-service for compose, checklist for others.
          Monorepo flows through the single-app DomainSettings: its
          `<PublicEndpointsCard>` already supports multiple endpoints
          (the "+" button at the header adds another Domain card). The
          monorepo init seeds `config.publicEndpoints` with one entry
          per sub-app so the existing card renders them all without a
          parallel UI. */}
      {isServices ? (
        <ComposeChecklist />
      ) : (
        <DomainSettings
          projectId={config.projectId}
          projectName={config.projectName}
          endpoints={config.publicEndpoints}
          hasServer={config.options.hasServer}
          runtimePort={config.options.productionPort}
          setEndpoints={(publicEndpoints, nextRuntimePort) => updateConfig({
            publicEndpoints,
            ...(nextRuntimePort !== undefined
              ? {
                  options: {
                    ...config.options,
                    productionPort: nextRuntimePort,
                  },
                }
              : {}),
          })}
          noPublicRoute={config.noPublicRoute ?? false}
          setNoPublicRoute={(noPublicRoute) => updateConfig({ noPublicRoute })}
        />
      )}

      {/* Finish: Save (edit mode) or Deploy (create/first-deploy). Editing
          config from the project Runtime page SAVES without deploying — deploy
          is the separate "Redeploy" action. */}
      {isConfigMode ? (
        <button
          onClick={handleSave}
          disabled={isSaving}
          className="w-full inline-flex items-center justify-center gap-2 px-5 py-3 bg-primary text-primary-foreground text-sm font-medium rounded-xl hover:bg-primary/90 transition-all hover:shadow-lg hover:shadow-primary/25 hover:-translate-y-0.5 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {isSaving ? (
            <>
              <Loader2 className="size-4 animate-spin" />
              {t.deploy.sidebar.saving}
            </>
          ) : (
            <>
              <Check className="size-4" />
              {t.deploy.sidebar.saveChanges}
            </>
          )}
        </button>
      ) : (
        <button
          onClick={handleDeploy}
          disabled={state.isDeploying}
          className="w-full inline-flex items-center justify-center gap-2 px-5 py-3 bg-primary text-primary-foreground text-sm font-medium rounded-xl hover:bg-primary/90 transition-all hover:shadow-lg hover:shadow-primary/25 hover:-translate-y-0.5 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {state.isDeploying ? (
            <>
              <Loader2 className="size-4 animate-spin" />
              {t.deploy.sidebar.deploying}
            </>
          ) : (
            <>
              <Rocket className="size-4" />
              {t.deploy.sidebar.deploy}
            </>
          )}
        </button>
      )}

      {/* Build Summary */}
      <BuildSummary />
    </div>
  );
};

export default React.memo(Sidebar);

function hasConnectedDomain(service: {
  exposed?: boolean;
  domainType?: "free" | "custom";
  customDomain?: string;
  domain?: string;
  name?: string;
}) {
  if (!service.exposed) return false;
  if (service.domainType === "custom") return Boolean(service.customDomain?.trim());
  return Boolean(service.domain?.trim() || service.name?.trim());
}

function shouldWarnAboutUnreachableServices(services: Array<{
  image?: string;
  name: string;
  ports: string[];
  exposed?: boolean;
  domainType?: "free" | "custom";
  customDomain?: string;
  domain?: string;
}>) {
  const candidates = services.filter((service) => service.ports.length > 0);
  if (candidates.length === 0) return false;
  return candidates.every((service) => !hasConnectedDomain(service));
}
