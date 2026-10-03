"use client";

import { Icon as UiIcon } from "@repo/ui/icons";

import React, { useEffect, useState } from "react";
import {
  resolveTierResources,
} from "@repo/core";
import { Button } from "@/components/ui/button";
import { useDeployment } from "@/context/DeploymentContext";
import { usesServiceDeployment, workloadOf } from "@/context/deployment/types";
import { ServerSelectorView, type ServerSelection } from "@/components/shared/ServerSelector";
import { OptionCard } from "@/components/shared/OptionCard";
import { ResourceTierPicker, useResourceTierLabels } from "@/components/deploy/ResourceTierPicker";
import { usePlatform } from "@/context/PlatformContext";
import { settingsApi, type DefaultDeployTarget } from "@/lib/api/settings";
import { useToast } from "@/context/ToastContext";
import type { DeployTarget, BuildStrategy, CloneStrategy, RuntimeMode, CloudResourceTier } from "@/context/deployment/types";
import ServerRuntimePicker from "./ServerRuntimePicker";
import { RollbackBackupPanel } from "./RollbackBackupPanel";
import { useI18n, interpolate } from "@/components/i18n-provider";

// ─── Compact summary (shown when editing from step 2) ────────────────────────

interface CompactSummaryProps {
  deployTarget: DeployTarget;
  buildStrategy: BuildStrategy;
  serverName?: string | null;
  showBuildStrategy?: boolean;
  /** When deployTarget is "cloud", the chosen resource tier — rendered
   *  as a small chip on the right of the summary so the operator sees
   *  their power pick at a glance without re-opening the picker. */
  cloudResourceTier?: CloudResourceTier;
  /** False when the project deploys as static files (no Start command,
   *  no long-running process). For cloud deploys this swaps the power
   *  tier chip for a "Static" chip — there's no machine to size when
   *  the workload is just files served from the edge. */
  hasServer?: boolean;
  /** Runtime isolation shown in the configuration summary and settings preview. */
  runtimeMode?: RuntimeMode;
  /** True when the project deploys as a multi-service stack (compose). A stack
   *  runs sandboxed containers — never static edge-served files — so it must
   *  never show the Static chip even when the project-level hasServer/framework
   *  is unset (those live per-service). */
  isServices?: boolean;
  /** Null/undefined retention inherits the instance default. */
  rollbackWindow?: number | null;
  rollbackStrategy?: "git" | "snapshot";
  onEdit?: () => void;
  variant?: "inline" | "preview";
}

export const DeployTargetSummary: React.FC<CompactSummaryProps> = ({
  deployTarget,
  buildStrategy,
  serverName,
  showBuildStrategy = true,
  cloudResourceTier,
  hasServer = true,
  runtimeMode,
  isServices = false,
  rollbackWindow,
  rollbackStrategy,
  onEdit,
  variant = "inline",
}) => {
  const { t } = useI18n();
  const targetLabels: Record<DeployTarget, { label: string; icon: React.ReactNode }> = {
    local: { label: t.deploy.summary.targetLocal, icon: <UiIcon name="cpu" className="size-4" /> },
    server: { label: t.deploy.summary.targetServer, icon: <UiIcon name="server" className="size-4" /> },
    cloud: { label: t.deploy.summary.targetCloud, icon: <UiIcon name="cloud" className="size-4" /> },
    cluster: { label: "Server cluster", icon: <UiIcon name="cluster" className="size-4" /> },
  };
  const buildLabels: Record<BuildStrategy, { label: string; icon: React.ReactNode }> = {
    local: { label: t.deploy.summary.buildLocal, icon: <UiIcon name="cpu" className="size-4" /> },
    server: { label: t.deploy.summary.buildRemote, icon: <UiIcon name="cloud" className="size-4" /> },
  };
  const tierLabels = useResourceTierLabels();
  const target = targetLabels[deployTarget];
  // Remote builds run on the selected destination.
  const build =
    buildStrategy === "local"
      ? buildLabels.local
      : deployTarget === "cloud"
        ? { label: t.deploy.summary.targetCloud, icon: <UiIcon name="cloud" className="size-4" /> }
        : buildLabels.server;
  const deployLabel = (deployTarget === "server" || deployTarget === "cloud") && serverName
    ? serverName
    : target.label;

  // Build "destination" derived from (deployTarget, buildStrategy):
  //   - buildStrategy === "local" → local machine
  //   - buildStrategy === "server" → runs ON the deploy target
  // Same destination → collapse Build + Deploy into a single chip with
  // the two icons stacked + a `+` between them, instead of two
  // sections separated by an arrow. Most users have matching targets
  // (cloud-on-cloud, server-on-server), so this is the common case.
  const buildDest = buildStrategy === "local" ? "local" : deployTarget;
  const sameDestination = showBuildStrategy && buildDest === deployTarget;

  // Right-hand chip on the summary — one at a time, by workload shape:
  //   - Static (files served from the edge, any target): neutral info chip.
  //     No machine to size, no process to sandbox.
  //   - Cloud + server: the picked resource tier (Zap).
  //   - Self-hosted server: the runtime — "bare" carries a persistent WARNING
  //     (runs directly on the host, unsandboxed) so it's visible even when the
  //     user reads only the summary; "docker" a neutral Sandboxed chip.
  const runtimeChip = isServices ? (
    // A service stack (compose) always runs sandboxed containers — never static
    // edge-served files — regardless of the project-level hasServer/framework
    // (which are unset for compose). Show the tier on cloud, else Sandboxed.
    deployTarget === "cloud" && cloudResourceTier ? (
      <span className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground shrink-0">
        <UiIcon name="bolt" className="size-4" />
        <span>{tierLabels.name(cloudResourceTier)}</span>
      </span>
    ) : (
      <span className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground shrink-0">
        <UiIcon name="shield-check" className="size-4" />
        {t.deploy.summary.runtimeSandboxed}
      </span>
    )
  ) : !hasServer ? (
    <span className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground shrink-0">
      <UiIcon name="globe" className="size-4" />
      {t.deploy.summary.runtimeStatic}
    </span>
  ) : deployTarget === "cloud" && runtimeMode !== "bare" ? (
    cloudResourceTier ? (
      <span className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground shrink-0">
        <UiIcon name="bolt" className="size-4" />
        <span>{tierLabels.name(cloudResourceTier)}</span>
      </span>
    ) : null
  ) : (deployTarget === "server" || deployTarget === "cloud") && runtimeMode === "bare" ? (
    <span
      className="inline-flex items-center gap-1.5 text-xs font-medium text-warning shrink-0"
      title={t.deploy.summary.runtimeDirectHint}
    >
      <UiIcon name="shield-alert" className="size-4" />
      {t.deploy.summary.runtimeDirectWarning}
    </span>
  ) : (deployTarget === "server" || deployTarget === "cloud") && runtimeMode === "docker" ? (
    <span className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground shrink-0">
      <UiIcon name="shield-check" className="size-4" />
      {t.deploy.summary.runtimeSandboxed}
    </span>
  ) : null;

  // Keep retention visible in both the inline summary and settings preview.
  const rollbackChip = (
    <span
      className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground shrink-0"
      title={
        rollbackStrategy === "snapshot"
          ? t.deploy.summary.rollbackSnapshotHint
          : t.deploy.summary.rollbackGitHint
      }
    >
      <UiIcon name="rotate-left" className="size-4" />
      {rollbackWindow == null
        ? t.deploy.summary.rollbackAuto
        : interpolate(
            rollbackWindow === 1
              ? t.deploy.summary.rollbackOne
              : t.deploy.summary.rollbackOther,
            { count: String(rollbackWindow) },
          )}
    </span>
  );

  if (variant === "preview") {
    const containerLimits = deployTarget === "cloud" && (isServices || runtimeMode !== "bare");
    const runtimeLabel = !hasServer && !isServices
      ? t.deploy.summary.static
      : isServices || runtimeMode !== "bare"
        ? t.deploy.runtime.sandboxedLabel
        : t.deploy.runtime.directLabel;
    return (
      <div className="space-y-4">
        <dl className="space-y-3">
          <div>
            <dt className="text-xs text-muted-foreground">{sameDestination ? t.deploy.summary.buildAndDeploy : t.billing.workspaces.destination}</dt>
            <dd className="mt-1 break-words text-sm font-medium text-foreground">{deployLabel}</dd>
          </div>
          {showBuildStrategy && !sameDestination && (
            <div>
              <dt className="text-xs text-muted-foreground">{t.deploy.summary.build}</dt>
              <dd className="mt-1 text-sm font-medium text-foreground">{build.label}</dd>
            </div>
          )}
        </dl>
        <div className="space-y-3 rounded-xl bg-muted/40 p-3.5">
          <dl className="space-y-3 text-sm">
            <div className="flex flex-wrap justify-between gap-2">
              <dt className="text-muted-foreground">{t.deploy.runtime.heading}</dt>
              <dd className="font-medium text-foreground">{runtimeLabel}</dd>
            </div>
            {containerLimits && cloudResourceTier && (
              <div className="flex flex-wrap justify-between gap-2">
                <dt className="text-muted-foreground">{t.projectSettings.resources.title}</dt>
                <dd className="font-medium text-foreground">{tierLabels.name(cloudResourceTier)}</dd>
              </div>
            )}
          </dl>
          {rollbackChip}
        </div>
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={onEdit}
      className="w-full flex items-center gap-3 px-4 py-3 bg-card rounded-xl border border-border/50 hover:border-primary/30 transition-all group text-start"
    >
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 flex-1 min-w-0">
        <div className="flex flex-wrap items-center gap-3 grow basis-64 min-w-0">
          {sameDestination ? (
            // Merged view — single line, two icons with a + between to
            // signal "both build and deploy go here", followed by one
            // label. Saves horizontal space vs the two-section layout.
            <div className="flex items-center gap-2 text-xs min-w-0">
              <div className="flex items-center gap-1 text-muted-foreground shrink-0">
                {build.icon}
                <UiIcon name="plus" className="size-3" />
                {target.icon}
              </div>
              <span className="text-muted-foreground shrink-0">{t.deploy.summary.buildAndDeploy}</span>
              <span className="font-medium text-foreground truncate" title={deployLabel}>{deployLabel}</span>
            </div>
          ) : (
            <>
              {showBuildStrategy && (
                <>
                  <div className="flex items-center gap-2 text-xs shrink-0">
                    {build.icon}
                    <span className="text-muted-foreground">{t.deploy.summary.build}</span>
                    <span className="font-medium text-foreground">{build.label}</span>
                  </div>
                  <UiIcon name="arrow-right" className="size-3.5 text-muted-foreground/50 shrink-0 rtl:rotate-180" />
                </>
              )}
              <div className="flex items-center gap-2 text-xs min-w-0">
                {target.icon}
                <span className="text-muted-foreground shrink-0">{t.deploy.summary.deploy}</span>
                <span className="font-medium text-foreground truncate" title={deployLabel}>{deployLabel}</span>
              </div>
            </>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          {runtimeChip}
          {rollbackChip}
        </div>
      </div>
      <UiIcon name="edit" className="size-4 shrink-0 text-muted-foreground transition-opacity" />
    </button>
  );
};

// ─── Hook: resolve available targets ─────────────────────────────────────────

// ─── Main step ───────────────────────────────────────────────────────────────

interface DeployTargetStepProps {
  /** Existing project whose rollback and backup settings can be edited. */
  projectId?: string | null;
  serverSelection: ServerSelection;
  onContinue: () => void;
  onBack: () => void;

}

const DeployTargetStep: React.FC<DeployTargetStepProps> = ({ serverSelection, onContinue, onBack, projectId }) => {
  const { config, updateConfig } = useDeployment();
  const { selfHosted, deployMode } = usePlatform();
  const destinationReady = serverSelection.ready;
  // Git credential forwarding is desktop-only — the relay forwards the
  // operator's machine-local `gh`, which only exists on a desktop host.
  const isDesktop = deployMode === "desktop";
  const { showToast } = useToast();
  const { t } = useI18n();
  const ts = t.deploy.targetStep;
  const [saveAsDefault, setSaveAsDefault] = useState(false);
  const [savingDefault, setSavingDefault] = useState(false);
  const [resourceSelectionPending, setResourceSelectionPending] = useState(false);
  const isServiceDeployment = usesServiceDeployment(config);
  const showBuildStrategy =
    config.projectType === "app" || (config.projectType === "services" && !isServiceDeployment);

  const buildOptions: Array<{
    value: BuildStrategy;
    icon: React.ReactNode;
    label: string;
    description: string;
  }> = [
    {
      value: "local",
      icon: <UiIcon name="cpu" className="size-5" />,
      label: ts.build.localLabel,
      description: ts.build.localDesc,
    },
    {
      value: "server",
      icon: <UiIcon name="cloud" className="size-5" />,
      label: ts.build.remoteLabel,
      description: ts.build.remoteDesc,
    },
  ];
  // Managed builds always execute on the selected server's adapter.
  const visibleBuildOptions = config.deployTarget === "cloud" ? [] : buildOptions;

  // Clone-location picker (DOCKER server deploys, incl. services). Bare always
  // clones on the target, so it keeps the credential-forwarding checkbox below
  // instead — there's no "clone on the API host" alternative for it. Cloud
  // clones inside the workspace and local has no remote, so both are excluded.
  // Services always deploy as docker (build on the server), so the clone picker
  // applies to them regardless of the config.runtimeMode field (which may not be
  // hydrated to "docker" on a config-edit).
  // Clone location only exists for a REMOTE build (the clone runs on the target).
  // "This Machine" (local build) clones + builds here and ships the output, so
  // there's no on-server-vs-here choice to make — hide it entirely.
  const showCloneStrategy =
    config.deployTarget === "server" &&
    config.buildStrategy === "server" &&
    (config.runtimeMode === "docker" || isServiceDeployment);
  // Clone-on-server is the default (primary card); cloning on the api host and
  // uploading is the advanced/manual alternative.
  const cloneStrategy: CloneStrategy = config.cloneStrategy ?? "server";
  const cloneOptions: Array<{
    value: CloneStrategy;
    icon: React.ReactNode;
    label: string;
    description: string;
  }> = [
    {
      value: "server",
      icon: <UiIcon name="git-branch" className="size-5" />,
      label: ts.clone.serverLabel,
      description: ts.clone.serverDesc,
    },
    {
      value: "api-host",
      // The "api host" is the machine running Openship: the user's own device in
      // desktop mode, the Openship orchestrator when self-hosted. Not the cloud —
      // so no cloud icon, and a label that says which machine it actually is.
      icon: <UiIcon name="cpu" className="size-5" />,
      label: isDesktop ? ts.clone.apiHostDesktopLabel : ts.clone.apiHostServerLabel,
      description: isDesktop
        ? ts.clone.apiHostDesktopDesc
        : ts.clone.apiHostServerDesc,
    },
  ];

  // Default the clone location to "on the server" for a brand-new deploy when
  // the choice is UNSET. Git-identity forwarding is no longer a per-deploy
  // choice — it's the operator-wide "Forward my git identity to build servers"
  // setting (Settings → Clone credentials), resolved server-side at build time.
  useEffect(() => {
    if (config.projectId) return;
    if (!showCloneStrategy) return;
    if (config.cloneStrategy == null) updateConfig({ cloneStrategy: "server" });
  }, [config.projectId, showCloneStrategy, config.cloneStrategy, updateConfig]);


  const canContinue = destinationReady && !resourceSelectionPending;
  const showLoading = serverSelection.loading;
  const showFullPicker = !showLoading;
  const summaryServerName = serverSelection.selected?.name || config.serverName;

  // What this step actually PICKED, in the vocabulary both memories below use: a
  // binding, or nothing. `config.deployTarget` can also be "local", which is not a
  // pick — it's what an unbound project derives — so neither the cross-device
  // default nor the soft last-pick may store it. Null therefore means "nothing to
  // remember": the default is cleared and the last-pick is left alone.
  const pickedTarget: DefaultDeployTarget | null =
    config.deployTarget === "server" || config.deployTarget === "cloud"
      ? config.deployTarget
      : null;

  // Persist the current pick as the user's default - fire-and-forget so it
  // never blocks the deploy flow. Failures are surfaced as a toast; the
  // deploy itself continues either way.
  const persistDefault = async () => {
    if (!saveAsDefault) return;
    setSavingDefault(true);
    try {
      await settingsApi.updateDeployDefaults({
        defaultDeployTarget: pickedTarget,
        defaultServerId: pickedTarget ? (config.serverId ?? null) : null,
      });
      showToast(ts.savedToast, "success", ts.savedToastTitle);
    } catch {
      showToast(ts.saveFailedToast, "error", ts.savedToastTitle);
    } finally {
      setSavingDefault(false);
    }
  };

  const handleContinue = async () => {
    if (!canContinue) return;
    serverSelection.remember();
    void persistDefault();
    onContinue();
  };

  const showSettings = showFullPicker && (serverSelection.ready || !!config.serverId) &&
    (config.deployTarget === "server" || config.deployTarget === "cloud");
  const showRuntimeIsolation =
    (config.deployTarget === "cloud" || workloadOf(config.options) !== "static") &&
    config.projectType !== "docker" && !isServiceDeployment;
  const showResourceLimits = config.deployTarget === "cloud" &&
    (config.runtimeMode !== "bare" || isServiceDeployment || config.projectType === "docker");
  const resourceValues = resolveTierResources(config.cloudResourceTier ?? "unlimited", config.cloudResourceCustom);

  // Saved connection defaults stay with the destination controls.
  const saveDefaultCheckbox =
    selfHosted && showFullPicker && canContinue && config.serverId ? (
      <label className="flex items-start gap-2.5 cursor-pointer select-none px-1">
        <input
          type="checkbox"
          checked={saveAsDefault}
          onChange={(e) => setSaveAsDefault(e.target.checked)}
          disabled={savingDefault}
          className="mt-0.5 size-4 shrink-0 rounded border-border/60 bg-card text-primary focus:ring-2 focus:ring-primary/30 focus:ring-offset-0 cursor-pointer disabled:opacity-50"
        />
        <span className="text-sm text-muted-foreground leading-snug">
          {ts.saveDefault}{" "}
          <span className="text-muted-foreground/70">{ts.saveDefaultHint}</span>
        </span>
      </label>
    ) : null;

  const headerSubtitle = showLoading ? ts.loadingSubtitle
    : serverSelection.readOnly ? null : ts.chooseSubtitle;

  const backButton = (
    <Button type="button" variant="secondary" size="sm" className="shrink-0" onClick={onBack}>
      <UiIcon name="arrow-left" className="size-4 rtl:rotate-180" />
      {ts.back}
    </Button>
  );

  if (config.deployTarget === "cluster") return (
    <div className="space-y-5">
      <header className="flex items-start justify-between gap-4">
        <h1 className="text-2xl font-medium">Deploy to server cluster</h1>
        {backButton}
      </header>
      <p className="text-sm leading-relaxed text-muted-foreground">This project uses the cluster and instance count saved in its Scale controls. OpenShip builds or reuses the application image, starts the instances, and checks their health before switching traffic.</p>
      <Button onClick={onContinue}>Continue</Button>
    </div>
  );

  return (
    <div className="@container/target space-y-6">
      <header className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-2xl font-medium text-foreground/80">{ts.heading}</h1>
          {headerSubtitle && <p className="mt-1 text-sm text-muted-foreground">{headerSubtitle}</p>}
        </div>
        {backButton}
      </header>
      <div className="grid grid-cols-1 items-start gap-6 @min-[60rem]/target:grid-cols-[minmax(0,1fr)_340px]">
        <div className="min-w-0 space-y-5">
          <section className="space-y-4 rounded-2xl bg-card p-5" aria-label={t.billing.workspaces.destination}>
            <h2 className="text-sm font-semibold text-foreground">{t.billing.workspaces.destination}</h2>
            <ServerSelectorView selection={serverSelection} label={t.billing.workspaces.destination} compact />
            {saveDefaultCheckbox}
          </section>

          {showSettings && (
            <>
              {showRuntimeIsolation && (
                <section className="rounded-2xl bg-card p-5" aria-label={t.deploy.runtime.heading}>
                  <ServerRuntimePicker />
                </section>
              )}
              {showResourceLimits && (
                <section className="space-y-4 rounded-2xl bg-card p-5" aria-label={t.projectSettings.resources.title}>
                  <h2 className="text-sm font-semibold text-foreground">{t.projectSettings.resources.title}</h2>
                  <ResourceTierPicker
                    key={config.serverId}
                    showModeSelector
                    onPendingChange={setResourceSelectionPending}
                    value={config.cloudResourceTier ?? "unlimited"}
                    values={resourceValues}
                    capacity={serverSelection.selected?.managed?.resources ?? undefined}
                    disabled={serverSelection.disabled}
                    onSelect={(tier, values) => updateConfig({
                      cloudResourceTier: tier,
                      cloudResourceCustom: tier === "custom" && values ? { ...resourceValues, ...values } : undefined,
                    })}
                  />
                </section>
              )}
              {showBuildStrategy && visibleBuildOptions.length > 1 && (
                <section className="space-y-4 rounded-2xl bg-card p-5">
                  <div>
                    <h2 className="text-sm font-semibold text-foreground">{config.options.hasBuild ? ts.build.heading : ts.build.prepareHeading}</h2>
                    <p className="mt-1 text-xs text-muted-foreground">{config.options.hasBuild ? ts.build.subtitle : ts.build.prepareSubtitle}</p>
                  </div>
                  <div className="grid grid-cols-1 items-stretch gap-3 @min-[36rem]/target:grid-cols-2">
                    {visibleBuildOptions.map((opt) => (
                      <OptionCard key={opt.value} value={opt.value} selected={config.buildStrategy === opt.value}
                        onSelect={() => updateConfig({ buildStrategy: opt.value })}
                        icon={opt.icon} label={opt.label} description={opt.description} className="h-full" />
                    ))}
                  </div>
                </section>
              )}
              <section className="rounded-2xl bg-card p-5" aria-label={ts.rollbackTitle}>
                <RollbackBackupPanel
                  projectId={projectId}
                  enabled
                  artifactKind={workloadOf(config.options) === "static" && !isServiceDeployment ? "files" : "image"}
                />
              </section>
              {showCloneStrategy && (
                <section className="space-y-4 rounded-2xl bg-card p-5">
                  <div>
                    <h2 className="text-sm font-semibold text-foreground">{ts.clone.heading}</h2>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {ts.clone.descLead}{isDesktop ? ts.clone.descDesktop : ts.clone.descServer}
                    </p>
                  </div>
                  <div className="grid grid-cols-1 items-stretch gap-3 @min-[36rem]/target:grid-cols-2">
                    {cloneOptions.map((opt) => (
                      <OptionCard key={opt.value} value={opt.value} selected={cloneStrategy === opt.value}
                        onSelect={() => updateConfig({ cloneStrategy: opt.value })}
                        icon={opt.icon} label={opt.label} description={opt.description} className="h-full" />
                    ))}
                  </div>
                </section>
              )}
            </>
          )}
        </div>
        <aside className="space-y-4 rounded-2xl bg-card p-5 @min-[60rem]/target:sticky @min-[60rem]/target:top-6" aria-label={ts.previewTitle}>
          <h2 className="text-base font-semibold text-foreground">{ts.previewTitle}</h2>
          <DeployTargetSummary
            variant="preview"
            deployTarget={config.deployTarget}
            buildStrategy={config.buildStrategy}
            serverName={summaryServerName}
            showBuildStrategy={showBuildStrategy}
            cloudResourceTier={config.cloudResourceTier}
            hasServer={workloadOf(config.options) !== "static"}
            runtimeMode={config.runtimeMode}
            isServices={isServiceDeployment}
            rollbackWindow={config.rollbackWindow}
            rollbackStrategy={config.rollbackStrategy}
          />
          <Button type="button" onClick={handleContinue} disabled={!canContinue} className="w-full">
            {ts.continue}
            <UiIcon name="arrow-right" className="size-4 rtl:rotate-180" />
          </Button>
          <p className="text-xs leading-relaxed text-muted-foreground">{ts.previewHint}</p>
        </aside>
      </div>
    </div>
  );
};

export default DeployTargetStep;
