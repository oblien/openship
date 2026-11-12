"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Icon } from "@repo/ui/icons";
import { resolveWorkload } from "@repo/core";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/components/i18n-provider";
import { useProjectSettings } from "@/context/ProjectSettingsContext";
import { ProjectEnvironmentPanel } from "@/components/project-settings/ProjectEnvironmentPanel";
import { ProjectStatusBadge } from "@/components/shared/ProjectStatusBadge";
import { RuntimeRoleConfigurationControl } from "@/components/services/RuntimeRoleConfiguration";
import { RuntimeRolesCard } from "@/components/services/RuntimeRoles";
import { canConfigureRuntimeRoles } from "@/lib/runtime-roles";
import { applicationServiceRoute, projectApplication } from "@/lib/project-application";
import { invalidateProjectCaches } from "@/hooks/useProjectEndpoints";
import { BuildSettings } from "../BuildSettings";
import { LogsSettings } from "../LogsSettings";
import { DomainSettings } from "../DomainSettings";
import { StorageSettings } from "../StorageSettings";
import {
  WorkloadDetailHeader,
  WORKLOAD_TABS,
  type WorkloadChoice,
  type WorkloadTab,
} from "./WorkloadDetailHeader";

/** Same navigation shell; the primary app retains its project runtime and env APIs. */
export function ProjectApplicationPanel({
  choices = [],
  onRefresh,
}: {
  choices?: WorkloadChoice[];
  onRefresh?: () => void | Promise<void>;
}) {
  const { id, slug, projectData, servicesData, domain, buildData } = useProjectSettings();
  const { t } = useI18n();
  const router = useRouter();
  const application = projectApplication(projectData, servicesData.services);
  const workload = resolveWorkload(
    projectData.options?.workloadType,
    projectData.options?.hasServer,
  );
  const supported = WORKLOAD_TABS.filter(
    (key) => key !== "terminal" && key !== "backup" && (key !== "volumes" || workload !== "static"),
  );
  const requested = slug?.[2] as WorkloadTab;
  const [activeTab, setActiveTab] = useState<WorkloadTab>(
    supported.includes(requested) ? requested : "overview",
  );
  const [envVisited, setEnvVisited] = useState(requested === "env");
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  useEffect(() => {
    setActiveTab(supported.includes(requested) ? requested : "overview");
    // The route can change through browser history without remounting the app.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requested, workload]);
  useEffect(() => {
    if (activeTab === "env") setEnvVisited(true);
  }, [activeTab]);
  const changeTab = (tab: WorkloadTab) => {
    if (busy) return;
    setActiveTab(tab);
    window.history.replaceState({}, "", `/projects/${id}/services/application/${tab}`);
  };
  const refresh = async () => {
    setRefreshing(true);
    try {
      invalidateProjectCaches(id);
      await onRefresh?.();
    } finally {
      setRefreshing(false);
    }
  };
  const runtimeLabel =
    workload === "static"
      ? t.projectSettings.build.runtime.modeStatic
      : projectData.runtimeMode === "bare"
        ? t.projectSettings.build.runtime.modeDirect
        : t.projectSettings.build.runtime.modeSandboxed;
  const details = [
    [t.projectSettings.build.runtime.framework, projectData.framework],
    [t.projectSettings.build.runtime.runtimeIsolation, runtimeLabel],
    [t.projectSettings.build.runtime.rootDirectory, buildData.rootDirectory || "."],
    ...(workload === "static"
      ? []
      : [
          [
            t.projectSettings.build.runtime.runtimePort,
            projectData.port || buildData.productionPort || "—",
          ],
        ]),
  ];
  return (
    <div className="min-w-0 space-y-5">
      <WorkloadDetailHeader
        id={application?.service?.id ?? "application"}
        name={projectData.name}
        icon={<Icon name="window" className="size-5 shrink-0 text-muted-foreground" />}
        status={
          <ProjectStatusBadge
            project={projectData}
            className="gap-1.5 bg-transparent text-xs font-medium before:size-2.5 before:shrink-0 before:rounded-full before:border-2 before:border-current"
          />
        }
        choices={choices}
        busy={busy}
        onBack={() => router.push(`/projects/${id}/services`)}
        onSwitch={(target) => {
          const service = servicesData.services.find((s) => s.id === target);
          router.push(
            `/projects/${id}/services/${service ? applicationServiceRoute(service) : target}/${activeTab}`,
          );
        }}
        actions={
          <>
            {projectData.activeDeploymentId && canConfigureRuntimeRoles(projectData) && (
              <RuntimeRoleConfigurationControl
                projectId={id}
                deploymentId={projectData.activeDeploymentId}
              />
            )}
            <Button asChild size="sm" variant="secondary">
              <Link href={`/projects/${id}/deployments`}>
                {t.projects.sidebar.tabs.deployments}
              </Link>
            </Button>
            <Button
              variant="ghost"
              size="icon"
              disabled={busy || refreshing}
              onClick={() => void refresh()}
              aria-label={t.projects.services.refresh}
            >
              <Icon name="refresh" className={refreshing ? "animate-spin" : undefined} />
            </Button>
          </>
        }
        tabs={supported.map((key) => ({
          key,
          label: t.projectDetail.services.detail.tabs[key],
          href: `/projects/${id}/services/application/${key}`,
        }))}
        value={activeTab}
        onChange={changeTab}
      />
      {activeTab === "overview" && (
        <>
          <section className="rounded-2xl border border-border/50 bg-card p-5">
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
              <h3 className="text-sm font-medium">{t.projectSettings.build.runtime.title}</h3>
              <Button variant="ghost" size="sm" onClick={() => changeTab("settings")}>
                <Icon name="edit" />
                {t.projectSettings.build.edit}
              </Button>
            </div>
            {domain && <p className="mb-5 break-all text-sm text-foreground">{domain}</p>}
            <dl className="grid grid-cols-1 gap-5 sm:grid-cols-2">
              {details.map(([label, value]) => (
                <div key={label}>
                  <dt className="text-xs text-muted-foreground">{label}</dt>
                  <dd className="mt-1.5 break-all text-sm">{value}</dd>
                </div>
              ))}
            </dl>
          </section>
          <RuntimeRolesCard projectId={id} deploymentId={projectData.activeDeploymentId} />
        </>
      )}
      {(envVisited || activeTab === "env") && (
        <div hidden={activeTab !== "env"}>
          <ProjectEnvironmentPanel key={id} onBusyChange={setBusy} />
        </div>
      )}
      {activeTab === "logs" && <LogsSettings applicationOnly />}
      {activeTab === "domains" && (
        <DomainSettings
          serviceScope={application?.service ? { serviceId: application.service.id } : undefined}
        />
      )}
      {activeTab === "volumes" && <StorageSettings />}
      {activeTab === "settings" && <BuildSettings scope="application" />}
    </div>
  );
}
