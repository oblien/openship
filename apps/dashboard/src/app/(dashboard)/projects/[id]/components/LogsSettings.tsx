"use client";

import React, { useState, useCallback, useEffect } from "react";
import { Terminal, Server } from "lucide-react";
import { useProjectSettings } from "@/context/ProjectSettingsContext";
import { TerminalLogs } from "./logs/TerminalLogs";
import { ServerLogs } from "./logs/ServerLogs";
import { LogsActions } from "./logs/LogsActions";
import { servicesApi, type Service } from "@/lib/api/services";
import { endpoints } from "@/lib/api/endpoints";
import { getProjectType } from "@repo/core";

type LogsTab = 'terminal' | 'server';

export const LogsSettings = () => {
  const { projectData, buildData, id, terminalLogsData, serverLogsData, clearTerminalLogs, clearServerLogs } = useProjectSettings();
  const isServicesProject = getProjectType(projectData?.framework as any) === 'services';
  const canShowTerminal = isServicesProject || buildData.hasServer;
  const [activeTab, setActiveTab] = useState<LogsTab>(canShowTerminal ? 'terminal' : 'server');
  const [copied, setCopied] = useState(false);
  const [currentLogs, setCurrentLogs] = useState<string[]>([]);
  const [services, setServices] = useState<Service[]>([]);
  const [servicesLoading, setServicesLoading] = useState(false);
  const [selectedServiceId, setSelectedServiceId] = useState<string | null>(null);

  useEffect(() => {
    if (!canShowTerminal && activeTab === 'terminal') {
      setActiveTab('server');
    }
  }, [canShowTerminal, activeTab]);

  useEffect(() => {
    if (!isServicesProject || !id) {
      setServices([]);
      setSelectedServiceId(null);
      return;
    }

    let cancelled = false;

    const loadServices = async () => {
      try {
        setServicesLoading(true);
        const response = await servicesApi.list(id);
        if (cancelled || !response.success) return;

        const nextServices = response.services ?? [];
        setServices(nextServices);
        setSelectedServiceId((current) => {
          if (current && nextServices.some((service) => service.id === current)) {
            return current;
          }
          return nextServices[0]?.id ?? null;
        });
      } finally {
        if (!cancelled) {
          setServicesLoading(false);
        }
      }
    };

    void loadServices();

    return () => {
      cancelled = true;
    };
  }, [isServicesProject, id]);

  const selectedService = services.find((service) => service.id === selectedServiceId) ?? null;
  const terminalStreamTarget = isServicesProject
    ? (selectedServiceId ? endpoints.services.logsStream(id, selectedServiceId) : '')
    : id;

  const handleLogsChange = useCallback((logs: string[]) => {
    setCurrentLogs(logs);
  }, []);

  // Update current logs when active tab or logs data changes
  useEffect(() => {
    if (activeTab === 'terminal') {
      setCurrentLogs(terminalLogsData.logs);
    } else {
      const serverLogsStrings = serverLogsData.logs.map(log =>
        `${log.timestamp} - ${log.ip} - ${log.method} ${log.path} - ${log.statusCode} - ${log.responseTime}ms`
      );
      setCurrentLogs(serverLogsStrings);
    }
  }, [activeTab, terminalLogsData.logs, serverLogsData.logs]);

  const copyLogs = useCallback(() => {
    if (currentLogs.length === 0) return;
    navigator.clipboard.writeText(currentLogs.join('\n'));
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [currentLogs]);

  const downloadLogs = useCallback(() => {
    if (currentLogs.length === 0) return;
    const blob = new Blob([currentLogs.join('\n')], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${activeTab}-logs-${new Date().toISOString()}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  }, [currentLogs, activeTab]);

  const clearLogs = useCallback(() => {
    if (currentLogs.length === 0) return;

    // Clear logs from context based on active tab
    if (activeTab === 'terminal') {
      clearTerminalLogs();
      // Also trigger the event for terminal to reset its display
      window.dispatchEvent(new CustomEvent('clearLogs'));
    } else {
      clearServerLogs();
    }
  }, [currentLogs, activeTab, clearTerminalLogs, clearServerLogs]);

  return (
    <div className="flex flex-col h-full gap-4">
      {/* Tabs + Actions */}
      <div className="flex items-center justify-between border-b border-border/50">
        <div className="flex items-center gap-1">
          {canShowTerminal && (
            <button
              onClick={() => setActiveTab('terminal')}
              className={`inline-flex items-center gap-2 px-4 py-2.5 text-sm font-medium transition-colors relative ${
                activeTab === 'terminal'
                  ? 'text-foreground'
                  : 'text-muted-foreground hover:text-foreground/70'
              }`}
            >
              <Terminal className="size-4" />
              Terminal
              {activeTab === 'terminal' && (
                <span className="absolute bottom-0 left-0 right-0 h-0.5 bg-primary rounded-full" />
              )}
            </button>
          )}
          <button
            onClick={() => setActiveTab('server')}
            className={`inline-flex items-center gap-2 px-4 py-2.5 text-sm font-medium transition-colors relative ${
              activeTab === 'server'
                ? 'text-foreground'
                : 'text-muted-foreground hover:text-foreground/70'
            }`}
          >
            <Server className="size-4" />
            Server
            {activeTab === 'server' && (
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
        {activeTab === 'terminal' && canShowTerminal && (
          <div className="space-y-4">
            {isServicesProject && (
              <div className="rounded-2xl border border-border/60 bg-card/70 p-4">
                <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
                  <div>
                    <p className="text-sm font-medium text-foreground">Service Runtime Logs</p>
                    <p className="text-sm text-muted-foreground">Use the normal Logs tab and switch between compose services here.</p>
                  </div>
                  <div className="min-w-[220px]">
                    <select
                      value={selectedServiceId ?? ''}
                      onChange={(event) => setSelectedServiceId(event.target.value || null)}
                      disabled={servicesLoading || services.length === 0}
                      className="w-full rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground outline-none"
                    >
                      {services.length === 0 && <option value="">No services found</option>}
                      {services.map((service) => (
                        <option key={service.id} value={service.id}>
                          {service.name}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
              </div>
            )}

            {isServicesProject && !selectedService ? (
              <div className="flex min-h-[420px] items-center justify-center rounded-3xl border border-border/50 bg-card text-sm text-muted-foreground">
                Select a service to view its runtime logs.
              </div>
            ) : (
              <TerminalLogs
                projectId={id}
                projectName={selectedService?.name || projectData?.name || 'Project'}
                streamTarget={terminalStreamTarget}
                onLogsChange={handleLogsChange}
              />
            )}
          </div>
        )}
        {activeTab === 'server' && (
          <ServerLogs
            projectId={id}
            projectName={projectData?.name || 'Project'}
            onLogsChange={handleLogsChange}
          />
        )}
      </div>
    </div>
  );
};
