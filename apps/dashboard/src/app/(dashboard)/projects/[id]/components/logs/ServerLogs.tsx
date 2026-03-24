"use client";

import React, { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { Server, Clock, User } from "lucide-react";
import { getCountryFlagUrl } from "@/lib/country";
import './logs.css';
import { useProjectSettings } from "@/context/ProjectSettingsContext";
import { connectToLiveLogs } from "@/lib/sseClient";

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
  const { serverLogsData, addServerLog, setServerLogs, setServerMockInterval } = useProjectSettings();
  const [isLoading, setIsLoading] = useState(true);

  let isConnectedRef = useRef(false);
  const formatBytes = useCallback((bytes?: number) => {
    const b = typeof bytes === 'number' ? bytes : 0;
    if (b < 1024) return `${b} B`;
    const kb = b / 1024;
    if (kb < 1024) return `${kb.toFixed(1)} KB`;
    const mb = kb / 1024;
    if (mb < 1024) return `${mb.toFixed(2)} MB`;
    const gb = mb / 1024;
    return `${gb.toFixed(2)} GB`;
  }, []);
  // Real-time SSE stream from local API (runtime logs)
  useEffect(() => {
    let disconnect: (() => void) | null = null;
    // Reset current logs on connect
    setServerLogs([]);
    const connect = async () => {
      try {
        const res = await connectToLiveLogs({
          projectId,
          options: {
            onMessage: (chunk: string) => {
              // Debug: inspect raw SSE chunks
              if (process.env.NODE_ENV !== 'production') {
                try { console.debug('[ServerLogs] SSE chunk:', chunk); } catch { }
              }
              try {
                const lines = chunk.split('\n');
                for (const line of lines) {
                  if (!line.startsWith('data: ')) continue;
                  const dataStr = line.slice(6).trim();
                  if (!dataStr) continue;
                  const msg = JSON.parse(dataStr);
                  // Accept either wrapped { type: 'request', data } or raw request object
                  const isWrapped = msg && typeof msg === 'object' && 'type' in msg;
                  const d = isWrapped ? (msg.data as any) : msg;
                  if ((isWrapped && msg.type === 'request' && d) || (!isWrapped && d && (d.uri || d.method))) {
                    if (isLoading) setIsLoading(false);
                    const log: ServerLog = {
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
                    };
                    addServerLog(log);
                  }
                }
              } catch { }
            },
            onError: () => { },
          }
        });

        disconnect = res.disconnect;
      } catch (e) {
        // swallow
      }
    };

     if (!isConnectedRef.current) {
      connect();
      isConnectedRef.current = true;
    }
     // Fallback: stop skeleton after 5s even if no data yet
     const t = setTimeout(() => setIsLoading(false), 5000);
    return () => {
      if (disconnect) disconnect();
       clearTimeout(t);
    };
  }, [projectId, setServerLogs, addServerLog]);

  // Memoize the logs strings to prevent unnecessary recalculations
  const logsStrings = useMemo(() => {
    return serverLogsData.logs.map(log =>
      `${log.timestamp} - ${log.ip} - ${log.method} ${log.path} - ${log.statusCode} - ${log.responseTime}ms`
    );
  }, [serverLogsData.logs]);

  // Use useCallback to stabilize the onLogsChange call
  useEffect(() => {
    onLogsChange(logsStrings);
  }, [logsStrings]); // Remove onLogsChange from deps to prevent infinite loop

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

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center gap-3">
        <div className="flex items-center gap-2">
          <Server className="w-5 h-5 text-primary" />
          <h3 className="text-lg font-semibold text-foreground">Realtime requests logs</h3>
        </div>
        <div className="flex items-center gap-2">
          <div className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></div>
          <span className="text-sm text-muted-foreground font-medium">Live</span>
        </div>
      </div>

      {/* Logs Container with White Frame */}
      <div className="bg-card rounded-3xl p-6 border border-border/50">
        <div className="bg-muted/40 rounded-2xl overflow-hidden border border-border/50">
          {/* Logs List */}
          <div className="max-h-[500px] overflow-y-auto server-logs-scroll pr-2">
            {serverLogsData.logs.length === 0 ? (
              isLoading ? (
                <div className="flex flex-col gap-3 p-4">
                  {Array.from({ length: 8 }).map((_, idx) => (
                    <div key={idx} className="animate-pulse">
                      <div className="flex items-center gap-3 mb-2">
                        <div className="w-12 h-5 rounded-md bg-muted" />
                        <div className="flex-1 h-4 rounded-md bg-muted" />
                        <div className="w-12 h-5 rounded-md bg-muted" />
                        <div className="w-10 h-4 rounded-md bg-muted" />
                      </div>
                      <div className="flex items-center gap-4">
                        <div className="w-44 h-3 rounded-md bg-muted" />
                        <div className="w-32 h-3 rounded-md bg-muted" />
                        <div className="flex-1 h-3 rounded-md bg-muted" />
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="flex flex-col items-center justify-center py-20">
                  <Server className="w-16 h-16 mb-4 text-muted-foreground/30" />
                  <p className="text-base text-muted-foreground">No server logs yet</p>
                </div>
              )
            ) : (
              <div className="divide-y divide-black/5">
                {serverLogsData.logs.map((log) => (
                  <div key={log.id} className="p-4 hover:bg-card/50 transition-colors">
                    {/* First Row - Method, Path, Status */}
                    <div className="flex items-center gap-3 mb-2">
                      <span className={`px-2.5 py-1 rounded-lg text-xs font-bold ${getMethodColor(log.method)}`}>
                        {log.method}
                      </span>
                      <div className="flex-1 flex items-center justify-between gap-3 min-w-0">
                        <span className="text-sm font-medium text-foreground font-mono truncate">
                          {log.path}
                        </span>
                        <span className="text-[11px] text-muted-foreground font-mono whitespace-nowrap">
                          {formatBytes(log.requestSize)} → {formatBytes(log.responseSize)}
                        </span>
                      </div>
                      <span className={`px-2.5 py-1 rounded-lg text-xs font-bold ${getStatusColor(log.statusCode)}`}>
                        {log.statusCode}
                      </span>
                      <span className="text-xs text-muted-foreground/70 font-mono">
                        {log.responseTime}ms
                      </span>
                    </div>

                    {/* Second Row - Timestamp, IP, User Agent */}
                    <div className="flex items-center gap-4 text-xs text-muted-foreground">
                      <div className="flex items-center gap-1.5">
                        <Clock className="w-3.5 h-3.5" />
                        <span className="font-mono">
                          {new Date(log.timestamp).toLocaleString()}
                        </span>
                      </div>
                      <div className="flex items-center gap-1.5">
                        {log.country ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img
                            src={getCountryFlagUrl(log.country)}
                            alt={log.country}
                            className="w-4 h-4 object-contain rounded-sm"
                            loading="lazy"
                          />
                        ) : null}
                        <span className="font-mono tabular-nums inline-block w-25 truncate">{log.ip}</span>
                      </div>
                      <div className="flex items-center gap-1.5 flex-1 min-w-0">
                        <User className="w-3.5 h-3.5 flex-shrink-0" />
                        <span className="truncate">{log.userAgent}</span>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

