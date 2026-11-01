"use client";

import { Icon as UiIcon } from "@repo/ui/icons";

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
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { CustomSelect } from "@/components/ui/CustomSelect";
import { Switch } from "@/components/ui/Switch";
import { useI18n } from "@/components/i18n-provider";
import type { RoutingConfig } from "@repo/core";
import type { EdgeConfigReport } from "@/lib/api/projects";
import { ProxySettingsSection } from "./ProxySettingsSection";

type Rewrite = { source: string; destination: string };
type Redirect = { source: string; destination: string; permanent?: boolean };
type HeaderRule = { source: string; headers: { key: string; value: string }[] };

function normalize(value: RoutingConfig | null | undefined): RoutingConfig {
  return {
    rewrites: value?.rewrites ?? [],
    redirects: value?.redirects ?? [],
    headers: value?.headers ?? [],
    cleanUrls: value?.cleanUrls,
    trailingSlash: value?.trailingSlash,
    proxy: value?.proxy,
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
  // Carried even when this editor doesn't render the section (the wizard), or
  // saving from there would silently wipe a limit set on the project tab.
  if (cfg.proxy && Object.keys(cfg.proxy).length > 0) out.proxy = cfg.proxy;
  return Object.keys(out).length > 0 ? out : null;
}

function RuleInput({ label, ...props }: React.ComponentProps<typeof Input> & { label: string }) {
  return (
    <label className="block min-w-0 space-y-2 text-sm text-foreground">
      <span className="font-medium">{label}</span>
      <Input {...props} />
    </label>
  );
}

const RowShell: React.FC<{
  onRemove: () => void;
  children: React.ReactNode;
  disabled?: boolean;
}> = ({ onRemove, children, disabled }) => {
  const { t } = useI18n();
  return (
    <div className="flex items-start gap-2">
      <div className="grid flex-1 min-w-0 gap-3 @lg:grid-cols-2">{children}</div>
      <Button
        type="button"
        onClick={onRemove}
        disabled={disabled}
        variant="ghost"
        size="icon"
        className="shrink-0 text-muted-foreground hover:text-danger hover:bg-danger-bg"
        aria-label={t.widgets.routing.configEditor.remove}
      >
        <UiIcon name="trash" className="size-3.5" />
      </Button>
    </div>
  );
};

const SectionHeader: React.FC<{
  title: string;
  hint: string;
  onAdd: () => void;
  disabled?: boolean;
}> = ({ title, hint, onAdd, disabled }) => {
  const { t } = useI18n();
  return (
    <div className="flex items-start justify-between gap-4">
      <div>
        <h4 className="text-sm font-medium text-foreground">{title}</h4>
        <p className="text-xs text-muted-foreground">{hint}</p>
      </div>
      <Button
        type="button"
        onClick={onAdd}
        disabled={disabled}
        variant="secondary"
        className="shrink-0"
        aria-label={`${t.widgets.routing.configEditor.add} ${title}`}
      >
        <UiIcon name="plus" className="size-3.5" /> {t.widgets.routing.configEditor.add}
      </Button>
    </div>
  );
};

export const RoutingConfigEditor: React.FC<{
  value: RoutingConfig | null | undefined;
  onChange: (next: RoutingConfig | null) => void;
  disabled?: boolean;
  /**
   * Render the proxy-limits section (upload size, timeouts, buffering, gzip).
   *
   * Off by default so the deploy wizard stays about getting a first deploy out —
   * these are knobs you reach for after something 413s or times out, not before
   * the app exists. `compact` carries the values either way, so saving from the
   * wizard can't wipe a limit set on the project tab.
   */
  showProxySettings?: boolean;
  /** Live edge read-back for the proxy section (saved vs. served), when fetched. */
  edgeConfig?: EdgeConfigReport | null;
  onRefreshEdgeConfig?: () => void;
  edgeConfigLoading?: boolean;
}> = ({
  value,
  onChange,
  disabled,
  showProxySettings,
  edgeConfig,
  onRefreshEdgeConfig,
  edgeConfigLoading,
}) => {
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
    <div className="@container space-y-4">
      {/* Rewrites */}
      <section aria-label={w.rewrites} className="rounded-2xl bg-card p-5 space-y-4">
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
            <RuleInput
              dir="ltr"
              variant="filled"
              className="min-w-0"
              label={w.source}
              placeholder="/api/(.*)"
              value={rw.source}
              disabled={disabled}
              onChange={(e) =>
                patch({
                  rewrites: rewrites.map((r, j) =>
                    j === i ? { ...r, source: e.target.value } : r,
                  ),
                })
              }
            />
            <RuleInput
              dir="ltr"
              variant="filled"
              className="min-w-0"
              label={w.destination}
              placeholder="/index.html or https://backend"
              value={rw.destination}
              disabled={disabled}
              onChange={(e) =>
                patch({
                  rewrites: rewrites.map((r, j) =>
                    j === i ? { ...r, destination: e.target.value } : r,
                  ),
                })
              }
            />
          </RowShell>
        ))}
      </section>

      {/* Redirects */}
      <section aria-label={w.redirects} className="rounded-2xl bg-card p-5 space-y-4">
        <SectionHeader
          title={w.redirects}
          hint={w.redirectsHint}
          disabled={disabled}
          onAdd={() =>
            patch({ redirects: [...redirects, { source: "", destination: "", permanent: false }] })
          }
        />
        {redirects.map((rd, i) => (
          <RowShell
            key={i}
            disabled={disabled}
            onRemove={() => patch({ redirects: redirects.filter((_, j) => j !== i) })}
          >
            <RuleInput
              dir="ltr"
              variant="filled"
              className="min-w-0"
              label={w.source}
              placeholder="/old"
              value={rd.source}
              disabled={disabled}
              onChange={(e) =>
                patch({
                  redirects: redirects.map((r, j) =>
                    j === i ? { ...r, source: e.target.value } : r,
                  ),
                })
              }
            />
            <RuleInput
              dir="ltr"
              variant="filled"
              className="min-w-0"
              label={w.destination}
              placeholder="/new"
              value={rd.destination}
              disabled={disabled}
              onChange={(e) =>
                patch({
                  redirects: redirects.map((r, j) =>
                    j === i ? { ...r, destination: e.target.value } : r,
                  ),
                })
              }
            />
            <div className="flex items-center justify-between gap-3 @lg:col-span-2">
              <span className="text-sm text-foreground">{w.permanent}</span>
              <Switch
                checked={rd.permanent !== false}
                disabled={disabled}
                ariaLabel={w.permanent}
                onChange={(checked) =>
                  patch({
                    redirects: redirects.map((r, j) =>
                      j === i ? { ...r, permanent: checked } : r,
                    ),
                  })
                }
              />
            </div>
          </RowShell>
        ))}
      </section>

      {/* Headers */}
      <section aria-label={w.headers} className="rounded-2xl bg-card p-5 space-y-4">
        <SectionHeader
          title={w.headers}
          hint={w.headersHint}
          disabled={disabled}
          onAdd={() =>
            patch({ headers: [...headers, { source: "/(.*)", headers: [{ key: "", value: "" }] }] })
          }
        />
        {headers.map((hr, i) => (
          <div key={i} className="rounded-xl bg-card p-4 space-y-3">
            <RowShell
              disabled={disabled}
              onRemove={() => patch({ headers: headers.filter((_, j) => j !== i) })}
            >
              <RuleInput
                dir="ltr"
                variant="filled"
                className="min-w-0"
                label={w.source}
                placeholder="/(.*)"
                value={hr.source}
                disabled={disabled}
                onChange={(e) =>
                  patch({
                    headers: headers.map((h, j) =>
                      j === i ? { ...h, source: e.target.value } : h,
                    ),
                  })
                }
              />
            </RowShell>
            <div className="space-y-3">
              {hr.headers.map((h, k) => (
                <div key={k} className="grid items-end gap-3 @lg:grid-cols-[1fr_1fr_auto]">
                  <RuleInput
                    dir="ltr"
                    variant="filled"
                    className="min-w-0"
                    label={w.headerName}
                    placeholder="X-Frame-Options"
                    value={h.key}
                    disabled={disabled}
                    onChange={(e) =>
                      patch({
                        headers: headers.map((row, j) =>
                          j === i
                            ? {
                                ...row,
                                headers: row.headers.map((x, m) =>
                                  m === k ? { ...x, key: e.target.value } : x,
                                ),
                              }
                            : row,
                        ),
                      })
                    }
                  />
                  <RuleInput
                    dir="ltr"
                    variant="filled"
                    className="min-w-0"
                    label={w.headerValue}
                    placeholder="DENY"
                    value={h.value}
                    disabled={disabled}
                    onChange={(e) =>
                      patch({
                        headers: headers.map((row, j) =>
                          j === i
                            ? {
                                ...row,
                                headers: row.headers.map((x, m) =>
                                  m === k ? { ...x, value: e.target.value } : x,
                                ),
                              }
                            : row,
                        ),
                      })
                    }
                  />
                  <Button
                    type="button"
                    disabled={disabled}
                    onClick={() =>
                      patch({
                        headers: headers.map((row, j) =>
                          j === i
                            ? { ...row, headers: row.headers.filter((_, m) => m !== k) }
                            : row,
                        ),
                      })
                    }
                    variant="ghost"
                    size="icon"
                    className="shrink-0 text-muted-foreground hover:text-danger hover:bg-danger-bg"
                    aria-label={w.removeHeader}
                  >
                    <UiIcon name="trash" className="size-3.5" />
                  </Button>
                </div>
              ))}
              <Button
                type="button"
                disabled={disabled}
                onClick={() =>
                  patch({
                    headers: headers.map((row, j) =>
                      j === i ? { ...row, headers: [...row.headers, { key: "", value: "" }] } : row,
                    ),
                  })
                }
                variant="secondary"
              >
                <UiIcon name="plus" className="size-3" /> {w.addHeader}
              </Button>
            </div>
          </div>
        ))}
      </section>

      <section aria-label={w.urlBehavior} className="rounded-2xl bg-card p-5 space-y-4">
        <h4 className="text-sm font-medium text-foreground">{w.urlBehavior}</h4>
        <div className="flex items-center justify-between gap-4">
          <div>
            <p className="text-sm text-foreground">{w.cleanUrls}</p>
            <p className="text-xs text-muted-foreground">{w.cleanUrlsHint}</p>
          </div>
          <Switch
            checked={!!cfg.cleanUrls}
            disabled={disabled}
            ariaLabel={w.cleanUrls}
            onChange={(checked) => patch({ cleanUrls: checked || undefined })}
          />
        </div>
        <div className="flex flex-col gap-4 @sm:flex-row @sm:items-center @sm:justify-between">
          <div>
            <p className="text-sm text-foreground">{w.trailingSlash}</p>
            <p className="text-xs text-muted-foreground">{w.trailingSlashHint}</p>
          </div>
          <CustomSelect
            variant="filled"
            triggerClassName="bg-muted/60 hover:bg-muted"
            className="w-full @sm:w-48 @sm:shrink-0"
            disabled={disabled}
            aria-label={w.trailingSlash}
            value={
              cfg.trailingSlash === undefined ? "automatic" : cfg.trailingSlash ? "add" : "remove"
            }
            onChange={(value) =>
              patch({ trailingSlash: value === "automatic" ? undefined : value === "add" })
            }
            options={[
              { value: "automatic", label: w.trailingSlashAutomatic },
              { value: "add", label: w.trailingSlashAdd },
              { value: "remove", label: w.trailingSlashRemove },
            ]}
          />
        </div>
      </section>

      {showProxySettings && (
        <ProxySettingsSection
          cfg={cfg}
          patch={patch}
          disabled={disabled}
          edge={edgeConfig}
          {...(onRefreshEdgeConfig ? { onRefreshEdge: onRefreshEdgeConfig } : {})}
          edgeLoading={edgeConfigLoading}
        />
      )}
    </div>
  );
};

export default RoutingConfigEditor;
