"use client";

/**
 * Controlled editor for a project's vercel.json-derived routing config
 * (rewrites / redirects / headers / cleanUrls / trailingSlash). Used in BOTH the
 * deploy wizard (advanced options) and the project Routing/Domains tab.
 *
 * Detected from the repo's vercel.json at prepare; the user can review/edit here
 * before deploy, or edit a live project (the backend re-applies to OpenResty
 * without a rebuild). Self-hosted only today — cloud edge routing is pending.
 */

import React, { useCallback } from "react";
import { Plus, Trash2, ArrowRight } from "lucide-react";
import { useI18n } from "@/components/i18n-provider";
import type { RoutingConfig } from "@repo/core";

type Rewrite = { source: string; destination: string };
type Redirect = { source: string; destination: string; permanent?: boolean };
type HeaderRule = { source: string; headers: { key: string; value: string }[] };

const EMPTY: Required<Pick<RoutingConfig, "rewrites" | "redirects" | "headers">> = {
  rewrites: [],
  redirects: [],
  headers: [],
};

function normalize(value: RoutingConfig | null | undefined): RoutingConfig {
  return {
    rewrites: value?.rewrites ?? [],
    redirects: value?.redirects ?? [],
    headers: value?.headers ?? [],
    cleanUrls: value?.cleanUrls,
    trailingSlash: value?.trailingSlash,
  };
}

/** Collapse to null when nothing is configured, so we don't persist an empty blob. */
function compact(cfg: RoutingConfig): RoutingConfig | null {
  const out: RoutingConfig = {};
  if (cfg.rewrites?.length) out.rewrites = cfg.rewrites;
  if (cfg.redirects?.length) out.redirects = cfg.redirects;
  if (cfg.headers?.length) out.headers = cfg.headers;
  if (cfg.cleanUrls !== undefined) out.cleanUrls = cfg.cleanUrls;
  if (cfg.trailingSlash !== undefined) out.trailingSlash = cfg.trailingSlash;
  return Object.keys(out).length > 0 ? out : null;
}

const inputCls =
  "w-full px-2.5 py-1.5 bg-muted/30 border border-border/50 rounded-lg text-sm text-foreground font-mono placeholder:text-muted-foreground/50 focus:outline-none focus:ring-2 focus:ring-primary/20";

const RowShell: React.FC<{ onRemove: () => void; children: React.ReactNode; disabled?: boolean }> = ({
  onRemove,
  children,
  disabled,
}) => {
  const { t } = useI18n();
  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 min-w-0 flex items-center gap-2">{children}</div>
      <button
        type="button"
        onClick={onRemove}
        disabled={disabled}
        className="p-1.5 rounded-md text-muted-foreground hover:text-danger hover:bg-danger-bg disabled:opacity-40"
        aria-label={t.widgets.routing.configEditor.remove}
      >
        <Trash2 className="size-3.5" />
      </button>
    </div>
  );
};

const SectionHeader: React.FC<{ title: string; hint: string; onAdd: () => void; disabled?: boolean }> = ({
  title,
  hint,
  onAdd,
  disabled,
}) => {
  const { t } = useI18n();
  return (
    <div className="flex items-center justify-between">
      <div>
        <h4 className="text-[13px] font-semibold text-foreground">{title}</h4>
        <p className="text-[11px] text-muted-foreground">{hint}</p>
      </div>
      <button
        type="button"
        onClick={onAdd}
        disabled={disabled}
        className="flex items-center gap-1 text-xs text-primary hover:underline disabled:opacity-40"
      >
        <Plus className="size-3.5" /> {t.widgets.routing.configEditor.add}
      </button>
    </div>
  );
};

export const RoutingConfigEditor: React.FC<{
  value: RoutingConfig | null | undefined;
  onChange: (next: RoutingConfig | null) => void;
  disabled?: boolean;
}> = ({ value, onChange, disabled }) => {
  const { t } = useI18n();
  const w = t.widgets.routing.configEditor;
  const cfg = normalize(value);

  const patch = useCallback(
    (updates: Partial<RoutingConfig>) => onChange(compact({ ...cfg, ...updates })),
    [cfg, onChange],
  );

  const rewrites = (cfg.rewrites ?? []) as Rewrite[];
  const redirects = (cfg.redirects ?? []) as Redirect[];
  const headers = (cfg.headers ?? []) as HeaderRule[];

  return (
    <div className="space-y-5">
      {/* Rewrites */}
      <div className="space-y-2">
        <SectionHeader
          title={w.rewrites}
          hint={w.rewritesHint}
          disabled={disabled}
          onAdd={() => patch({ rewrites: [...rewrites, { source: "", destination: "" }] })}
        />
        {rewrites.map((rw, i) => (
          <RowShell
            key={i}
            disabled={disabled}
            onRemove={() => patch({ rewrites: rewrites.filter((_, j) => j !== i) })}
          >
            <input
              className={inputCls}
              placeholder="/api/(.*)"
              value={rw.source}
              disabled={disabled}
              onChange={(e) =>
                patch({ rewrites: rewrites.map((r, j) => (j === i ? { ...r, source: e.target.value } : r)) })
              }
            />
            <ArrowRight className="size-3.5 text-muted-foreground shrink-0 rtl:rotate-180" />
            <input
              className={inputCls}
              placeholder="/index.html or https://backend"
              value={rw.destination}
              disabled={disabled}
              onChange={(e) =>
                patch({
                  rewrites: rewrites.map((r, j) => (j === i ? { ...r, destination: e.target.value } : r)),
                })
              }
            />
          </RowShell>
        ))}
      </div>

      {/* Redirects */}
      <div className="space-y-2">
        <SectionHeader
          title={w.redirects}
          hint={w.redirectsHint}
          disabled={disabled}
          onAdd={() => patch({ redirects: [...redirects, { source: "", destination: "", permanent: false }] })}
        />
        {redirects.map((rd, i) => (
          <RowShell
            key={i}
            disabled={disabled}
            onRemove={() => patch({ redirects: redirects.filter((_, j) => j !== i) })}
          >
            <input
              className={inputCls}
              placeholder="/old"
              value={rd.source}
              disabled={disabled}
              onChange={(e) =>
                patch({ redirects: redirects.map((r, j) => (j === i ? { ...r, source: e.target.value } : r)) })
              }
            />
            <ArrowRight className="size-3.5 text-muted-foreground shrink-0 rtl:rotate-180" />
            <input
              className={inputCls}
              placeholder="/new"
              value={rd.destination}
              disabled={disabled}
              onChange={(e) =>
                patch({
                  redirects: redirects.map((r, j) => (j === i ? { ...r, destination: e.target.value } : r)),
                })
              }
            />
            <label className="flex items-center gap-1 text-[11px] text-muted-foreground shrink-0 whitespace-nowrap">
              <input
                type="checkbox"
                checked={!!rd.permanent}
                disabled={disabled}
                onChange={(e) =>
                  patch({
                    redirects: redirects.map((r, j) => (j === i ? { ...r, permanent: e.target.checked } : r)),
                  })
                }
              />
              {w.permanent}
            </label>
          </RowShell>
        ))}
      </div>

      {/* Headers */}
      <div className="space-y-3">
        <SectionHeader
          title={w.headers}
          hint={w.headersHint}
          disabled={disabled}
          onAdd={() => patch({ headers: [...headers, { source: "/(.*)", headers: [{ key: "", value: "" }] }] })}
        />
        {headers.map((hr, i) => (
          <div key={i} className="rounded-lg border border-border/50 p-2.5 space-y-2">
            <RowShell
              disabled={disabled}
              onRemove={() => patch({ headers: headers.filter((_, j) => j !== i) })}
            >
              <input
                className={inputCls}
                placeholder="/(.*)"
                value={hr.source}
                disabled={disabled}
                onChange={(e) =>
                  patch({ headers: headers.map((h, j) => (j === i ? { ...h, source: e.target.value } : h)) })
                }
              />
            </RowShell>
            <div className="ps-2 space-y-1.5">
              {hr.headers.map((h, k) => (
                <div key={k} className="flex items-center gap-2">
                  <input
                    className={inputCls}
                    placeholder="X-Frame-Options"
                    value={h.key}
                    disabled={disabled}
                    onChange={(e) =>
                      patch({
                        headers: headers.map((row, j) =>
                          j === i
                            ? { ...row, headers: row.headers.map((x, m) => (m === k ? { ...x, key: e.target.value } : x)) }
                            : row,
                        ),
                      })
                    }
                  />
                  <input
                    className={inputCls}
                    placeholder="DENY"
                    value={h.value}
                    disabled={disabled}
                    onChange={(e) =>
                      patch({
                        headers: headers.map((row, j) =>
                          j === i
                            ? { ...row, headers: row.headers.map((x, m) => (m === k ? { ...x, value: e.target.value } : x)) }
                            : row,
                        ),
                      })
                    }
                  />
                  <button
                    type="button"
                    disabled={disabled}
                    onClick={() =>
                      patch({
                        headers: headers.map((row, j) =>
                          j === i ? { ...row, headers: row.headers.filter((_, m) => m !== k) } : row,
                        ),
                      })
                    }
                    className="p-1.5 rounded-md text-muted-foreground hover:text-danger hover:bg-danger-bg disabled:opacity-40"
                    aria-label={w.removeHeader}
                  >
                    <Trash2 className="size-3.5" />
                  </button>
                </div>
              ))}
              <button
                type="button"
                disabled={disabled}
                onClick={() =>
                  patch({
                    headers: headers.map((row, j) =>
                      j === i ? { ...row, headers: [...row.headers, { key: "", value: "" }] } : row,
                    ),
                  })
                }
                className="flex items-center gap-1 text-[11px] text-primary hover:underline disabled:opacity-40"
              >
                <Plus className="size-3" /> {w.addHeader}
              </button>
            </div>
          </div>
        ))}
      </div>

      {/* Flags */}
      <div className="flex flex-wrap gap-4 pt-1">
        <label className="flex items-center gap-2 text-xs text-foreground">
          <input
            type="checkbox"
            checked={!!cfg.cleanUrls}
            disabled={disabled}
            onChange={(e) => patch({ cleanUrls: e.target.checked || undefined })}
          />
          {w.cleanUrls} <span className="text-muted-foreground">{w.cleanUrlsHint}</span>
        </label>
        <label className="flex items-center gap-2 text-xs text-foreground">
          <input
            type="checkbox"
            checked={!!cfg.trailingSlash}
            disabled={disabled}
            onChange={(e) => patch({ trailingSlash: e.target.checked || undefined })}
          />
          {w.trailingSlash}
        </label>
      </div>
    </div>
  );
};

export default RoutingConfigEditor;
