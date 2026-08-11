"use client";

import React, { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { Server, Clock, User, AlertCircle } from "lucide-react";
import { getCountryFlagUrl } from "@/lib/country";
import './logs.css';
import { useProjectSettings } from "@/context/ProjectSettingsContext";
import { getServerLogKey } from "@/context/server-log-dedup";
import { api } from "@/lib/api";
import { endpoints } from "@/lib/api/endpoints";
import { DomainSwitcher } from "@/components/routing/DomainSwitcher";
import { useI18n } from "@/components/i18n-provider";
import {
  normalizeRequestLog,
  useRequestLogStream,
  type RequestLogEntry,
} from "@/hooks/useRequestLogStream";

type ServerLog = RequestLogEntry;

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
  const { serverLogsData, addServerLog, mergeServerLogs, setServerLogs, domain, domainsData } =
    useProjectSettings();
  const { t } = useI18n();
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Route switch: which domain's request logs to view (default = primary).
  const domains = useMemo(
    () =>
      (domainsData?.domains ?? [])
        .map((d: any) => d?.domain)
        .filter((d: unknown): d is string => typeof d === "string" && d.length > 0),
    [domainsData?.domains],
  );
  // Default to "" = All: combine every domain so a multi-route project never opens on a
  // dead-looking primary. A specific selection survives a domain-list refresh; anything
  // else (including a domain that stopped existing) falls back to All.
  const [selectedDomain, setSelectedDomain] = useState("");
  useEffect(() => {
    setSelectedDomain((current) => (current && domains.includes(current) ? current : ""));
  }, [domain, domains]);

  // Whether the combined view is active (more than one domain, none singled out) — drives
  // the per-row host label so you can tell which route a request hit.
  const isCombined = !selectedDomain && domains.length > 1;

  // Primary-first so the live-stream cap (MAX_STREAMS) drops the least-used tail, not the
  // domain that matters most.
  const streamDomains = useMemo(() => {
    if (domain && domains.includes(domain)) return [domain, ...domains.filter((d) => d !== domain)];
    return domains;
  }, [domains, domain]);

  // The stream effect keys off the domain SET, as a string. `domains` is rebuilt by
  // useMemo on every domainsData change, so depending on the array (or on
  // `isLoading`, which flips on every refetch) re-ran the effect for reasons that
  // have nothing to do with routing — and each re-run called setServerLogs([]) and
  // reopened the EventSource, so the visible log list emptied itself while you
  // watched it. Content, not identity.
  const domainsKey = useMemo(() => domains.join(","), [domains]);
  // Read inside the effect without depending on it (see above).
  const domainsLoadingRef = useRef(false);
  domainsLoadingRef.current = Boolean(domainsData?.isLoading);

  const formatBytes = useCallback((bytes?: number) => {
    const b = typeof bytes === 'number' ? bytes : 0;
    if (b < 1024) return `${b} B`;
    const kb = b / 1024;
    if (kb < 1024) return `${kb.toFixed(1)} KB`;
    const mb = kb / 1024;
    if (mb < 1024) return `${mb.toFixed(2)} MB`;
    return `${(mb / 1024).toFixed(2)} GB`;
  }, []);

  useEffect(() => {
    setServerLogs([]);
    setError(null);
    setIsLoading(true);

    // HTTP request logs come from the edge analytics, which exist only for a
    // routed domain. With no domain there's nothing to stream — surface the
    // "add a domain" hint (renderEmpty) instead of a misleading connection
    // error. Wait while the domain list is still loading; this effect re-runs
    // when it resolves (domainsKey is in the deps).
    if (!domainsKey) {
      if (!domainsLoadingRef.current) setIsLoading(false);
      return;
    }

    let cancelled = false;

    // Fetch recent logs in parallel and merge them behind live data.
    api.get<{ logs: any[] }>(endpoints.projects.serverLogsRecent(projectId), {
      params: { limit: 100, ...(selectedDomain ? { domain: selectedDomain } : {}) },
    }).then((res: any) => {
      if (cancelled) return;
      const logs: unknown[] = Array.isArray(res.logs)
        ? res.logs
        : Array.isArray(res.logs?.data)
          ? res.logs.data
          : Array.isArray(res.logs?.requests)
            ? res.logs.requests
            : Array.isArray(res.logs?.items)
              ? res.logs.items
              : Array.isArray(res.logs?.rows)
                ? res.logs.rows
                : [];

      if (logs.length) {
        const entries = logs
          .map(normalizeRequestLog)
          .filter((e): e is ServerLog => e !== null)
          .sort((a, b) => +new Date(b.timestamp) - +new Date(a.timestamp));
        if (entries.length > 0) {
          mergeServerLogs(entries);
        }
      }
    }).catch(() => {
      // Non-fatal - live stream stays active even if history fetch fails.
    });

    return () => {
      cancelled = true;
    };
  }, [projectId, selectedDomain, domainsKey, setServerLogs, mergeServerLogs]);

  /**
   * The live tail.
   *
   * `useRequestLogStream` owns the EventSource, the cloud stream-token branch and the
   * field normalisation — all of which used to be inline here. Extracted when the
   * monitoring map needed the same feed: two copies of "which URL do I connect to for a
   * cloud project" would drift, and the second one would be the copy that quietly only
   * ever worked self-hosted.
   */
  useRequestLogStream({
    projectId,
    // A specific selection streams that one domain; "All" (empty) fans out across every
    // route so the combined tail is never empty just because the primary is idle.
    domain: selectedDomain || undefined,
    domains: streamDomains,
    // Gated on the same condition the effect above uses: with no routed domain there is
    // nothing to stream, and the empty state should say "add a domain" rather than show a
    // connection error.
    enabled: !!domainsKey,
    onEntry: (entry) => {
      setIsLoading(false);
      // Live data means whatever failed earlier has recovered. Without this the error
      // stays latched forever — invisible while logs are on screen (the banner only
      // renders for an EMPTY list), then revealed the moment you hit Clear, which read as
      // "Clear broke the log stream".
      setError(null);
      addServerLog(entry);
    },
    onStatus: (st) => {
      if (st.state === "open") {
        setError(null);
        setIsLoading(false);
      } else if (st.state === "error") {
        setError(
          st.message === "closed"
            ? t.projectDetail.logs.server.connectionLost
            : st.message === "connect-failed"
              ? t.projectDetail.logs.server.connectFailed
              : st.message,
        );
        setIsLoading(false);
      } else if (st.state === "unavailable") {
        // Cloud project with no live token right now. History still loads; no live tail
        // and deliberately no error.
        setIsLoading(false);
      }
    },
  });

  const logsStrings = useMemo(() => {
    return serverLogsData.logs.map((log: any) =>
      `${log.timestamp} - ${log.ip} - ${log.method} ${log.path} - ${log.statusCode} - ${log.responseTime}ms`
    );
  }, [serverLogsData.logs]);

  useEffect(() => {
    onLogsChange(logsStrings);
  }, [logsStrings]);

  const getStatusColor = useCallback((code: number) => {
    if (code >= 200 && code < 300) return 'text-success bg-success-bg';
    if (code >= 300 && code < 400) return 'text-info bg-info-bg';
    if (code >= 400 && code < 500) return 'text-warning bg-warning-bg';
    return 'text-danger bg-danger-bg';
  }, []);

  const getMethodColor = useCallback((method: string) => {
    switch (method) {
      case 'GET': return 'text-info bg-info-bg';
      case 'POST': return 'text-success bg-success-bg';
      case 'PUT': return 'text-warning bg-warning-bg';
      case 'DELETE': return 'text-danger bg-danger-bg';
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

    if (!domainsData?.isLoading && domains.length === 0) {
      return (
        <div className="flex flex-col items-center justify-center py-16 gap-3">
          <Server className="w-10 h-10 text-muted-foreground/30" />
          <p className="text-sm text-muted-foreground">{t.projectDetail.logs.server.noDomain}</p>
          <p className="text-xs text-muted-foreground/70">{t.projectDetail.logs.server.noDomainHint}</p>
        </div>
      );
    }

    if (error) {
      return (
        <div className="flex flex-col items-center justify-center py-16 gap-3">
          <AlertCircle className="w-10 h-10 text-destructive/60" />
          <p className="text-sm font-medium text-destructive">{error}</p>
          <p className="text-xs text-muted-foreground">{t.projectDetail.logs.server.errorHint}</p>
        </div>
      );
    }

    return (
      <div className="flex flex-col items-center justify-center py-16 gap-2">
        <Server className="w-10 h-10 text-muted-foreground/30" />
        <p className="text-sm text-muted-foreground">{t.projectDetail.logs.server.waiting}</p>
      </div>
    );
  };

  return (
    <div className="bg-card rounded-2xl border border-border/50 overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-5 py-4 border-b border-border/50">
        <div className="flex items-center gap-2.5">
          <Server className="w-4 h-4 text-muted-foreground" />
          <h3 className="text-sm font-medium text-foreground">{t.projectDetail.logs.server.title}</h3>
        </div>
        <div className="flex items-center gap-3">
          {domains.length > 1 && (
            <DomainSwitcher
              domains={domains}
              value={selectedDomain}
              onChange={setSelectedDomain}
              allowAll
            />
          )}
          {!error && (
            <div className="flex items-center gap-1.5">
              <div className="w-1.5 h-1.5 rounded-full bg-success-solid animate-pulse" />
              <span className="text-xs text-muted-foreground">{t.projectDetail.logs.server.live}</span>
            </div>
          )}
        </div>
      </div>

      {/* Logs */}
      <div className="max-h-[460px] overflow-y-auto server-logs-scroll">
        {serverLogsData.logs.length === 0 ? renderEmpty() : (
          <div className="divide-y divide-border/30">
            {serverLogsData.logs.map((log: any) => (
              // Same identity the dedup keyed on, so the render key is provably unique even
              // for an id-less row that fell back to a content key.
              <div key={getServerLogKey(log)} className="group px-5 py-2.5 hover:bg-muted/30 transition-colors">
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
                  <span className="w-16 shrink-0 text-end text-[11px] text-muted-foreground/70 font-mono tabular-nums">
                    {log.responseTime}ms
                  </span>
                </div>
                <div className="flex items-center gap-3 mt-1 ps-[60px] text-[11px] text-muted-foreground">
                  <span className="flex items-center gap-1 shrink-0">
                    <Clock className="w-3 h-3" />
                    <span className="font-mono tabular-nums">{new Date(log.timestamp).toLocaleTimeString()}</span>
                  </span>
                  {isCombined && log.host && (
                    <span
                      className="shrink-0 max-w-[160px] truncate rounded-md bg-muted/60 px-1.5 py-0.5 font-mono text-muted-foreground/80"
                      title={log.host}
                    >
                      {log.host}
                    </span>
                  )}
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
