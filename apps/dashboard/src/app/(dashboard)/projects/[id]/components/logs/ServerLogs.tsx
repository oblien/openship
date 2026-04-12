"use client";

import React, { useState, useEffect, useCallback, useMemo } from "react";
import { Server, Clock, User, AlertCircle } from "lucide-react";
import { getCountryFlagUrl } from "@/lib/country";
import './logs.css';
import { useProjectSettings } from "@/context/ProjectSettingsContext";
import { getApiBaseUrl, api } from "@/lib/api";
import { endpoints } from "@/lib/api/endpoints";

interface ServerLog {
  id: string;
  timestamp: string;
  ip: string;
  country?: string;
  method: string;
  path: string;
  statusCode: number;
  userAgent: string;
  responseTime: number;
  requestSize?: number;
  responseSize?: number;
}

interface ServerLogsProps {
  projectId: string;
  projectName: string;
  onLogsChange: (logs: string[]) => void;
}

export const ServerLogs: React.FC<ServerLogsProps> = ({
  projectId,
  projectName,
  onLogsChange,
}) => {
  const { serverLogsData, addServerLog, mergeServerLogs, setServerLogs } = useProjectSettings();
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const formatBytes = useCallback((bytes?: number) => {
    const b = typeof bytes === 'number' ? bytes : 0;
    if (b < 1024) return `${b} B`;
    const kb = b / 1024;
    if (kb < 1024) return `${kb.toFixed(1)} KB`;
    const mb = kb / 1024;
    if (mb < 1024) return `${mb.toFixed(2)} MB`;
    return `${(mb / 1024).toFixed(2)} GB`;
  }, []);

  // Normalize a ring-buffer entry (short keys) into our ServerLog shape
  const normalizeRingEntry = useCallback((d: any): ServerLog | null => {
    if (!d || typeof d !== 'object') return null;
    return {
      id: `hist-${d.ts}-${Math.random().toString(36).slice(2, 8)}`,
      timestamp: d.ts ? new Date(d.ts * 1000).toISOString() : new Date().toISOString(),
      ip: d.ip || '-',
      country: d.country,
      method: d.method || 'GET',
      path: d.uri || '/',
      statusCode: typeof d.status === 'number' ? d.status : (parseInt(d.status, 10) || 0),
      userAgent: d.ua || '',
      responseTime: typeof d.rt === 'number' ? Math.round(d.rt * 1000) : 0,
      requestSize: typeof d.bw_in === 'number' ? d.bw_in : 0,
      responseSize: typeof d.bw_out === 'number' ? d.bw_out : 0,
    };
  }, []);

  useEffect(() => {
    setServerLogs([]);
    setError(null);
    setIsLoading(true);

    let cancelled = false;
    const url = `${getApiBaseUrl()}projects/${projectId}/server-logs/stream`;
    const es = new EventSource(url, { withCredentials: true });

    es.addEventListener("request", (e) => {
      try {
        const d = JSON.parse(e.data);
        if (!d || typeof d !== 'object') return;

        if (d.error) {
          setError(d.error);
          setIsLoading(false);
          return;
        }

        if (d.uri || d.method) {
          setIsLoading(false);
          addServerLog({
            id: d.id || `${Date.now()}-${Math.random().toString(36).slice(2)}`,
            timestamp: d.date || (d.timestamp ? new Date(d.timestamp * 1000).toISOString() : new Date().toISOString()),
            ip: d.ip || '-',
            country: d.country,
            method: d.method || 'GET',
            path: d.uri || '/',
            statusCode: typeof d.status === 'number' ? d.status : (parseInt(d.status, 10) || 0),
            userAgent: d.userAgent || '',
            responseTime: typeof d.responseTime === 'number' ? Math.round(d.responseTime * 1000) : 0,
            requestSize: typeof d.requestSize === 'number' ? d.requestSize : (parseInt(d.requestSize, 10) || 0),
            responseSize: typeof d.responseSize === 'number' ? d.responseSize : (parseInt(d.responseSize, 10) || 0),
          });
        }
      } catch { /* malformed data */ }
    });

    es.addEventListener("error", (e) => {
      const me = e as MessageEvent;
      if (me.data) {
        try {
          const d = JSON.parse(me.data);
          setError(d.error || "Stream error");
        } catch {
          setError(me.data);
        }
      }
      if (es.readyState === EventSource.CLOSED) {
        setError("Connection to log stream lost");
      }
      setIsLoading(false);
    });

    es.onopen = () => {
      setError(null);
      setIsLoading(false);
    };

    // Fetch recent logs in parallel and merge them behind live data.
    api.get<{ logs: any[] }>(endpoints.projects.serverLogsRecent(projectId), {
      params: { limit: 100 },
    }).then((res) => {
      if (cancelled) return;
      if (res.logs?.length) {
        const entries = res.logs
          .map(normalizeRingEntry)
          .filter((e): e is ServerLog => e !== null)
          .sort((a, b) => +new Date(b.timestamp) - +new Date(a.timestamp));
        if (entries.length > 0) {
          mergeServerLogs(entries);
        }
      }
    }).catch(() => {
      // Non-fatal — live stream stays active even if history fetch fails.
    });

    return () => {
      cancelled = true;
      es.close();
    };
  }, [projectId, setServerLogs, addServerLog, mergeServerLogs, normalizeRingEntry]);

  const logsStrings = useMemo(() => {
    return serverLogsData.logs.map((log: any) =>
      `${log.timestamp} - ${log.ip} - ${log.method} ${log.path} - ${log.statusCode} - ${log.responseTime}ms`
    );
  }, [serverLogsData.logs]);

  useEffect(() => {
    onLogsChange(logsStrings);
  }, [logsStrings]);

  const getStatusColor = useCallback((code: number) => {
    if (code >= 200 && code < 300) return 'text-emerald-600 dark:text-emerald-400 bg-emerald-500/10';
    if (code >= 300 && code < 400) return 'text-blue-600 dark:text-blue-400 bg-blue-500/10';
    if (code >= 400 && code < 500) return 'text-amber-600 dark:text-amber-400 bg-amber-500/10';
    return 'text-red-600 dark:text-red-400 bg-red-500/10';
  }, []);

  const getMethodColor = useCallback((method: string) => {
    switch (method) {
      case 'GET': return 'text-blue-600 dark:text-blue-400 bg-blue-500/10';
      case 'POST': return 'text-emerald-600 dark:text-emerald-400 bg-emerald-500/10';
      case 'PUT': return 'text-amber-600 dark:text-amber-400 bg-amber-500/10';
      case 'DELETE': return 'text-red-600 dark:text-red-400 bg-red-500/10';
      default: return 'text-muted-foreground bg-muted/60';
    }
  }, []);

  // Empty / error / loading states
  const renderEmpty = () => {
    if (isLoading) {
      return (
        <div className="flex flex-col gap-3 p-4">
          {Array.from({ length: 6 }).map((_, idx) => (
            <div key={idx} className="animate-pulse flex items-center gap-3">
              <div className="w-12 h-5 rounded-md bg-muted" />
              <div className="flex-1 h-4 rounded-md bg-muted" />
              <div className="w-12 h-5 rounded-md bg-muted" />
              <div className="w-10 h-4 rounded-md bg-muted" />
            </div>
          ))}
        </div>
      );
    }

    if (error) {
      return (
        <div className="flex flex-col items-center justify-center py-16 gap-3">
          <AlertCircle className="w-10 h-10 text-destructive/60" />
          <p className="text-sm font-medium text-destructive">{error}</p>
          <p className="text-xs text-muted-foreground">Make sure the server has analytics scripts deployed</p>
        </div>
      );
    }

    return (
      <div className="flex flex-col items-center justify-center py-16 gap-2">
        <Server className="w-10 h-10 text-muted-foreground/30" />
        <p className="text-sm text-muted-foreground">Waiting for incoming requests…</p>
      </div>
    );
  };

  return (
    <div className="bg-card rounded-2xl border border-border/50 overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-5 py-4 border-b border-border/50">
        <div className="flex items-center gap-2.5">
          <Server className="w-4 h-4 text-muted-foreground" />
          <h3 className="text-sm font-medium text-foreground">HTTP Request Logs</h3>
        </div>
        {!error && (
          <div className="flex items-center gap-1.5">
            <div className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
            <span className="text-xs text-muted-foreground">Live</span>
          </div>
        )}
      </div>

      {/* Logs */}
      <div className="max-h-[460px] overflow-y-auto server-logs-scroll">
        {serverLogsData.logs.length === 0 ? renderEmpty() : (
          <div className="divide-y divide-border/30">
            {serverLogsData.logs.map((log: any) => (
              <div key={log.id} className="group px-5 py-2.5 hover:bg-muted/30 transition-colors">
                <div className="flex items-center gap-2">
                  <span className={`w-[52px] shrink-0 text-center px-1.5 py-0.5 rounded-md text-[11px] font-bold ${getMethodColor(log.method)}`}>
                    {log.method}
                  </span>
                  <span className="flex-1 text-[13px] font-medium text-foreground font-mono truncate">
                    {log.path}
                  </span>
                  <span className={`w-10 shrink-0 text-center px-1.5 py-0.5 rounded-md text-[11px] font-bold tabular-nums ${getStatusColor(log.statusCode)}`}>
                    {log.statusCode}
                  </span>
                  <span className="w-16 shrink-0 text-right text-[11px] text-muted-foreground/70 font-mono tabular-nums">
                    {log.responseTime}ms
                  </span>
                </div>
                <div className="flex items-center gap-3 mt-1 pl-[60px] text-[11px] text-muted-foreground">
                  <span className="flex items-center gap-1 shrink-0">
                    <Clock className="w-3 h-3" />
                    <span className="font-mono tabular-nums">{new Date(log.timestamp).toLocaleTimeString()}</span>
                  </span>
                  <span className="flex items-center gap-1 shrink-0">
                    {log.country && (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={getCountryFlagUrl(log.country)} alt={log.country} className="w-3.5 h-3 object-contain rounded-sm" loading="lazy" />
                    )}
                    <span className="font-mono tabular-nums">{log.ip}</span>
                  </span>
                  <span className="text-muted-foreground/50 font-mono shrink-0">
                    {formatBytes(log.requestSize)} → {formatBytes(log.responseSize)}
                  </span>
                  <span className="flex items-center gap-1 flex-1 min-w-0">
                    <User className="w-3 h-3 shrink-0" />
                    <span className="truncate">{log.userAgent}</span>
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

