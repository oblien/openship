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
  // Real-time SSE stream from Deploy API (access logs)
  useEffect(() => {
    let disconnect: (() => void) | null = null;
    // Reset current logs on connect
    setServerLogs([]);
    const connect = async () => {
      try {
        const params = new URLSearchParams();
        params.set('stream', 'true');
        params.set('cursor', '$');
        params.set('limit', '50');

        const streamUrl = `https://deploy.oblien.com/logs/requests?${params.toString()}`;

        const res = await connectToLiveLogs({
          projectId,
          streamUrl,
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
    if (code >= 200 && code < 300) return 'text-emerald-600 bg-emerald-50';
    if (code >= 300 && code < 400) return 'text-blue-600 bg-blue-50';
    if (code >= 400 && code < 500) return 'text-amber-600 bg-amber-50';
    return 'text-red-600 bg-red-50';
  }, []);

  const getMethodColor = useCallback((method: string) => {
    switch (method) {
      case 'GET': return 'text-blue-600 bg-blue-50';
      case 'POST': return 'text-emerald-600 bg-emerald-50';
      case 'PUT': return 'text-amber-600 bg-amber-50';
      case 'DELETE': return 'text-red-600 bg-red-50';
      default: return 'text-gray-600 bg-gray-50';
    }
  }, []);

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center gap-3">
        <div className="flex items-center gap-2">
          <Server className="w-5 h-5 text-indigo-600" />
          <h3 className="text-lg font-semibold text-black">Realtime requests logs</h3>
        </div>
        <div className="flex items-center gap-2">
          <div className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></div>
          <span className="text-sm text-black/60 font-medium">Live</span>
        </div>
      </div>

      {/* Logs Container with White Frame */}
      <div className="bg-white rounded-[24px] p-6 border border-black/5">
        <div className="bg-gray-50 rounded-[16px] overflow-hidden border border-black/5">
          {/* Logs List */}
          <div className="max-h-[500px] overflow-y-auto server-logs-scroll pr-2">
            {serverLogsData.logs.length === 0 ? (
              isLoading ? (
                <div className="flex flex-col gap-3 p-4">
                  {Array.from({ length: 8 }).map((_, idx) => (
                    <div key={idx} className="animate-pulse">
                      <div className="flex items-center gap-3 mb-2">
                        <div className="w-12 h-5 rounded-md bg-gray-200" />
                        <div className="flex-1 h-4 rounded-md bg-gray-200" />
                        <div className="w-12 h-5 rounded-md bg-gray-200" />
                        <div className="w-10 h-4 rounded-md bg-gray-200" />
                      </div>
                      <div className="flex items-center gap-4">
                        <div className="w-44 h-3 rounded-md bg-gray-200" />
                        <div className="w-32 h-3 rounded-md bg-gray-200" />
                        <div className="flex-1 h-3 rounded-md bg-gray-200" />
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="flex flex-col items-center justify-center py-20">
                  <Server className="w-16 h-16 mb-4 text-gray-300" />
                  <p className="text-base text-gray-400">No server logs yet</p>
                </div>
              )
            ) : (
              <div className="divide-y divide-black/5">
                {serverLogsData.logs.map((log) => (
                  <div key={log.id} className="p-4 hover:bg-white/50 transition-colors">
                    {/* First Row - Method, Path, Status */}
                    <div className="flex items-center gap-3 mb-2">
                      <span className={`px-2.5 py-1 rounded-lg text-xs font-bold ${getMethodColor(log.method)}`}>
                        {log.method}
                      </span>
                      <div className="flex-1 flex items-center justify-between gap-3 min-w-0">
                        <span className="text-sm font-medium text-black font-mono truncate">
                          {log.path}
                        </span>
                        <span className="text-[11px] text-black/50 font-mono whitespace-nowrap">
                          {formatBytes(log.requestSize)} → {formatBytes(log.responseSize)}
                        </span>
                      </div>
                      <span className={`px-2.5 py-1 rounded-lg text-xs font-bold ${getStatusColor(log.statusCode)}`}>
                        {log.statusCode}
                      </span>
                      <span className="text-xs text-black/40 font-mono">
                        {log.responseTime}ms
                      </span>
                    </div>

                    {/* Second Row - Timestamp, IP, User Agent */}
                    <div className="flex items-center gap-4 text-xs text-black/50">
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

