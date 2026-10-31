"use client";

import { Icon as UiIcon } from "@repo/ui/icons";

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
 *  - Show what the generated edge configuration contains beside what we saved. A
 *    hand-edited vhost, a value the sanitizer dropped, or a directive the box's nginx
 *    is too old for all leave the two apart, and until this read-back nothing
 *    surfaced it. A matching file does not prove the workers reloaded it.
 *
 * Human labels lead; optional technical details keep directive names available.
 * New directives still render from the shared table with a readable fallback label.
 */

import React, { useId } from "react";
import { Input } from "@/components/ui/input";
import { CustomSelect } from "@/components/ui/CustomSelect";
import { Button } from "@/components/ui/button";
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

/** What one host's configuration holds for one directive, as text. */
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
  const fieldId = useId();
  const hints: Record<string, string | undefined> = {
    clientMaxBodySize: w.maxBodySizeHint,
    proxyReadTimeout: w.readTimeoutHint,
    proxySendTimeout: w.sendTimeoutHint,
    clientBodyTimeout: w.bodyTimeoutHint,
    proxyBuffering: w.proxyBufferingHint,
    gzip: w.gzipHint,
  };
  const labels: Record<string, string> = w.proxyLabels;
  const labelFor = (spec: ProxyDirectiveSpec) =>
    labels[spec.key] ?? spec.key.replace(/([a-z])([A-Z])/g, "$1 $2");

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
        className={`text-xs break-words ${cell.drift ? "text-warning" : "text-muted-foreground"}`}
        title={title}
      >
        {w.proxyLiveLabel} {text}
        {cell.drift ? ` · ${w.proxyDrift}` : ""}
      </p>
    );
  };

  const field = (spec: ProxyDirectiveSpec) => {
    const id = `${fieldId}-${spec.key}`;
    const value = proxy[spec.key];
    return (
      <div key={spec.key} className="min-w-0 space-y-2">
        <label htmlFor={id} className="block text-sm font-medium text-foreground">
          {labelFor(spec)}
        </label>
        {spec.kind === "bool" ? (
          <CustomSelect
            id={id}
            aria-label={labelFor(spec)}
            variant="filled"
            triggerClassName="bg-muted/60 hover:bg-muted"
            disabled={disabled}
            value={value === true ? "on" : value === false ? "off" : ""}
            onChange={(next) => setValue(spec.key, next === "" ? undefined : next === "on")}
            options={[
              { value: "", label: w.proxyInherit },
              { value: "on", label: w.enabled },
              { value: "off", label: w.disabled },
            ]}
          />
        ) : (
          <Input
            id={id}
            dir="ltr"
            variant="filled"
            type="text"
            inputMode={spec.kind === "int" ? "numeric" : "text"}
            aria-describedby={hints[spec.key] ? `${id}-hint` : undefined}
            value={value === undefined ? "" : String(value)}
            disabled={disabled}
            placeholder={placeholderFor(spec)}
            onChange={(e) => {
              const raw = e.target.value.trim();
              setValue(spec.key, raw === "" ? undefined : spec.kind === "int" ? Number(raw) : raw);
            }}
          />
        )}
        {hints[spec.key] && (
          <p id={`${id}-hint`} className="text-xs text-muted-foreground">
            {hints[spec.key]}
          </p>
        )}
        {liveCell(spec.key)}
      </div>
    );
  };

  return (
    <section className="space-y-4" aria-label={w.proxyLimits}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-base font-medium text-foreground">{w.proxyLimits}</h3>
          <p className="mt-1 text-xs text-muted-foreground">{w.proxyLimitsHint}</p>
        </div>
        {onRefreshEdge && (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={onRefreshEdge}
            disabled={edgeLoading}
            aria-label={w.proxyRefreshLive}
            title={w.proxyRefreshLive}
          >
            <UiIcon name="refresh" className={`size-4 ${edgeLoading ? "animate-spin" : ""}`} />
          </Button>
        )}
      </div>
      {driftKeys.length > 0 && (
        <div className="flex flex-wrap items-center gap-3 rounded-xl bg-warning-bg p-4">
          <p className="min-w-0 flex-1 text-sm text-warning">
            {w.proxyDriftSummary} {driftKeys.map((key) => labels[key] ?? key).join(", ")}
          </p>
          {Object.keys(live.adoptable).length > 0 && (
            <Button type="button" variant="secondary" onClick={adoptLive} disabled={disabled}>
              {w.proxyAdoptLive}
            </Button>
          )}
        </div>
      )}
      <div className="grid items-start gap-4 @3xl:grid-cols-2">
        {GROUP_ORDER.map((group) => {
          const specs = PROXY_DIRECTIVES.filter((s) => s.group === group);
          if (specs.length === 0) return null;
          return (
            <section
              key={group}
              className="@container min-w-0 rounded-2xl bg-card p-5"
              aria-labelledby={`${fieldId}-${group}`}
            >
              <h4 id={`${fieldId}-${group}`} className="mb-4 text-sm font-medium text-foreground">
                {w.proxyGroups[group]}
              </h4>
              <div className="grid gap-4 @sm:grid-cols-2">{specs.map(field)}</div>
              <details className="mt-4 text-xs text-muted-foreground">
                <summary className="w-fit cursor-pointer rounded focus-visible:outline-2 focus-visible:outline-ring">
                  {w.technicalDetails}
                </summary>
                <dl className="mt-2 space-y-2">
                  {specs.map((spec) => (
                    <div key={spec.key}>
                      <dt>{labelFor(spec)}</dt>
                      <dd dir="ltr" className="break-all">
                        {spec.directive}
                      </dd>
                    </div>
                  ))}
                </dl>
              </details>
            </section>
          );
        })}
      </div>
      {edge && !edge.reachable && (
        <p className="text-xs text-muted-foreground">{w.proxyLiveUnavailable}</p>
      )}
      {edge?.reachable && live.hosts.length > 0 && (
        <p className="break-words text-xs text-muted-foreground">
          {w.proxyLiveSource} {live.hosts.join(", ")}
          {edge.nginxVersion ? ` · nginx ${edge.nginxVersion}` : ""}
        </p>
      )}
    </section>
  );
};

export default ProxySettingsSection;
