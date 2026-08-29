"use client";

/**
 * Reverse-proxy tunables for a project's vhosts, rendered FROM the
 * `PROXY_DIRECTIVES` table in `@repo/core` — the same table the API schema, the
 * sanitizer, the vhost renderer and the config parser derive from. Adding a
 * directive is a row there, not an edit here.
 *
 * Two things this panel exists to do:
 *  - OpenResty inherits nginx's defaults, and two of them bite in the same breath:
 *    `client_max_body_size 1m` turns any real upload into a 413, and the 60s
 *    timeouts cut off a big one that IS allowed. Grouping them beats discovering
 *    them one 413 at a time.
 *  - Show what the edge is ACTUALLY serving beside what we saved. Saved-equals-served
 *    is an assumption: a hand-edited vhost, a value the sanitizer dropped, or a
 *    directive the box's nginx is too old for all leave the two apart, and until this
 *    read-back nothing surfaced it.
 *
 * Every field is labelled with its nginx directive name, so the value is searchable
 * in nginx's own docs and a new row needs no new translation.
 */

import React from "react";
import { ChevronDown, RefreshCw, TriangleAlert } from "lucide-react";
import {
  PROXY_DIRECTIVES,
  type ProxyDirectiveGroup,
  type ProxyDirectiveSpec,
  type RoutingConfig,
} from "@repo/core";
import { useI18n } from "@/components/i18n-provider";
import type { EdgeConfigReport } from "@/lib/api/projects";

type ProxyValues = Record<string, string | number | boolean>;

const GROUP_ORDER: ProxyDirectiveGroup[] = [
  "body",
  "timeouts",
  "buffering",
  "compression",
  "headers",
  "upstreamTls",
];

const inputCls =
  "w-full px-2.5 py-1.5 bg-muted/30 border border-border/50 rounded-lg text-sm text-foreground font-mono placeholder:text-muted-foreground/50 focus:outline-none focus:ring-2 focus:ring-primary/20";

/** Placeholder = the shape of a valid value, so an empty box is still instructive. */
function placeholderFor(spec: ProxyDirectiveSpec): string {
  switch (spec.kind) {
    case "size":
      return "25m";
    case "time":
      return "300s";
    case "buffers":
      return "8 16k";
    case "int":
      return spec.min !== undefined && spec.max !== undefined ? `${spec.min}–${spec.max}` : "0";
    default:
      return "";
  }
}

/** What one host is serving for one directive, as text. */
function liveText(
  state: { live?: string | number | boolean; liveRaw?: string } | undefined,
  notSet: string,
): string {
  // `liveRaw` first: a vhost may legally hold `20M` or `1d`, which our validators
  // reject — reporting "not set" for a value that IS set would be the one real lie
  // this panel could tell.
  if (state?.liveRaw !== undefined) return state.liveRaw;
  if (state?.live === undefined) return notSet;
  return typeof state.live === "boolean" ? (state.live ? "on" : "off") : String(state.live);
}

/**
 * Collapse the per-host report into one cell per directive. Hosts usually agree;
 * when they don't, that IS the finding, so we say "varies" and name the hosts
 * rather than picking one and calling it the truth.
 */
function summarizeLive(edge: EdgeConfigReport | null | undefined, notSet: string) {
  const byKey = new Map<string, { texts: Map<string, string[]>; drift: boolean }>();
  const adoptable: ProxyValues = {};
  if (!edge?.reachable) return { byKey, adoptable, hosts: [] as string[] };

  const hosts = edge.hosts.filter((h) => h.found);
  for (const host of hosts) {
    for (const [k, v] of Object.entries(host.adoptable as ProxyValues)) {
      if (!(k in adoptable)) adoptable[k] = v;
    }
    for (const d of host.directives) {
      const cell = byKey.get(d.key) ?? { texts: new Map<string, string[]>(), drift: false };
      const text = liveText(d, notSet);
      cell.texts.set(text, [...(cell.texts.get(text) ?? []), host.hostname]);
      cell.drift = cell.drift || d.drift;
      byKey.set(d.key, cell);
    }
  }
  return { byKey, adoptable, hosts: hosts.map((h) => h.hostname) };
}

export const ProxySettingsSection: React.FC<{
  cfg: RoutingConfig;
  patch: (updates: Partial<RoutingConfig>) => void;
  disabled?: boolean;
  /** Live read-back, when the caller fetched it (the project tab does; the wizard doesn't). */
  edge?: EdgeConfigReport | null;
  onRefreshEdge?: () => void;
  edgeLoading?: boolean;
}> = ({ cfg, patch, disabled, edge, onRefreshEdge, edgeLoading }) => {
  const { t } = useI18n();
  const w = t.widgets.routing.configEditor;
  const proxy = (cfg.proxy ?? {}) as ProxyValues;
  const live = summarizeLive(edge, w.proxyNotSet);
  const driftKeys = [...live.byKey.entries()].filter(([, c]) => c.drift).map(([k]) => k);
  const [open, setOpen] = React.useState(
    () => Object.keys(proxy).length > 0 || driftKeys.length > 0,
  );

  /** Human hint for the handful of directives whose effect isn't obvious from the
   *  name. Absent for the rest — the directive name is the documentation. */
  const hints: Record<string, string | undefined> = {
    clientMaxBodySize: w.maxBodySizeHint,
    proxyReadTimeout: w.readTimeoutHint,
    proxySendTimeout: w.sendTimeoutHint,
    clientBodyTimeout: w.bodyTimeoutHint,
    proxyBuffering: w.proxyBufferingHint,
    gzip: w.gzipHint,
  };
  /** Friendly label for the same handful, above the directive name. */
  const labels: Record<string, string | undefined> = {
    clientMaxBodySize: w.maxBodySize,
    proxyReadTimeout: w.readTimeout,
    proxySendTimeout: w.sendTimeout,
    clientBodyTimeout: w.bodyTimeout,
    proxyBuffering: w.proxyBuffering,
    gzip: w.gzip,
  };

  /** Drop the key when a field is cleared, so an empty box means "nginx default"
   *  rather than persisting a blank that fails validation on save. */
  const setValue = (key: string, value: string | number | boolean | undefined) => {
    const next = { ...proxy };
    if (value === undefined || value === "") delete next[key];
    else next[key] = value;
    patch({ proxy: Object.keys(next).length > 0 ? (next as RoutingConfig["proxy"]) : undefined });
  };

  const adoptLive = () => {
    patch({ proxy: { ...proxy, ...live.adoptable } as RoutingConfig["proxy"] });
  };

  const liveCell = (key: string) => {
    const cell = live.byKey.get(key);
    if (!cell) return null;
    const entries = [...cell.texts.entries()];
    const text = entries.length === 1 ? entries[0]![0] : w.proxyLiveVaries;
    const title = entries.map(([v, hosts]) => `${hosts.join(", ")}: ${v}`).join("\n");
    return (
      <p
        className={`text-[10px] font-mono ${cell.drift ? "text-warning" : "text-muted-foreground"}`}
        title={title}
      >
        {w.proxyLiveLabel} {text}
        {cell.drift ? ` · ${w.proxyDrift}` : ""}
      </p>
    );
  };

  const boolField = (spec: ProxyDirectiveSpec) => {
    const value = proxy[spec.key];
    return (
      <select
        className={inputCls}
        disabled={disabled}
        value={value === true ? "on" : value === false ? "off" : ""}
        onChange={(e) =>
          setValue(spec.key, e.target.value === "" ? undefined : e.target.value === "on")
        }
      >
        {/* Three states, because nginx has three: unset inherits its default, which a
            checkbox cannot express once a value has been stored. */}
        <option value="">{w.proxyInherit}</option>
        <option value="on">on</option>
        <option value="off">off</option>
      </select>
    );
  };

  const field = (spec: ProxyDirectiveSpec) => (
    <div key={spec.key} className="space-y-1">
      <label className="block">
        {labels[spec.key] && (
          <span className="text-[11px] font-medium text-foreground">{labels[spec.key]}</span>
        )}
        <span
          className={`block font-mono text-[10px] ${labels[spec.key] ? "text-muted-foreground" : "text-foreground"}`}
        >
          {spec.directive}
        </span>
      </label>
      {spec.kind === "bool" ? (
        boolField(spec)
      ) : (
        <input
          type="text"
          inputMode={spec.kind === "int" ? "numeric" : "text"}
          value={proxy[spec.key] === undefined ? "" : String(proxy[spec.key])}
          disabled={disabled}
          placeholder={placeholderFor(spec)}
          onChange={(e) => {
            const raw = e.target.value.trim();
            if (spec.kind === "int") {
              setValue(spec.key, raw === "" ? undefined : Number(raw));
            } else {
              setValue(spec.key, raw === "" ? undefined : raw);
            }
          }}
          className={inputCls}
        />
      )}
      {hints[spec.key] && <p className="text-[10px] text-muted-foreground">{hints[spec.key]}</p>}
      {liveCell(spec.key)}
    </div>
  );

  return (
    <div className="space-y-2 border-t border-border/50 pt-4">
      <div className="flex items-start justify-between gap-3">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="flex flex-1 items-center justify-between text-left"
        >
          <div>
            <h4 className="text-[13px] font-semibold text-foreground">{w.proxyLimits}</h4>
            <p className="text-[11px] text-muted-foreground">{w.proxyLimitsHint}</p>
          </div>
          <ChevronDown
            className={`size-4 text-muted-foreground transition-transform ${open ? "rotate-180" : ""}`}
          />
        </button>
        {onRefreshEdge && (
          <button
            type="button"
            onClick={onRefreshEdge}
            disabled={edgeLoading}
            aria-label={w.proxyRefreshLive}
            title={w.proxyRefreshLive}
            className="mt-0.5 rounded-md p-1.5 text-muted-foreground hover:bg-muted/30 hover:text-foreground disabled:opacity-40"
          >
            <RefreshCw className={`size-3.5 ${edgeLoading ? "animate-spin" : ""}`} />
          </button>
        )}
      </div>

      {driftKeys.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-warning/30 bg-warning-bg px-2.5 py-2">
          <TriangleAlert className="size-3.5 shrink-0 text-warning" />
          <p className="flex-1 text-[11px] text-warning">
            {w.proxyDriftSummary}{" "}
            <span className="font-mono">{driftKeys.join(", ")}</span>
          </p>
          {Object.keys(live.adoptable).length > 0 && (
            <button
              type="button"
              onClick={adoptLive}
              disabled={disabled}
              className="shrink-0 text-[11px] font-medium text-primary hover:underline disabled:opacity-40"
            >
              {w.proxyAdoptLive}
            </button>
          )}
        </div>
      )}

      {open && (
        <div className="space-y-4 pt-1">
          {GROUP_ORDER.map((group) => {
            const specs = PROXY_DIRECTIVES.filter((s) => s.group === group);
            if (specs.length === 0) return null;
            return (
              <div key={group} className="space-y-2">
                <h5 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                  {w.proxyGroups[group]}
                </h5>
                <div className="grid gap-3 sm:grid-cols-2">{specs.map(field)}</div>
              </div>
            );
          })}
          {edge && !edge.reachable && (
            <p className="text-[10px] text-muted-foreground">{w.proxyLiveUnavailable}</p>
          )}
          {edge?.reachable && live.hosts.length > 0 && (
            <p className="text-[10px] text-muted-foreground">
              {w.proxyLiveSource} <span className="font-mono">{live.hosts.join(", ")}</span>
              {edge.nginxVersion ? ` · nginx ${edge.nginxVersion}` : ""}
            </p>
          )}
        </div>
      )}
    </div>
  );
};

export default ProxySettingsSection;
