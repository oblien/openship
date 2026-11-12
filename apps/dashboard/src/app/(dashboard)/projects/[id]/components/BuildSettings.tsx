"use client";

import { Icon as UiIcon, type IconName } from "@repo/ui/icons";
import React, { useState } from "react";
import Link from "next/link";
import { isServicesFramework } from "@repo/core";
import { useProjectSettings } from "@/context/ProjectSettingsContext";
import { useI18n } from "@/components/i18n-provider";
import { BuildCacheMigration } from "@/components/project-settings/DeploymentAutomation";
import { RuntimeSourceUpdate } from "@/components/updates/RuntimeSourceUpdate";
import { projectApplication } from "@/lib/project-application";
import { EnvVarsEditor } from "./EnvVarsEditor";
import { ResourceSettings } from "./ResourceSettings";

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
  icon: IconName;
  iconTone?: keyof typeof ICON_TONES;
  title: string;
  description: string;
  actions?: React.ReactNode;
  children?: React.ReactNode;
}) {
  return (
    <div className="overflow-hidden rounded-2xl border border-border/50 bg-card">
      <div
        className={`flex items-start gap-3 px-5 py-4 ${children ? "border-b border-border/40" : ""}`}
      >
        <div
          className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl ${ICON_TONES[iconTone]}`}
        >
          <UiIcon name={Icon} className="size-4" />
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

/** Project-owned settings stay here regardless of the number of workloads. */
export const BuildSettings = () => {
  const { buildData, projectData, servicesData, id } = useProjectSettings();
  const { t } = useI18n();
  const application = projectApplication(projectData, servicesData.services);
  const hasRepo = Boolean(projectData.gitOwner && projectData.gitRepo);
  const composeSource =
    Boolean(projectData.composePath) || isServicesFramework(projectData.framework);

  if (projectData.framework === "webmail") {
    return (
      <SectionCard
        icon="inbox"
        iconTone="muted"
        title={t.projectSettings.build.webmail.title}
        description={t.projectSettings.build.webmail.description}
      />
    );
  }

  return (
    <div className="space-y-5">
      {application && (
        <SectionCard
          icon="window"
          iconTone="orange"
          title={projectData.name}
          description={t.projects.services.applicationHint}
          actions={
            <Link
              href={`/projects/${id}/services/application/settings`}
              className="inline-flex items-center gap-1.5 text-sm font-medium text-foreground hover:underline underline-offset-4"
            >
              {t.projectDetail.services.detail.tabs.settings}
              <UiIcon name="arrow-right" className="size-3.5 rtl:rotate-180" />
            </Link>
          }
        />
      )}
      {hasRepo && composeSource && (
        <RuntimeSourceUpdate
          projectId={id}
          initialPath={buildData.composePath || "docker-compose.yml"}
        />
      )}
      <ProjectEnvironmentSettings />
      <BuildCacheMigration key={id} projectId={id} />
      <ResourceSettings />
    </div>
  );
};

/** One shared editor, accessible here and through workload shortcuts. */
export function ProjectEnvironmentSettings() {
  const { id, projectData, servicesData } = useProjectSettings();
  const { t } = useI18n();
  const [envOpen, setEnvOpen] = useState(false);
  const application = projectApplication(projectData, servicesData.services);
  const opensApplication = application?.mode === "project" &&
    !servicesData.services.some((service) => !service.applicationMode);
  return (
    <>
      <SectionCard
        icon="key"
        iconTone="violet"
        title={t.projectSettings.build.env.title}
        description={t.projectSettings.build.env.description}
        actions={opensApplication ? (
          <Link
            href={`/projects/${id}/services/application/env`}
            className="inline-flex items-center gap-1.5 text-sm font-medium text-foreground hover:underline underline-offset-4"
          >
            {t.projectDetail.services.detail.tabs.env}
            <UiIcon name="arrow-right" className="size-3.5 rtl:rotate-180" />
          </Link>
        ) : (
          <button
            type="button"
            onClick={() => setEnvOpen(true)}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-border/60 bg-muted/30 px-3 py-1.5 text-sm font-medium text-foreground transition-colors hover:bg-muted/50"
          >
            <UiIcon name="edit" className="size-3.5" />
            {t.projectSettings.build.env.edit}
          </button>
        )}
      />
      {!opensApplication && (
        <EnvVarsEditor key={id} projectId={id} isOpen={envOpen} onClose={() => setEnvOpen(false)} />
      )}
    </>
  );
}
