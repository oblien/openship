"use client";

import React, { useState, useCallback, useEffect } from "react";
import { Terminal, Server } from "lucide-react";
import { useProjectSettings } from "@/context/ProjectSettingsContext";
import { TerminalLogs } from "./logs/TerminalLogs";
import { ServerLogs } from "./logs/ServerLogs";
import { LogsActions } from "./logs/LogsActions";

type LogsTab = 'terminal' | 'server';

export const LogsSettings = () => {
  const { projectData, buildData, id, terminalLogsData, serverLogsData, clearTerminalLogs, clearServerLogs } = useProjectSettings();
  const [activeTab, setActiveTab] = useState<LogsTab>(buildData.hasServer ? 'terminal' : 'server');
  const [copied, setCopied] = useState(false);
  const [currentLogs, setCurrentLogs] = useState<string[]>([]);

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
      {/* Tabs - Top */}
      <div className="flex items-center gap-3">
        {buildData.hasServer && <button
          onClick={() => setActiveTab('terminal')}
          className={`relative flex items-center gap-2.5 px-5 py-3 rounded-xl font-medium text-sm transition-all ${activeTab === 'terminal'
            ? 'bg-card text-foreground shadow-md border border-border'
            : 'bg-transparent text-muted-foreground hover:text-foreground hover:bg-card/50'
            }`}
        >
          {activeTab === 'terminal' && (
            <div className="absolute left-0 top-1/2 -translate-y-1/2 w-1 h-8 bg-primary rounded-r-full"></div>
          )}
          <div className={`w-2 h-2 rounded-full transition-colors ${activeTab === 'terminal' ? 'bg-primary' : 'bg-muted-foreground/30'
            }`}></div>
          <Terminal className="w-4 h-4" />
          Terminal Logs
        </button>}
        <button
          onClick={() => setActiveTab('server')}
          className={`relative flex items-center gap-2.5 px-5 py-3 rounded-xl font-medium text-sm transition-all ${activeTab === 'server'
            ? 'bg-card text-foreground shadow-md border border-border'
            : 'bg-transparent text-muted-foreground hover:text-foreground hover:bg-card/50'
            }`}
        >
          {activeTab === 'server' && (
            <div className="absolute left-0 top-1/2 -translate-y-1/2 w-1 h-8 bg-emerald-500 rounded-r-full"></div>
          )}
          <div className={`w-2 h-2 rounded-full transition-colors ${activeTab === 'server' ? 'bg-emerald-500' : 'bg-muted-foreground/30'
            }`}></div>
          <Server className="w-4 h-4" />
          Server Logs
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 min-h-[500px]">
        {activeTab === 'terminal' && buildData.hasServer && (
          <TerminalLogs
            projectId={id}
            projectName={projectData?.name || 'Project'}
            onLogsChange={handleLogsChange}
          />
        )}
        {activeTab === 'server' && (
          <ServerLogs
            projectId={id}
            projectName={projectData?.name || 'Project'}
            onLogsChange={handleLogsChange}
          />
        )}
      </div>

      {/* Actions Bar - Bottom */}
      <div className="bg-muted/40 rounded-2xl px-6 py-4 border border-border/50 shadow-sm">
        <div className="flex items-center justify-center">
          <LogsActions
            onCopy={copyLogs}
            onDownload={downloadLogs}
            onClear={clearLogs}
            copied={copied}
            logsCount={currentLogs.length}
          />
        </div>
      </div>
    </div>
  );
};
