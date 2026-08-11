"use client";

import React, { useState, useCallback, useEffect, useRef, useMemo } from "react";
import { Terminal, Server } from "lucide-react";
import { useSearchParams, useRouter } from "next/navigation";
import { useProjectSettings } from "@/context/ProjectSettingsContext";
import { useI18n } from "@/components/i18n-provider";
import { TerminalLogs } from "./logs/TerminalLogs";
import { ServerLogs } from "./logs/ServerLogs";
import { LogsActions } from "./logs/LogsActions";
import { CustomSelect } from "@/components/ui/CustomSelect";
import { endpoints } from "@/lib/api/endpoints";
import { sortServicesByPublicFirst } from "@/lib/api/services";

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
  const hasProjectId = Boolean(id && id !== "undefined");
  const hasResolvedServerMode =
    typeof projectData?.options?.hasServer === "boolean" ||
    typeof projectData?.hasServer === "boolean" ||
    buildData.isLoading === false;
  const effectiveHasServer =
    projectData?.options?.hasServer === true ||
    projectData?.hasServer === true ||
    (buildData.isLoading === false && buildData.hasServer === true);
  const searchParams = useSearchParams();
  const router = useRouter();
  const serviceIdFromUrl = searchParams.get("service");
  const [activeTab, setActiveTab] = useState<LogsTab>("server");
  const hasSelectedTabRef = useRef(false);
  const [copied, setCopied] = useState(false);
  const [currentLogs, setCurrentLogs] = useState<string[]>([]);
  // Seed from URL so the "View logs" shortcut on a service detail can deep-link
  // straight to that service's logs. Falls back to the auto-pick logic below
  // if the URL param is missing or stale.
  const [selectedServiceId, setSelectedServiceId] = useState<string | null>(serviceIdFromUrl);
  const urlDeepLinkAppliedRef = useRef(false);
  // Public (exposed) services lead the target picker — the ones users browse to.
  const services = useMemo(
    () => sortServicesByPublicFirst(servicesData.services),
    [servicesData.services],
  );
  const servicesLoading = servicesData.isLoading;
  const servicesLoaded = !servicesData.isLoading;
  const hasServices = services.length > 0;
  // A project has a standalone "project runtime" log source ONLY when it has no
  // services. A services/compose project's runtime IS its services — there's no
  // project-level container, so `projects/:id/logs` 404s for it. Treating
  // `effectiveHasServer` as a project-runtime log target was the bug: it offered
  // + defaulted "Project runtime" for services projects, which 404'd.
  const hasProjectRuntime = effectiveHasServer && !hasServices;
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
  // True when the only signal available is edge access logs — used to
  // relabel the Server tab as "Requests" so the operator knows what
  // they're looking at.
  const isRequestLogsOnly = canShowRequestLogs && !canShowRuntimeLogs;
  // True when there's more than one runtime to stream from - used to gate
  // the switcher UI. A "target" is the project's own runtime OR a service.
  // Previously this was `hasMultipleServices` (services count > 1) which
  // missed the common case of "single app + 1 service" where the user
  // still needs to pick which one to look at.
  const logTargetCount = (hasProjectRuntime ? 1 : 0) + services.length;
  const hasMultipleLogTargets = logTargetCount > 1;

  useEffect(() => {
    if (!hasResolvedLogTargets) return;
    if (!canShowLogs) {
      setCurrentLogs([]);
      return;
    }

    if (!hasSelectedTabRef.current) {
      // Static-only projects have no Terminal tab — land directly on
      // Server (which renders as "Requests"). Otherwise default to
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
    if (!serviceIdFromUrl || servicesLoading) return;
    urlDeepLinkAppliedRef.current = true;
    const match = services.find((s) => s.id === serviceIdFromUrl);
    // Stale/foreign id → leave selection to auto-pick; the sync effect clears
    // the bad param once a real target is chosen.
    if (!match) return;
    hasSelectedTabRef.current = true;
    setActiveTab("terminal");
    setSelectedServiceId(match.id);
  }, [serviceIdFromUrl, services, servicesLoading]);

  // Keep the URL's `?service=` param in sync with the selected service so the
  // filter is a real, shareable, refresh-safe query param (null = project
  // runtime → no param). Guarded so we only replace when it actually changed.
  useEffect(() => {
    if (servicesLoading) return;
    const current = searchParams.get("service");
    if ((selectedServiceId ?? null) === (current ?? null)) return;
    const qs = selectedServiceId ? `?service=${encodeURIComponent(selectedServiceId)}` : "";
    router.replace(`/projects/${id}/logs${qs}`, { scroll: false });
  }, [selectedServiceId, servicesLoading, searchParams, id, router]);

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

    setSelectedServiceId((current) => {
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
  }, [hasProjectRuntime, hasMultipleLogTargets, hasProjectId, services, servicesLoading]);

  const selectedService = services.find((service) => service.id === selectedServiceId) ?? null;
  const implicitSingleService =
    !hasMultipleLogTargets && !hasProjectRuntime ? (services[0] ?? null) : null;
  const terminalService = hasMultipleLogTargets ? selectedService : implicitSingleService;
  const isServiceLogTarget = Boolean(terminalService);
  const terminalStreamTarget = !hasProjectId
    ? ""
    : isServiceLogTarget
      ? terminalService
        ? endpoints.services.logsStream(id, terminalService.id)
        : ""
      : endpoints.projects.logsStream(id);
  const terminalHistoryTarget = !hasProjectId
    ? ""
    : isServiceLogTarget
      ? terminalService
        ? endpoints.services.logs(id, terminalService.id)
        : ""
      : endpoints.projects.logs(id);

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
          <Terminal className="size-5" />
        </div>
        <h3 className="text-sm font-semibold text-foreground">{t.projectSettings.logs.noRuntime}</h3>
        <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
          {t.projectSettings.logs.noRuntimeDesc}
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full gap-4">
      {/* Tabs + Actions */}
      <div className="flex items-center justify-between border-b border-border/50">
        <div className="flex items-center gap-1">
          {canShowTerminal && (
            <button
              onClick={() => switchTab("terminal")}
              className={`inline-flex items-center gap-2 px-4 py-2.5 text-sm font-medium transition-colors relative ${
                activeTab === "terminal"
                  ? "text-foreground"
                  : "text-muted-foreground hover:text-foreground/70"
              }`}
            >
              <Terminal className="size-4" />
              {t.projectSettings.logs.terminal}
              {activeTab === "terminal" && (
                <span className="absolute bottom-0 start-0 end-0 h-0.5 bg-primary rounded-full" />
              )}
            </button>
          )}
          <button
            onClick={() => switchTab("server")}
            className={`inline-flex items-center gap-2 px-4 py-2.5 text-sm font-medium transition-colors relative ${
              activeTab === "server"
                ? "text-foreground"
                : "text-muted-foreground hover:text-foreground/70"
            }`}
          >
            <Server className="size-4" />
            {/* Rename to "Requests" when there's no runtime — the
                same endpoint backs both, but for static apps it's
                purely edge access logs, not server logs. */}
            {isRequestLogsOnly ? t.projectSettings.logs.requests : t.projectSettings.logs.server}
            {activeTab === "server" && (
              <span className="absolute bottom-0 left-0 right-0 h-0.5 bg-primary rounded-full" />
            )}
          </button>
        </div>

        <LogsActions
          onCopy={copyLogs}
          onDownload={downloadLogs}
          onClear={clearLogs}
          copied={copied}
          logsCount={currentLogs.length}
        />
      </div>

      {/* Content */}
      <div className="flex-1 min-h-[460px]">
        {activeTab === "terminal" && canShowTerminal && (
          <div className="space-y-4">
            {hasMultipleLogTargets && (
              <div className="rounded-2xl border border-border/60 bg-card/70 p-4">
                <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
                  <div>
                    <p className="text-sm font-medium text-foreground">{t.projectSettings.logs.target}</p>
                    <p className="text-sm text-muted-foreground">
                      {hasProjectRuntime
                        ? t.projectSettings.logs.targetDescProject
                        : t.projectSettings.logs.targetDescService}
                    </p>
                  </div>
                  <div className="min-w-[220px]">
                    <CustomSelect
                      value={selectedServiceId ?? ""}
                      onChange={(value) => setSelectedServiceId(value || null)}
                      options={[
                        ...(hasProjectRuntime
                          ? [{ value: "", label: t.projectSettings.logs.projectRuntime, icon: <Server className="size-4" /> }]
                          : []),
                        ...services.map((service) => ({
                          value: service.id,
                          label: service.name,
                          icon: <Server className="size-4" />,
                        })),
                      ]}
                      placeholder={t.projectSettings.logs.selectService}
                    />
                  </div>
                </div>
              </div>
            )}

            {hasMultipleLogTargets && !hasProjectRuntime && !selectedService ? (
              <div className="flex min-h-[420px] items-center justify-center rounded-3xl border border-border/50 bg-card text-sm text-muted-foreground">
                {t.projectSettings.logs.selectService}
              </div>
            ) : (
              <TerminalLogs
                projectId={id}
                projectName={terminalService?.name || projectData?.name || t.projectSettings.logs.projectFallback}
                streamTarget={terminalStreamTarget}
                historyTarget={terminalHistoryTarget}
                onLogsChange={handleLogsChange}
              />
            )}
          </div>
        )}
        {activeTab === "server" && canShowLogs && hasProjectId && (
          <ServerLogs
            projectId={id}
            projectName={projectData?.name || t.projectSettings.logs.projectFallback}
            onLogsChange={handleLogsChange}
          />
        )}
      </div>
    </div>
  );
};
