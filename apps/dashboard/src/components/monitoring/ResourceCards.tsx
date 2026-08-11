"use client";

/**
 * Live resource usage: one overall card plus a dot per container/service.
 *
 * Both come from a single SSE frame (see useProjectUsageStream), so the totals and
 * the dots always describe the same instant — and a compose project shows its whole
 * stack rather than whichever service happens to own `deployment.containerId`.
 *
 * Status colours use the theme's semantic tokens (text-success / -warning /
 * -danger / -muted-foreground), never hardcoded hues, so they stay legible in every
 * theme.
 */

import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  Cpu,
  MemoryStick,
  Network,
  HardDrive,
  Info,
  RefreshCw,
  ChevronLeft,
  ChevronRight,
} from "lucide-react";
import { useI18n, interpolate } from "@/components/i18n-provider";
import type {
  ProjectUsage,
  ResourceUsage,
  ServiceStatus,
  ServiceUsage,
} from "@/hooks/useProjectUsageStream";
import { formatBytes, formatMb } from "./format";

/** A zeroed reading, for a focused service with no live usage to report. */
const ZERO_USAGE: ResourceUsage = {
  cpuPercent: 0,
  memoryMb: 0,
  diskMb: 0,
  networkRxBytes: 0,
  networkTxBytes: 0,
};

interface Props {
  usage: ProjectUsage | null;
  isConnected: boolean;
  error: string | null;
  onReconnect: () => void;
  /**
   * Scope the headline numbers to one service. null = All (the summed stack).
   *
   * The per-service dots stay visible either way — narrowing them to the selected
   * service would hide the very comparison they exist to make — but the selected one
   * is highlighted so the card and the dots agree about what is being shown.
   */
  focusServiceKey?: string | null;
}

/** Semantic token per live container state. Mirrors the status vocabulary the
 *  rest of the app uses for services. */
const STATUS_DOT: Record<ServiceStatus, string> = {
  running: "bg-success",
  starting: "bg-warning",
  restarting: "bg-warning",
  failed: "bg-danger",
  stopped: "bg-muted-foreground/40",
};

/**
 * The stream's FAILURE state, on the services row.
 *
 * When the stream is live there is no badge at all: the parent card's subtitle already
 * says "Live, refreshed every few seconds", so a second green "Live" dot was redundant
 * chrome. Only disconnection earns a spot here — it changes what the numbers mean and
 * has to offer the retry, so it can't be silent.
 */
const OfflineNotice: React.FC<{ onReconnect: () => void }> = ({ onReconnect }) => {
  const { t } = useI18n();
  const m = t.projects.monitoring;
  return (
    <div className="flex shrink-0 items-center gap-2">
      <span aria-hidden className="size-2 rounded-full bg-muted-foreground/40" />
      <span className="text-xs text-muted-foreground">{m.offline}</span>
      <button
        type="button"
        onClick={onReconnect}
        className="ml-1 flex items-center gap-1.5 rounded-lg px-2 py-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
      >
        <RefreshCw className="size-3" />
        {m.reconnect}
      </button>
    </div>
  );
};

/**
 * The services as a single horizontal strip that scrolls sideways instead of wrapping.
 *
 * Was a wrapping grid capped at eight chips with a "+N more" fold — but a stack that grew
 * downward pushed the map below it and made the block's height depend on the service
 * count. One line keeps the height fixed no matter how many services there are; the list
 * runs off the right edge and the arrows (or drag / trackpad) reach the rest.
 *
 * The arrows appear ONLY on overflow — a short list that fits shows no chrome. Overflow is
 * measured on the live element (scroll position + client/scroll width) because it depends
 * on the rendered width, not the service count; a ResizeObserver keeps it honest as the
 * card resizes. Both are client-only, so a server render draws the strip with no arrows
 * and the native overflow still scrolls.
 */
const ServiceStrip: React.FC<{
  services: ServiceUsage[];
  focusServiceKey: string | null;
  statusLabels: Partial<Record<ServiceStatus, string>>;
}> = ({ services, focusServiceKey, statusLabels }) => {
  const { t } = useI18n();
  const m = t.projects.monitoring;
  const ref = useRef<HTMLDivElement>(null);
  const [canLeft, setCanLeft] = useState(false);
  const [canRight, setCanRight] = useState(false);

  const measure = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    // 1px slack: sub-pixel widths never let scrollLeft land exactly on an edge.
    setCanLeft(el.scrollLeft > 1);
    setCanRight(el.scrollLeft + el.clientWidth < el.scrollWidth - 1);
  }, []);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    measure();
    el.addEventListener("scroll", measure, { passive: true });
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => {
      el.removeEventListener("scroll", measure);
      ro.disconnect();
    };
  }, [measure, services.length]);

  const nudge = (dir: 1 | -1) => {
    const el = ref.current;
    if (!el) return;
    // Most of a viewport per press, floored so a narrow card still advances.
    el.scrollBy({ left: dir * Math.max(160, el.clientWidth * 0.75), behavior: "smooth" });
  };

  const arrowBtn =
    "flex size-6 shrink-0 items-center justify-center rounded-full bg-muted/60 text-muted-foreground transition-colors hover:text-foreground disabled:cursor-default disabled:opacity-30 disabled:hover:text-muted-foreground";

  return (
    // Scroller and arrows share one row: the strip takes the remaining width, the
    // navigator sits at the right edge next to where the overflow disappears.
    <div className="mt-2 flex items-center gap-2">
      <div
        ref={ref}
        role="group"
        aria-label={m.servicesTitle}
        // One line, always. `flex-nowrap` + `overflow-x-auto` scrolls sideways rather than
        // wrapping; the scrollbar is hidden because the arrows and drag/trackpad are the
        // affordance and a native bar under a ~32px strip is more chrome than content.
        className="flex min-w-0 flex-1 flex-nowrap gap-1.5 overflow-x-auto [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {services.map((s) => (
          <ServiceChip
            key={s.serviceId ?? s.name}
            service={s}
            focused={focusServiceKey != null && s.serviceId === focusServiceKey}
            // The service-detail labels, not a second vocabulary: these chips report the
            // SAME live container states the Services tab shows, so they read identically.
            statusLabel={statusLabels[s.status] ?? s.status}
          />
        ))}
      </div>
      {(canLeft || canRight) && (
        <div className="flex shrink-0 items-center gap-1">
          <button type="button" aria-label={m.scrollServicesLeft} disabled={!canLeft} onClick={() => nudge(-1)} className={arrowBtn}>
            <ChevronLeft className="size-3.5" />
          </button>
          <button type="button" aria-label={m.scrollServicesRight} disabled={!canRight} onClick={() => nudge(1)} className={arrowBtn}>
            <ChevronRight className="size-3.5" />
          </button>
        </div>
      )}
    </div>
  );
};

const Metric: React.FC<{
  icon: React.ReactNode;
  label: string;
  value: string;
  subtext?: string;
  /** 0–1; omitted when there's no meaningful denominator. */
  fill?: number;
}> = ({ icon, label, value, subtext, fill }) => (
  /*
   * A TILE, not a bare grid cell.
   *
   * `bg-muted/30`, deliberately not `bg-card`: this sits inside a card already, and a card
   * on a card reads as a rendering bug in every theme (no theme draws a resting card
   * border, so the two surfaces would simply merge into an odd double-padded block). The
   * muted surface is a step away from the card in both light and dark, so each metric gets
   * a visible container without inventing a second card level.
   */
  <div className="flex flex-col rounded-xl bg-muted/30 p-4">
    <div className="mb-3 flex items-center gap-2">
      <div className="text-primary">{icon}</div>
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
    </div>
    <p className="mb-1 text-2xl font-semibold tabular-nums text-foreground">{value}</p>
    {fill !== undefined && (
      <span className="mb-1 block h-1.5 w-full overflow-hidden rounded-full bg-muted">
        <span
          className="block h-full rounded-full bg-primary transition-[width] duration-500"
          style={{ width: `${Math.min(100, Math.max(1, fill * 100))}%` }}
        />
      </span>
    )}
    {subtext && <p className="text-xs font-normal text-muted-foreground/70">{subtext}</p>}
  </div>
);

/**
 * One service as a compact CHIP.
 *
 * Was a full-width row in a two-column grid: ~56px tall each, so a five-service stack
 * cost ~170px of vertical space before the map — to carry three short values. Chips wrap,
 * so the same information takes one or two lines and everything below moves up.
 *
 * Trimmed to what identifies and grades a service: status dot, name, CPU, memory. The
 * status WORD is gone — the dot already carries it, and spelling it out was most of the
 * width. It stays reachable in the `title`.
 */
const ServiceChip: React.FC<{
  service: ServiceUsage;
  statusLabel: string;
  focused: boolean;
}> = ({ service, statusLabel, focused }) => (
  <div
    title={`${service.name} — ${statusLabel}`}
    // No border. A ring around a pill that already has its own fill is a second boundary
    // for one edge, and at this size it read as noise — five outlined pills in a row drew
    // more attention than the numbers inside them. The fill alone separates them.
    className={`flex shrink-0 items-center gap-2 rounded-full py-1 pl-3 pr-2 text-xs transition-colors ${
      focused ? "bg-primary/15" : "bg-muted/60"
    }`}
  >
    <span className="max-w-[10rem] truncate font-medium text-foreground">{service.name}</span>
    {/* A stopped or unmeasurable container shows a dash, not 0% — zero CPU is a real
        reading and must not be confused with "no reading". */}
    <span className="shrink-0 tabular-nums text-muted-foreground">
      {service.usage ? `${service.usage.cpuPercent.toFixed(1)}%` : "—"}
    </span>
    <span className="shrink-0 tabular-nums text-muted-foreground/60">
      {service.usage ? formatMb(service.usage.memoryMb) : "—"}
    </span>
    {/* Trailing, not leading. Both edges then carry a small round element, which is what
        makes a row of pills of differing widths look deliberate rather than ragged. */}
    <span aria-hidden className={`size-1.5 shrink-0 rounded-full ${STATUS_DOT[service.status]}`} />
  </div>
);

export const ResourceCards: React.FC<Props> = ({
  usage,
  isConnected,
  error,
  onReconnect,
  focusServiceKey = null,
}) => {
  const { t } = useI18n();
  const m = t.projects.monitoring;
  const statusLabels: Partial<Record<ServiceStatus, string>> =
    t.projectDetail.services.detail.status;

  // `supported: false` is a real answer, not an error: BareRuntime's old stub
  // returned zeros and the dashboard drew them as data, so an unmeasurable
  // deployment looked exactly like an idle one.
  if (usage && !usage.supported) {
    return (
      <>
        <div className="flex items-start gap-2">
          <Info className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          <div>
            <p className="text-sm font-medium text-foreground">{m.unsupportedTitle}</p>
            {usage.reason && (
              <p className="mt-0.5 text-xs text-muted-foreground">{usage.reason}</p>
            )}
          </div>
        </div>
      </>
    );
  }

  if (!usage) {
    return (
      <>
        <div className="mb-4 flex items-center justify-between">
          {error && (
            <button
              type="button"
              onClick={onReconnect}
              className="flex items-center gap-1.5 rounded-lg px-2 py-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
            >
              <RefreshCw className="size-3" />
              {m.reconnect}
            </button>
          )}
        </div>
        {error ? (
          <p className="text-sm text-muted-foreground">{error}</p>
        ) : (
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="space-y-2">
                <div className="h-3 w-16 rounded bg-muted" />
                <div className="h-7 w-20 rounded bg-muted" />
                <div className="h-1.5 w-full rounded bg-muted" />
              </div>
            ))}
          </div>
        )}
      </>
    );
  }

  // Scoped to one service when asked, else the whole stack. A selected service whose
  // container isn't running has no usage — fall back to zeros rather than silently
  // showing the stack total under that service's name, which would be a lie.
  const focused =
    focusServiceKey != null
      ? usage.services.find((s) => s.serviceId === focusServiceKey)
      : undefined;
  const o: ResourceUsage = focused ? (focused.usage ?? { ...ZERO_USAGE }) : usage.overall;
  // A single-app deploy's one "service" IS the app, so chips would just repeat the totals
  // above them.
  const hasServiceChips = usage.services.length > 1;
  const cores = usage.capacity.cpuCores;
  const memTotal = usage.capacity.memoryMb;

  return (
    <>
      <div className="space-y-4">
        {/* No header row here any more. It carried nothing but the liveness pill — the title
            belongs to the parent card — so it spent a whole row of height on one dot. The
            pill now sits on the services row, which had empty space to the right of it. */}
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Metric
            icon={<Cpu className="size-4" />}
            label={m.cpu}
            value={`${o.cpuPercent.toFixed(1)}%`}
            // Percent is per-core, so a 4-core box tops out at 400% — divide by the
            // core count to make the bar mean "share of this host".
            fill={cores ? o.cpuPercent / (cores * 100) : undefined}
            subtext={cores ? interpolate(m.ofCores, { cores: String(cores) }) : undefined}
          />
          <Metric
            icon={<MemoryStick className="size-4" />}
            label={m.memory}
            value={formatMb(o.memoryMb)}
            fill={memTotal ? o.memoryMb / memTotal : undefined}
            subtext={memTotal ? interpolate(m.ofMemory, { total: formatMb(memTotal) }) : undefined}
          />
          <Metric
            icon={<Network className="size-4" />}
            label={m.network}
            value={formatBytes(o.networkRxBytes + o.networkTxBytes)}
            subtext={`↓ ${formatBytes(o.networkRxBytes)} · ↑ ${formatBytes(o.networkTxBytes)}`}
          />
          <Metric
            icon={<HardDrive className="size-4" />}
            label={m.diskIo}
            value={formatMb(o.diskMb)}
            // Labelled I/O, not "disk", on purpose: the runtimes report CUMULATIVE
            // block I/O here, not space used. Calling it disk usage would be wrong.
            subtext={m.diskIo}
          />
        </div>

      {/* Only for multi-service projects: a single-app deploy's one "service" is
          the app itself, and repeating the numbers just read as duplication. A section of
          the parent card rather than a card of its own — the chips belong WITH the totals
          they break down. */}
      {/* This row exists whether or not there are services, because it also carries the
          offline notice — and a single-container app needs that just as much. When the
          stream is live the header collapses to just the title; when it drops, the notice
          appears on the right. */}
      <div>
        <div className="mb-2 flex items-center gap-3">
          {hasServiceChips && (
            <h3 className="text-xs font-medium text-muted-foreground">{m.servicesTitle}</h3>
          )}
          <span className="min-w-0 flex-1" />
          {/* Only the FAILURE state shows here. Live is already stated by the card
              subtitle, so a second "Live" pill was redundant — see OfflineNotice. */}
          {!isConnected && <OfflineNotice onReconnect={onReconnect} />}
        </div>
        {hasServiceChips && (
          <ServiceStrip
            services={usage.services}
            focusServiceKey={focusServiceKey}
            statusLabels={statusLabels}
          />
        )}
      </div>
      </div>
    </>
  );
};
