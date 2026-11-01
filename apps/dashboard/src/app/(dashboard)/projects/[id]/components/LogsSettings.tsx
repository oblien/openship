"use client";

import { Icon as UiIcon } from "@repo/ui/icons";

import React, { useState, useCallback, useEffect, useId, useRef, useMemo } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { useProjectSettings } from "@/context/ProjectSettingsContext";
import { workloadOf } from "@/context/deployment/types";
import { useI18n, interpolate } from "@/components/i18n-provider";
import { TerminalLogs } from "./logs/TerminalLogs";
import { ServerLogs } from "./logs/ServerLogs";
import { LogsActions } from "./logs/LogsActions";
import { CustomSelect } from "@/components/ui/CustomSelect";
import { Tabs } from "@/components/ui/Tabs";
import { ServiceIcon } from "@/components/services/ServiceIcon";
import { endpoints } from "@/lib/api/endpoints";
import { sortServicesByPublicFirst } from "@/lib/api/services";
import { hasSeparateApplication } from "@/lib/project-application";
import { useRuntimeRoles } from "@/hooks/useRuntimeRoles";
import { roleLogTargetKey, runtimeRoleLogTargets } from "@/lib/runtime-roles";
import { Button } from "@/components/ui/button";

type LogsTab = "terminal" | "server";

export const LogsSettings = () => {
  const {
    projectData,
    buildData,
    id,
    terminalLogsData,
    serverLogsData,
    clearTerminalLogs,
    clearServerLogs,
    servicesData,
  } = useProjectSettings();
  const { t } = useI18n();
  const tabsId = useId();
  const hasProjectId = Boolean(id && id !== "undefined");
  const hasResolvedServerMode =
    typeof projectData?.options?.hasServer === "boolean" ||
    typeof projectData?.hasServer === "boolean" ||
    buildData.isLoading === false;
  // A worker runs a container and produces logs like a web app; only a static
  // (edge-served) deploy has no runtime logs. Resolve the workload so a worker
  // (hasServer=false) still gets its logs surfaced (#538). Gate on
  // hasResolvedServerMode so we don't assume "web" before the data loads.
  const effectiveHasServer =
    hasResolvedServerMode &&
    workloadOf({
      workloadType: projectData?.workloadType ?? projectData?.options?.workloadType ?? buildData.workloadType,
      hasServer: projectData?.options?.hasServer ?? projectData?.hasServer ?? buildData.hasServer,
    }) !== "static";
  const searchParams = useSearchParams();
  const router = useRouter();
  const serviceIdFromUrl = searchParams.get("service");
  const roleFromUrl = searchParams.get("role");
  const roleReplicaFromUrl = Number(searchParams.get("replica") ?? 1);
  const roleDeploymentFromUrl = searchParams.get("deploymentId");
  const rolesRuntime = useRuntimeRoles(id, projectData?.activeDeploymentId);
  const roleTargets = useMemo(() => runtimeRoleLogTargets(rolesRuntime.data), [rolesRuntime.data]);
  const [activeTab, setActiveTab] = useState<LogsTab>("server");
  const hasSelectedTabRef = useRef(false);
  const [copied, setCopied] = useState(false);
  const [currentLogs, setCurrentLogs] = useState<string[]>([]);
  // Seed from URL so the "View logs" shortcut on a service detail can deep-link
  // straight to that service's logs. Falls back to the auto-pick logic below
  // if the URL param is missing or stale.
  const [selectedTarget, setSelectedTarget] = useState<string | null>(
    roleFromUrl
      ? roleLogTargetKey(
          roleDeploymentFromUrl ?? projectData?.activeDeploymentId ?? "",
          roleFromUrl,
          roleReplicaFromUrl,
        )
      : serviceIdFromUrl,
  );
  const urlDeepLinkAppliedRef = useRef(false);
  const requestedTarget = roleFromUrl
    ? roleLogTargetKey(
        roleDeploymentFromUrl ?? projectData?.activeDeploymentId ?? "",
        roleFromUrl,
        roleReplicaFromUrl,
      )
    : serviceIdFromUrl;
  const previousUrlTarget = useRef(requestedTarget);
  const urlSelectionChanged = previousUrlTarget.current !== requestedTarget;
  useEffect(() => {
    if (!urlSelectionChanged) return;
    previousUrlTarget.current = requestedTarget;
    urlDeepLinkAppliedRef.current = false;
    setSelectedTarget(requestedTarget);
  }, [requestedTarget, urlSelectionChanged]);
  // Public (exposed) services lead the target picker — the ones users browse to.
  const services = useMemo(
    () => sortServicesByPublicFirst(servicesData.services),
    [servicesData.services],
  );
  const servicesLoading = servicesData.isLoading;
  const servicesLoaded = !servicesData.isLoading;
  const hasServices = services.length > 0;
  // The shared application model distinguishes companion services from a
  // Compose/monorepo app whose primary runtime already has a service row.
  const hasProjectRuntime = effectiveHasServer && hasSeparateApplication(projectData, services);
  // Request logs come from the EDGE, not from a runtime process — so anything
  // served through an edge has them, whether or not it has a container to stream
  // stdout from. That's every project with a domain: cloud (Oblien's edge proxy)
  // and self-hosted alike (`/server-logs/stream` → the edge's mgmt API, including
  // a containerized edge via execMgmtStream).
  //
  // This used to be `deployTarget === "cloud"`, which meant a STATIC app on a
  // server — the case with no runtime logs by definition — showed "No runtime
  // logs, nothing to stream" while its edge was logging every request. The
  // backend already supported it (ServerLogs handles `kind: "self-hosted"`); only
  // this gate said no.
  const deployTarget = projectData?.deployTarget as string | null | undefined;
  const hasDomain = (projectData?.domains?.length ?? 0) > 0;
  const canShowRequestLogs = deployTarget === "cloud" || hasDomain;
  const canShowRuntimeLogs = effectiveHasServer || hasServices;
  const canShowLogs = canShowRuntimeLogs || canShowRequestLogs;
  // Terminal (container stdout) still requires an actual runtime —
  // no terminal output exists for static pages.
  const canShowTerminal = canShowRuntimeLogs;
  const hasResolvedLogTargets =
    hasResolvedServerMode && (effectiveHasServer || servicesLoaded || canShowRequestLogs);
  // True when there's more than one runtime to stream from - used to gate
  // the switcher UI. A "target" is the project's own runtime OR a service.
  // Previously this was `hasMultipleServices` (services count > 1) which
  // missed the common case of "single app + 1 service" where the user
  // still needs to pick which one to look at.
  const logTargetCount = (hasProjectRuntime ? 1 : 0) + services.length + roleTargets.length;
  const hasMultipleLogTargets = logTargetCount > 1 || Boolean(selectedTarget?.startsWith("role:"));

  useEffect(() => {
    if (!hasResolvedLogTargets) return;
    if (!canShowLogs) {
      setCurrentLogs([]);
      return;
    }

    if (!hasSelectedTabRef.current) {
      // Static projects only have request logs. Otherwise default to
      // Terminal as before.
      setActiveTab(canShowTerminal ? "terminal" : "server");
    }
  }, [hasResolvedLogTargets, canShowLogs, canShowTerminal]);

  // Apply `?service=X` once services are loaded: force the Terminal tab and pin
  // the selection. The param is KEPT in the URL (synced below) so the runtime-log
  // filter is visible, survives a refresh, and is shareable — rather than being
  // stripped the moment it's applied.
  useEffect(() => {
    if (urlDeepLinkAppliedRef.current) return;
    if (roleFromUrl) {
      if (rolesRuntime.loading || servicesLoading) return;
      urlDeepLinkAppliedRef.current = true;
      hasSelectedTabRef.current = true;
      setActiveTab("terminal");
      setSelectedTarget(
        roleLogTargetKey(
          roleDeploymentFromUrl ?? rolesRuntime.deploymentId ?? "",
          roleFromUrl,
          roleReplicaFromUrl,
        ),
      );
      return;
    }
    if (!serviceIdFromUrl || servicesLoading) return;
    urlDeepLinkAppliedRef.current = true;
    const match = services.find((s) => s.id === serviceIdFromUrl);
    // Stale/foreign id → leave selection to auto-pick; the sync effect clears
    // the bad param once a real target is chosen.
    if (!match) return;
    hasSelectedTabRef.current = true;
    setActiveTab("terminal");
    setSelectedTarget(match.id);
  }, [
    serviceIdFromUrl,
    services,
    servicesLoading,
    roleFromUrl,
    roleReplicaFromUrl,
    roleDeploymentFromUrl,
    rolesRuntime.loading,
    rolesRuntime.deploymentId,
  ]);

  // Keep the URL's `?service=` param in sync with the selected service so the
  // filter is a real, shareable, refresh-safe query param (null = project
  // runtime → no param). Guarded so we only replace when it actually changed.
  useEffect(() => {
    if (servicesLoading || urlSelectionChanged) return;
    if (roleFromUrl && !urlDeepLinkAppliedRef.current) return;
    const role = roleTargets.find((target) => target.value === selectedTarget);
    if (selectedTarget?.startsWith("role:") && !role) return;
    const query = new URLSearchParams(searchParams.toString());
    for (const key of ["service", "role", "replica", "deploymentId"]) query.delete(key);
    if (role) {
      query.set("role", role.role);
      query.set("replica", String(role.replica));
      query.set("deploymentId", role.deploymentId);
    } else if (selectedTarget) query.set("service", selectedTarget);
    if (query.toString() === searchParams.toString()) return;
    router.replace(`/projects/${id}/logs${query.size ? `?${query}` : ""}`, { scroll: false });
  }, [
    selectedTarget,
    servicesLoading,
    searchParams,
    id,
    router,
    roleTargets,
    roleFromUrl,
    urlSelectionChanged,
  ]);

  const switchTab = useCallback(
    (tab: LogsTab) => {
      if (!canShowLogs) return;
      if (tab === "terminal" && !canShowTerminal) return;
      hasSelectedTabRef.current = true;
      setActiveTab((current) => (current === tab ? current : tab));
    },
    [canShowLogs, canShowTerminal],
  );

  useEffect(() => {
    if (!hasProjectId || servicesLoading) return;

    setSelectedTarget((current) => {
      if (roleFromUrl && !urlDeepLinkAppliedRef.current) return current;
      // A role belongs to one release. A stale selection must not fall back
      // to the web application or a same-named role in a newer deployment.
      if (current?.startsWith("role:")) return current;
      if (hasMultipleLogTargets && current && services.some((service) => service.id === current)) {
        return current;
      }

      if (hasMultipleLogTargets) {
        // Multi-target: default to the project runtime if it exists,
        // otherwise the first service.
        return hasProjectRuntime ? null : (services[0]?.id ?? null);
      }

      return !hasProjectRuntime && services.length === 1 ? services[0].id : null;
    });
  }, [
    hasProjectRuntime,
    hasMultipleLogTargets,
    hasProjectId,
    services,
    servicesLoading,
    roleFromUrl,
  ]);

  const selectedService = services.find((service) => service.id === selectedTarget) ?? null;
  const implicitSingleService =
    !hasMultipleLogTargets && !hasProjectRuntime ? (services[0] ?? null) : null;
  const terminalService = hasMultipleLogTargets ? selectedService : implicitSingleService;
  const selectedRole = roleTargets.find((target) => target.value === selectedTarget);
  const roleSelected = Boolean(selectedTarget?.startsWith("role:"));
  const roleQuery = selectedRole
    ? `?${new URLSearchParams({ role: selectedRole.role, replica: String(selectedRole.replica), deploymentId: selectedRole.deploymentId })}`
    : "";
  const isServiceLogTarget = Boolean(terminalService);
  const terminalStreamTarget = !hasProjectId
    ? ""
    : isServiceLogTarget
      ? terminalService
        ? endpoints.services.logsStream(id, terminalService.id)
        : ""
      : roleSelected && !selectedRole
        ? ""
        : endpoints.projects.logsStream(id) + roleQuery;
  const terminalHistoryTarget = !hasProjectId
    ? ""
    : isServiceLogTarget
      ? terminalService
        ? endpoints.services.logs(id, terminalService.id)
        : ""
      : roleSelected && !selectedRole
        ? ""
        : endpoints.projects.logs(id) + roleQuery;

  const targetPicker = (
    <CustomSelect
      aria-label={t.projectSettings.logs.target}
      variant="filled"
      triggerClassName="h-9 font-medium"
      value={selectedTarget ?? ""}
      onChange={(value) => setSelectedTarget(value || null)}
      options={[
        ...(hasProjectRuntime
          ? [
              {
                value: "",
                label: t.projectSettings.logs.projectRuntime,
                icon: <UiIcon name="server" className="size-4" />,
              },
            ]
          : []),
        ...services.map((service) => ({
          value: service.id,
          label: service.name,
          icon: <ServiceIcon service={service} className="size-4 shrink-0" />,
        })),
        ...roleTargets.map((target) => ({
          value: target.value,
          label: `${target.role} · ${interpolate(t.projectDetail.runtimeRoles.replica, { replica: String(target.replica) })}`,
          icon: (
            <UiIcon name={target.kind === "scheduler" ? "clock" : "terminal"} className="size-4" />
          ),
        })),
      ]}
      placeholder={t.projectSettings.logs.selectService}
    />
  );

  const handleLogsChange = useCallback((logs: string[]) => {
    setCurrentLogs(logs);
  }, []);

  // Update current logs when active tab or logs data changes
  useEffect(() => {
    if (!canShowLogs) {
      setCurrentLogs([]);
      return;
    }

    if (activeTab === "terminal") {
      setCurrentLogs(terminalLogsData.logs);
    } else {
      const serverLogsStrings = serverLogsData.logs.map(
        (log) =>
          `${log.timestamp} - ${log.ip} - ${log.method} ${log.path} - ${log.statusCode} - ${log.responseTime}ms`,
      );
      setCurrentLogs(serverLogsStrings);
    }
  }, [activeTab, canShowLogs, terminalLogsData.logs, serverLogsData.logs]);

  const copyLogs = useCallback(() => {
    if (currentLogs.length === 0) return;
    navigator.clipboard.writeText(currentLogs.join("\n"));
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [currentLogs]);

  const downloadLogs = useCallback(() => {
    if (currentLogs.length === 0) return;
    const blob = new Blob([currentLogs.join("\n")], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${activeTab}-logs-${new Date().toISOString()}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  }, [currentLogs, activeTab]);

  const clearLogs = useCallback(() => {
    if (currentLogs.length === 0) return;

    // Clear logs from context based on active tab
    if (activeTab === "terminal") {
      clearTerminalLogs();
      // Also trigger the event for terminal to reset its display
      window.dispatchEvent(new CustomEvent("clearLogs"));
    } else {
      clearServerLogs();
    }
  }, [currentLogs, activeTab, clearTerminalLogs, clearServerLogs]);

  if (!hasResolvedLogTargets) {
    return (
      <div className="rounded-2xl border border-border/50 bg-card p-8">
        <div className="space-y-3">
          <div className="h-4 w-32 animate-pulse rounded bg-muted" />
          <div className="h-20 animate-pulse rounded-xl bg-muted/70" />
        </div>
      </div>
    );
  }

  if (hasResolvedLogTargets && !canShowLogs) {
    return (
      <div className="rounded-2xl border border-border/50 bg-card p-8 text-center">
        <div className="mx-auto mb-3 flex size-11 items-center justify-center rounded-full bg-muted text-muted-foreground">
          <UiIcon name="terminal" className="size-5" />
        </div>
        <h3 className="text-sm font-semibold text-foreground">{t.projectSettings.logs.noRuntime}</h3>
        <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
          {t.projectSettings.logs.noRuntimeDesc}
        </p>
      </div>
    );
  }

  return (
    <div className="flex min-w-0 flex-col h-full gap-4">
      {/* Tabs + Actions */}
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        {canShowTerminal && (
          <Tabs<LogsTab>
            idPrefix={tabsId}
            ariaLabel={t.projectDetail.services.detail.tabs.logs}
            variant="pills"
            tabs={[
              { key: "terminal", label: t.projectSettings.logs.terminal, icon: "terminal" },
              { key: "server", label: t.projectSettings.logs.server, icon: "server" },
            ]}
            value={activeTab}
            onChange={switchTab}
          />
        )}

        <div className="ms-auto">
          <LogsActions
            onCopy={copyLogs}
            onDownload={downloadLogs}
            onClear={clearLogs}
            copied={copied}
            logsCount={currentLogs.length}
          />
        </div>
      </div>

      {/* Content */}
      <div className="min-w-0 flex-1 min-h-[460px]">
        <div
          id={`${tabsId}-panel-terminal`}
          role={canShowTerminal ? "tabpanel" : undefined}
          aria-labelledby={canShowTerminal ? `${tabsId}-tab-terminal` : undefined}
          hidden={activeTab !== "terminal" || !canShowTerminal}
        >
          {activeTab === "terminal" &&
            canShowTerminal &&
            (roleSelected && !selectedRole ? (
              <div
                role="alert"
                className="space-y-3 rounded-2xl bg-card p-5 text-sm text-muted-foreground"
              >
                {targetPicker}
                <p>
                  {rolesRuntime.loading
                    ? t.projectDetail.runtimeRoles.checking
                    : (rolesRuntime.error ?? t.projectDetail.runtimeRoles.staleTarget)}
                </p>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={rolesRuntime.loading}
                  onClick={() => void rolesRuntime.refresh()}
                >
                  {t.projectDetail.runtimeRoles.retry}
                </Button>
              </div>
            ) : hasMultipleLogTargets && !hasProjectRuntime && !selectedService && !selectedRole ? (
              <div className="flex min-h-[420px] items-center justify-center rounded-2xl bg-card text-sm text-muted-foreground">
                {t.projectSettings.logs.selectService}
              </div>
            ) : (
              <TerminalLogs
                projectId={id}
                projectName={
                  selectedRole
                    ? `${selectedRole.role} · ${interpolate(t.projectDetail.runtimeRoles.replica, { replica: String(selectedRole.replica) })}`
                    : terminalService?.name ||
                      projectData?.name ||
                      t.projectSettings.logs.projectFallback
                }
                title={hasMultipleLogTargets ? targetPicker : undefined}
                streamTarget={terminalStreamTarget}
                historyTarget={terminalHistoryTarget}
                onLogsChange={handleLogsChange}
              />
            )
          )}
        </div>
        <div
          id={`${tabsId}-panel-server`}
          role={canShowTerminal ? "tabpanel" : "region"}
          aria-labelledby={canShowTerminal ? `${tabsId}-tab-server` : undefined}
          aria-label={!canShowTerminal ? t.projectSettings.logs.requests : undefined}
          hidden={activeTab !== "server"}
        >
          {activeTab === "server" && canShowLogs && hasProjectId && (
            <ServerLogs
              projectId={id}
              projectName={projectData?.name || t.projectSettings.logs.projectFallback}
              onLogsChange={handleLogsChange}
            />
          )}
        </div>
      </div>
    </div>
  );
};
