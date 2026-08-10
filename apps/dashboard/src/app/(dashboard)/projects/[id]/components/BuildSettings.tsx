import React, { useState } from "react";
import { Inbox, Layers, ArrowRight, Pencil, KeyRound, Cpu } from "lucide-react";
import { useRouter } from "next/navigation";
import { isServicesFramework } from "@repo/core";
import { useProjectSettings } from "@/context/ProjectSettingsContext";
import { useI18n, interpolate } from "@/components/i18n-provider";
import { encodeLocalSlug, encodeRepoSlug } from "@/utils/repoSlug";
import { EnvVarsEditor } from "./EnvVarsEditor";
import { StorageSettings } from "./StorageSettings";
import { ResourceSettings } from "./ResourceSettings";

/**
 * Project → Runtime tab. READ-ONLY by design.
 *
 * Config (build/runtime/env) has a single edit owner: the deploy wizard. This
 * tab only DISPLAYS the project's current configuration and links to the wizard
 * (opened with ?projectId) for any change — so editing never lives in two
 * places and every change goes through the create-a-new-version flow.
 *
 * Visual shell (SectionCard + ICON_TONES) mirrors the sibling settings tabs
 * (GitSettings / BackupSettings / DomainSettings) so the tab fills the same
 * column width and reads as part of the same design system.
 */

const ICON_TONES = {
  primary: "bg-primary/10 text-primary",
  emerald: "bg-success-bg text-success",
  orange: "bg-orange-500/10 text-orange-500",
  amber: "bg-warning-bg text-warning",
  violet: "bg-violet-500/10 text-violet-500",
  red: "bg-danger-bg text-danger",
  muted: "bg-muted/60 text-muted-foreground",
} as const;

function SectionCard({
  icon: Icon,
  iconTone = "primary",
  title,
  description,
  actions,
  children,
}: {
  icon: React.ComponentType<{ className?: string }>;
  iconTone?: keyof typeof ICON_TONES;
  title: string;
  description: string;
  actions?: React.ReactNode;
  children?: React.ReactNode;
}) {
  return (
    <div className="overflow-hidden rounded-2xl border border-border/50 bg-card">
      <div className={`flex items-start gap-3 px-5 py-4 ${children ? "border-b border-border/40" : ""}`}>
        <div className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl ${ICON_TONES[iconTone]}`}>
          <Icon className="size-4" />
        </div>
        <div className="min-w-0 flex-1">
          <h3 className="text-[14px] font-semibold text-foreground">{title}</h3>
          <p className="mt-0.5 text-[12px] text-muted-foreground">{description}</p>
        </div>
        {actions ? <div className="shrink-0">{actions}</div> : null}
      </div>
      {children ? <div className="px-5 py-4">{children}</div> : null}
    </div>
  );
}

function Row({
  label,
  value,
  mono,
}: {
  label: string;
  value?: React.ReactNode;
  mono?: boolean;
}) {
  const empty = value === undefined || value === null || value === "";
  return (
    <div className="flex items-center justify-between gap-3 px-4 py-2.5">
      <span className="shrink-0 text-[12px] text-muted-foreground">{label}</span>
      <span
        className={`min-w-0 break-all text-end text-[13px] font-medium text-foreground ${mono ? "font-mono tabular-nums" : ""}`}
      >
        {empty ? <span className="text-muted-foreground/40">—</span> : value}
      </span>
    </div>
  );
}

export const BuildSettings = () => {
  const { buildData, projectData, servicesData, id } = useProjectSettings();
  const { t } = useI18n();
  const router = useRouter();
  const [envOpen, setEnvOpen] = useState(false);

  const isWebmail = projectData?.framework === "webmail";
  const services = servicesData.services;
  const monorepoCount = services.filter((s) => s.kind === "monorepo").length;
  const composeCount = services.length - monorepoCount;
  // SERVICE-FIRST = the project itself is a set of services (a compose-stack
  // project) or a monorepo of sub-apps — its config genuinely lives per-service.
  // A single/static APP that merely had a sidecar service ADDED is NOT
  // service-first: it keeps its own primary-app Configuration below. Keyed on
  // the project's framework, never on "a service row exists" (which conflates
  // the two — the whole point of this fix).
  const isServiceFirst = monorepoCount > 0 || isServicesFramework(projectData?.framework);

  // Edit = the deploy wizard, rehydrated from this project. The single place
  // config is editable; this tab never mutates it.
  const hasRepo = Boolean(projectData?.gitOwner && projectData?.gitRepo);
  const editSlug = hasRepo
    ? encodeRepoSlug(projectData!.gitOwner!, projectData!.gitRepo!)
    : projectData?.localPath
      ? encodeLocalSlug(projectData.localPath)
      : null;
  const openWizard = () => {
    // mode=config → the wizard SAVES config (no deploy); see Sidebar handleSave.
    if (editSlug) router.push(`/deploy/${editSlug}?projectId=${id}&mode=config`);
  };

  const EditButton = () =>
    editSlug ? (
      <button
        type="button"
        onClick={openWizard}
        className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-border/60 bg-muted/30 px-3 py-1.5 text-sm font-medium text-foreground transition-colors hover:bg-muted/50"
      >
        <Pencil className="size-3.5" />
        {t.projectSettings.build.edit}
      </button>
    ) : null;

  // ── Webmail: fully managed, nothing to show or edit. ──────────────────
  if (isWebmail) {
    return (
      <div className="space-y-5">
        <SectionCard
          icon={Inbox}
          iconTone="muted"
          title={t.projectSettings.build.webmail.title}
          description={t.projectSettings.build.webmail.description}
        />
      </div>
    );
  }

  // ── Service-first project: config lives per-service in the Services tab.
  //    (A single/static app with an added sidecar service falls through to the
  //    single-app config below — it is NOT service-first.) ──
  if (isServiceFirst) {
    const subAppsLabel = interpolate(
      monorepoCount === 1 ? t.projectSettings.build.services.subAppOne : t.projectSettings.build.services.subAppOther,
      { count: String(monorepoCount) },
    );
    const composeLabel = interpolate(
      composeCount === 1 ? t.projectSettings.build.services.composeOne : t.projectSettings.build.services.composeOther,
      { count: String(composeCount) },
    );
    const serviceLabel =
      monorepoCount && composeCount
        ? interpolate(t.projectSettings.build.services.both, { subApps: subAppsLabel, composeServices: composeLabel })
        : monorepoCount
          ? subAppsLabel
          : composeLabel;
    return (
      <div className="space-y-5">
        <SectionCard
          icon={Layers}
          iconTone="primary"
          title={t.projectSettings.build.services.title}
          description={interpolate(t.projectSettings.build.services.descriptionTemplate, { serviceLabel })}
          actions={
            <button
              type="button"
              onClick={() => router.push(`/projects/${id}/services`)}
              className="inline-flex items-center gap-1.5 rounded-xl bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
            >
              {t.projectSettings.build.services.open}
              <ArrowRight className="size-3.5" />
            </button>
          }
        />
      </div>
    );
  }

  // ── Single-app: read-only configuration summary. ──────────────────────
  // A static site has no runtime process to isolate — the edge serves its files
  // from the shared static volume. Its `runtimeMode` is still "docker" because it
  // BUILT in a Docker sandbox, so reporting "Sandboxed (container)" here mislabels a
  // build detail as a runtime one and contradicts the Start command row's "Static
  // (no server)". Say plainly there is no runtime instead.
  const runtimeModeLabel = !buildData.hasServer
    ? t.projectSettings.build.runtime.modeStatic
    : projectData?.runtimeMode === "docker"
      ? t.projectSettings.build.runtime.modeSandboxed
      : projectData?.runtimeMode === "bare"
        ? t.projectSettings.build.runtime.modeDirect
        : t.projectSettings.build.runtime.modeDefault;

  return (
    <div className="space-y-5">
      <SectionCard
        icon={Cpu}
        iconTone="orange"
        title={t.projectSettings.build.runtime.title}
        description={t.projectSettings.build.runtime.description}
        actions={<EditButton />}
      >
        <div className="overflow-hidden rounded-xl border border-border/40 divide-y divide-border/30">
          <Row label={t.projectSettings.build.runtime.framework} value={projectData?.framework} />
          <Row label={t.projectSettings.build.runtime.packageManager} value={projectData?.packageManager} />
          <Row label={t.projectSettings.build.runtime.runtimeIsolation} value={runtimeModeLabel} />
          {/* Resources moved to the editable ResourceSettings card below — one
              source, and it covers self-hosted (where limits are now a real
              choice) instead of being cloud-only and read-only. */}
          <Row label={t.projectSettings.build.runtime.runtimePort} value={buildData.productionPort} mono />
          <Row label={t.projectSettings.build.runtime.installCommand} value={buildData.installCommand} mono />
          <Row
            label={t.projectSettings.build.runtime.buildCommand}
            value={buildData.hasBuild ? buildData.buildCommand : t.projectSettings.build.runtime.noBuildStep}
            mono={buildData.hasBuild}
          />
          <Row label={t.projectSettings.build.runtime.outputDirectory} value={buildData.outputDirectory} mono />
          <Row label={t.projectSettings.build.runtime.rootDirectory} value={buildData.rootDirectory || "."} mono />
          {/* Only when pinned — a blank row would be noise for the vast majority
              of projects, whose compose file (if any) sits at the root. */}
          {buildData.composePath && (
            <Row label={t.projectSettings.build.runtime.composePath} value={buildData.composePath} mono />
          )}
          <Row
            label={t.projectSettings.build.runtime.startCommand}
            value={buildData.hasServer ? buildData.startCommand : t.projectSettings.build.runtime.staticNoServer}
            mono={buildData.hasServer}
          />
        </div>
      </SectionCard>

      {/* Machine power — cpu/memory caps. Editable in place, like Storage: you
          reach for it BECAUSE a container just got OOM-killed, and routing that
          through the full re-deploy wizard is the wrong shape. Only meaningful
          for a project that actually runs a container. */}
      {buildData.hasServer && <ResourceSettings />}

      {/* Storage — persistent paths + object storage. Editable in place (see the
          component's own note on why it doesn't route through the wizard). Only
          meaningful for a project with a running container. */}
      {buildData.hasServer && <StorageSettings />}

      {/* Environment variables — edited in place via a safe per-variable editor
          (diff-merge; untouched secrets are never re-sent), NOT the wizard. */}
      <SectionCard
        icon={KeyRound}
        iconTone="violet"
        title={t.projectSettings.build.env.title}
        description={t.projectSettings.build.env.description}
        actions={
          <button
            type="button"
            onClick={() => setEnvOpen(true)}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-border/60 bg-muted/30 px-3 py-1.5 text-sm font-medium text-foreground transition-colors hover:bg-muted/50"
          >
            <Pencil className="size-3.5" />
            {t.projectSettings.build.env.edit}
          </button>
        }
      />

      <EnvVarsEditor projectId={id} isOpen={envOpen} onClose={() => setEnvOpen(false)} />
    </div>
  );
};
