"use client";

import { useState, useCallback } from "react";
import { Network, Globe, Lock, Shield, Loader2, RefreshCw, ScanLine } from "lucide-react";
import { systemApi, type PortScanResult, type HostListener } from "@/lib/api/system";
import { getApiErrorMessage } from "@/lib/api/client";
import { useI18n, interpolate } from "@/components/i18n-provider";

/**
 * Port-exposure scan for the server Security tab. Deliberately action-driven —
 * it does NOT fetch on mount (that blocking SSH read is exactly what made the
 * tab hang). The user presses "Scan ports"; the backend runs `scanPorts` through
 * the executor middleware and returns every listener classified exposed vs
 * loopback.
 */
export function ExposedPortsCard({ serverId }: { serverId: string }) {
  const { t } = useI18n();
  const s = t.servers.security.ports;

  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<PortScanResult | null>(null);

  const scan = useCallback(async () => {
    setScanning(true);
    setError(null);
    try {
      const res = await systemApi.scanPorts(serverId);
      setResult(res);
    } catch (err) {
      setError(getApiErrorMessage(err, s.scanFailed));
    } finally {
      setScanning(false);
    }
  }, [serverId, s.scanFailed]);

  return (
    <div className="bg-card rounded-2xl border border-border/50">
      <div className="flex items-center justify-between gap-3 px-5 py-4 border-b border-border/50">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 bg-info/10 rounded-xl flex items-center justify-center">
            <Network className="size-[18px] text-info" />
          </div>
          <div>
            <h2 className="font-semibold text-foreground text-[15px]">{s.title}</h2>
            <p className="text-xs text-muted-foreground">{s.subtitle}</p>
          </div>
        </div>
        {result && !scanning && (
          <button
            type="button"
            onClick={() => void scan()}
            className="inline-flex items-center gap-2 rounded-lg bg-muted/30 px-3 py-2 text-[12px] font-medium text-foreground transition-colors hover:bg-muted"
          >
            <RefreshCw className="size-3.5" />
            {s.rescan}
          </button>
        )}
      </div>

      <div className="p-5">
        {error ? (
          <div className="rounded-xl border border-warning-border bg-warning-bg px-4 py-3 flex items-center justify-between gap-4">
            <div>
              <p className="text-sm font-medium text-foreground">{s.scanFailed}</p>
              <p className="mt-1 text-[12px] text-muted-foreground">{error || s.scanFailedHint}</p>
            </div>
            <button
              type="button"
              onClick={() => void scan()}
              disabled={scanning}
              className="inline-flex items-center gap-2 rounded-lg bg-muted/60 px-3 py-2 text-[12px] font-medium text-foreground transition-colors hover:bg-muted disabled:opacity-50"
            >
              <RefreshCw className="size-3.5" />
              {s.retry}
            </button>
          </div>
        ) : !result ? (
          <div className="flex flex-col items-start gap-4">
            <p className="text-sm text-muted-foreground">{s.introHint}</p>
            <button
              type="button"
              onClick={() => void scan()}
              disabled={scanning}
              className="inline-flex items-center gap-2 rounded-xl bg-primary px-4 py-2 text-[13px] font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {scanning ? <Loader2 className="size-4 animate-spin" /> : <ScanLine className="size-4" />}
              {scanning ? s.scanning : s.scanButton}
            </button>
          </div>
        ) : (
          <ScanResult result={result} labels={s} />
        )}
      </div>
    </div>
  );
}

function ScanResult({
  result,
  labels,
}: {
  result: PortScanResult;
  labels: Record<string, string>;
}) {
  if (!result.scanned) {
    return (
      <div className="rounded-xl border border-warning-border bg-warning-bg px-4 py-3">
        <p className="text-sm font-medium text-foreground">{labels.inconclusive}</p>
        <p className="mt-1 text-[12px] text-muted-foreground">{labels.inconclusiveHint}</p>
      </div>
    );
  }

  if (result.totalCount === 0) {
    return <p className="text-sm text-muted-foreground">{labels.empty}</p>;
  }

  const firewalled = result.listeners.filter(
    (l) => l.exposed && l.proto === "tcp" && l.reachable === false,
  ).length;

  const summary = result.reachabilityProbed
    ? interpolate(labels.summaryReachable, {
        total: String(result.totalCount),
        reachable: String(result.reachableCount ?? 0),
        firewalled: String(firewalled),
      })
    : result.exposedCount > 0
      ? interpolate(labels.summary, {
          total: String(result.totalCount),
          exposed: String(result.exposedCount),
        })
      : interpolate(labels.summaryZeroExposed, { total: String(result.totalCount) });

  const alert = result.reachabilityProbed
    ? (result.reachableCount ?? 0) > 0
    : result.exposedCount > 0;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <span
          className={`inline-block size-2 rounded-full ${alert ? "bg-warning-solid" : "bg-success-solid"}`}
        />
        <p className="text-sm font-medium text-foreground">{summary}</p>
      </div>

      {result.reachabilityProbed && (
        <p className="text-[12px] text-muted-foreground">{labels.reachableLegend}</p>
      )}
      {result.source === "procfs" && (
        <p className="text-[12px] text-muted-foreground">{labels.noProcessInfo}</p>
      )}

      <ul className="divide-y divide-border/40 rounded-xl border border-border/50 overflow-hidden">
        {result.listeners.map((l, i) => (
          <PortRow key={`${l.proto}-${l.family}-${l.address}-${l.port}-${i}`} listener={l} labels={labels} />
        ))}
      </ul>
    </div>
  );
}

type PortState = "loopback" | "reachable" | "firewalled" | "exposed";

function portState(l: HostListener): PortState {
  if (!l.exposed) return "loopback";
  if (l.reachable === true) return "reachable";
  if (l.reachable === false) return "firewalled";
  return "exposed";
}

function PortRow({ listener, labels }: { listener: HostListener; labels: Record<string, string> }) {
  const state = portState(listener);
  const danger = state === "reachable" && listener.sensitive;

  const proc = listener.process
    ? listener.pid
      ? `${listener.process} (${listener.pid})`
      : listener.process
    : labels.unknownProcess;

  const note = danger
    ? labels.sensitiveReachable
    : listener.sensitive
      ? labels.sensitiveHint
      : listener.required
        ? labels.expectedOpen
        : null;

  const badge =
    state === "reachable"
      ? danger
        ? "bg-danger-bg text-danger border border-danger-border"
        : "bg-warning-bg text-warning border border-warning-border"
      : state === "firewalled"
        ? "bg-info-bg text-info border border-info-border"
        : state === "exposed"
          ? "bg-warning-bg text-warning border border-warning-border"
          : "bg-neutral-bg text-neutral border border-neutral-border";

  const badgeLabel = labels[state]; // reachable | firewalled | exposed | loopback

  const Icon = state === "loopback" ? Lock : state === "firewalled" ? Shield : Globe;
  const iconColor =
    state === "loopback"
      ? "text-muted-foreground"
      : danger
        ? "text-danger"
        : state === "firewalled"
          ? "text-info"
          : "text-warning";

  return (
    <li className="flex items-center justify-between gap-3 bg-muted/10 px-4 py-2.5">
      <div className="flex items-center gap-3 min-w-0">
        <Icon className={`size-4 shrink-0 ${iconColor}`} />
        <div className="min-w-0">
          <p className="text-[13px] font-medium text-foreground truncate">
            <span className="uppercase text-muted-foreground me-1.5 text-[11px] tracking-wide">
              {listener.proto}
            </span>
            {listener.address}:{listener.port}
            {listener.service && (
              <span className="ms-2 rounded bg-muted/60 px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground">
                {listener.service}
              </span>
            )}
          </p>
          <p className="text-[12px] text-muted-foreground truncate">
            {proc}
            {note && <span className={danger ? "ms-2 text-danger" : "ms-2"}>· {note}</span>}
          </p>
        </div>
      </div>
      <span className={`shrink-0 rounded-md px-2 py-0.5 text-[11px] font-medium ${badge}`}>
        {badgeLabel}
      </span>
    </li>
  );
}
