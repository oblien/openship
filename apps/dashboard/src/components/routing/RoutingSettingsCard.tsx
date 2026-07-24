"use client";

import React, { useCallback, useEffect, useId, useMemo, useState } from "react";
import { Globe, Shield, Server, X, Copy, Check, Info, Eye, EyeOff, Link2, Hash } from "lucide-react";
import { domainsApi } from "@/lib/api";
import { usePlatform } from "@/context/PlatformContext";
import { useI18n, interpolate } from "@/components/i18n-provider";
import { normalizeSubdomain, normalizeSubdomainInput } from "@/utils/subdomain";

interface DnsRecord {
  type: "CNAME" | "A" | "TXT";
  host: string;
  value: string;
}

export interface RoutingSettingsCardProps {
  projectName: string;
  domain: string;
  customDomain: string;
  domainType: "free" | "custom";
  targetMode?: "proxy" | "static";
  targetPath?: string;
  disabled?: boolean;
  liveUrl?: string | null;
  exposed?: boolean;
  onExposedChange?: (value: boolean) => void | Promise<void>;
  ports?: string[] | null;
  exposedPort?: string;
  readOnlyTarget?: {
    label: string;
    value: string;
    icon?: "port" | "path";
  };
  onExposedPortChange?: (value: string) => void | Promise<void>;
  onTargetPathChange?: (value: string) => void | Promise<void>;
  onDomainTypeChange: (value: "free" | "custom") => void | Promise<void>;
  onDomainChange: (value: string) => void | Promise<void>;
  onCustomDomainChange: (value: string) => void | Promise<void>;
  saveMode?: "change" | "explicit";
  /** Optional control rendered on the RIGHT of the Free/Custom row (e.g. an
   *  "add domain" button when the parent hides its own header). */
  actionSlot?: React.ReactNode;
  /** Place the exposed-port field to the RIGHT of the domain input (label above)
   *  instead of on its own row below — saves height when there's horizontal room. */
  portInline?: boolean;
  /** Hide the Free/Custom segmented — the caller drives `domainType` from its
   *  own outer control (avoids a redundant nested toggle). */
  hideTypeToggle?: boolean;
}

export function RoutingSettingsCard({
  projectName,
  domain,
  customDomain,
  domainType,
  targetMode = "proxy",
  targetPath,
  disabled = false,
  exposed,
  onExposedChange,
  ports,
  exposedPort,
  readOnlyTarget,
  onExposedPortChange,
  onTargetPathChange,
  onDomainTypeChange,
  onDomainChange,
  onCustomDomainChange,
  saveMode = "change",
  actionSlot,
  portInline = false,
  hideTypeToggle = false,
}: RoutingSettingsCardProps) {
  const { baseDomain } = usePlatform();
  const { t } = useI18n();
  const w = t.widgets.routing.settingsCard;
  const portListId = useId();
  const [showDnsModal, setShowDnsModal] = useState(false);
  const [dnsRecords, setDnsRecords] = useState<DnsRecord[]>([]);
  const [dnsMode, setDnsMode] = useState<"cloud" | "selfhosted" | "external">("cloud");
  const [loadingRecords, setLoadingRecords] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const [draftDomain, setDraftDomain] = useState(domain);
  const [draftCustomDomain, setDraftCustomDomain] = useState(customDomain);
  const [draftPort, setDraftPort] = useState(exposedPort ?? "");
  const [draftTargetPath, setDraftTargetPath] = useState(targetPath ?? "/");

  useEffect(() => {
    setDraftDomain(domain);
  }, [domain]);

  useEffect(() => {
    setDraftCustomDomain(customDomain);
  }, [customDomain]);

  useEffect(() => {
    setDraftPort(exposedPort ?? "");
  }, [exposedPort]);

  useEffect(() => {
    setDraftTargetPath(targetPath ?? "/");
  }, [targetPath]);

  const visible = exposed ?? true;
  const hasPortOptions = (ports ?? []).length > 0;
  const showsPortTarget = targetMode === "proxy" && typeof exposedPort !== "undefined" && onExposedPortChange;
  const showsPathTarget = targetMode === "static" && onTargetPathChange;
  const showsReadOnlyTarget = !showsPortTarget && !showsPathTarget && Boolean(readOnlyTarget?.value);
  const portOptions = useMemo(
    () => (ports ?? []).map((value) => {
      const parts = value.split(":");
      return parts.length === 2 ? parts[1].split("/")[0] : parts[0].split("/")[0];
    }),
    [ports],
  );

  const previewHostname = domainType === "custom" ? draftCustomDomain : "";
  const freePreview = `${draftDomain || projectName || "my-project"}.${baseDomain}`;

  const copy = (text: string, id: string) => {
    navigator.clipboard.writeText(text);
    setCopied(id);
    setTimeout(() => setCopied(null), 2000);
  };

  const fetchRecords = useCallback(async (hostname: string) => {
    if (!hostname || hostname.length < 3 || !hostname.includes(".")) return;
    setLoadingRecords(true);
    try {
      const res = await domainsApi.previewRecords(hostname);
      setDnsRecords(res.data.records);
      setDnsMode(res.data.mode);
    } catch {
      setDnsRecords([]);
    } finally {
      setLoadingRecords(false);
    }
  }, []);

  useEffect(() => {
    if (domainType !== "custom" || !previewHostname) {
      setDnsRecords([]);
      return;
    }

    const timer = setTimeout(() => {
      void fetchRecords(previewHostname);
    }, 400);

    return () => clearTimeout(timer);
  }, [domainType, previewHostname, fetchRecords]);

  const hasRecords = dnsRecords.length > 0 && dnsRecords.every((record) => record.value);

  const commitFreeDomain = () => {
    const next = normalizeSubdomain(draftDomain);
    void onDomainChange(next);
  };

  const commitCustomDomain = () => {
    void onCustomDomainChange(draftCustomDomain.toLowerCase());
  };

  const commitPort = () => {
    if (onExposedPortChange) {
      void onExposedPortChange(draftPort);
    }
  };

  const commitTargetPath = () => {
    if (onTargetPathChange) {
      void onTargetPathChange(draftTargetPath.trim() || "/");
    }
  };

  // Exposed-port field with the label ABOVE — used when `portInline` places it
  // to the right of the domain input. Matches the input height (h-11) so the
  // two bottom-align.
  const portInlineField = showsPortTarget ? (
    <div className="shrink-0">
      <label className="mb-1.5 block text-[13px] font-medium text-muted-foreground">{w.exposedPort}</label>
      <input
        type="text"
        inputMode="numeric"
        value={saveMode === "explicit" ? draftPort : exposedPort}
        onChange={(event) => {
          if (saveMode === "explicit") setDraftPort(event.target.value);
          else void onExposedPortChange!(event.target.value);
        }}
        onBlur={() => {
          if (saveMode === "explicit" && draftPort !== (exposedPort ?? "")) commitPort();
        }}
        placeholder="3000"
        disabled={disabled}
        list={hasPortOptions ? portListId : undefined}
        className="w-24 h-11 rounded-2xl border border-border/50 bg-background/60 px-3.5 text-sm text-foreground outline-none"
      />
      {hasPortOptions && (
        <datalist id={portListId}>
          {portOptions.map((port) => (
            <option key={port} value={port} />
          ))}
        </datalist>
      )}
    </div>
  ) : null;

  return (
    <div className="space-y-3">
      {typeof exposed === "boolean" && onExposedChange && (
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            {visible ? <Eye className="size-4 text-info" /> : <EyeOff className="size-4 text-muted-foreground" />}
            <span className="text-sm font-medium text-foreground">
              {visible ? w.publiclyExposed : w.internalOnly}
            </span>
          </div>
          <button
            type="button"
            onClick={() => void onExposedChange(!visible)}
            disabled={disabled}
            className={`relative rounded-full transition-colors duration-200 ${visible ? "bg-info-solid" : "bg-muted-foreground/20"}`}
            style={{ height: "22px", width: "40px" }}
          >
            <span className={`absolute top-0.5 start-0.5 w-[18px] h-[18px] rounded-full bg-background shadow-sm transition-transform duration-200 ${visible ? "translate-x-[18px] rtl:-translate-x-[18px]" : "translate-x-0"}`} />
          </button>
        </div>
      )}

      {visible && (
        <div className="space-y-2">
          {(!hideTypeToggle || (!portInline && actionSlot)) && (
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                {!hideTypeToggle && (
                  <>
                    <button
                      type="button"
                      onClick={() => void onDomainTypeChange("free")}
                      disabled={disabled}
                      aria-label={w.freeSubdomain}
                      className={`px-4 py-2 rounded-xl text-sm font-medium transition-colors ${domainType === "free" ? "bg-primary/10 text-primary ring-1 ring-primary/15" : "bg-muted/40 text-muted-foreground hover:bg-muted/60"}`}
                    >
                      {w.free}
                    </button>
                    <button
                      type="button"
                      onClick={() => void onDomainTypeChange("custom")}
                      disabled={disabled}
                      aria-label={w.customDomain}
                      className={`px-4 py-2 rounded-xl text-sm font-medium transition-colors ${domainType === "custom" ? "bg-primary/10 text-primary ring-1 ring-primary/15" : "bg-muted/40 text-muted-foreground hover:bg-muted/60"}`}
                    >
                      {w.custom}
                    </button>
                  </>
                )}
              </div>
              {/* When the port is inline, the add-domain "+" moves to the end of
                  the input row (after Exposed port); otherwise it sits here. */}
              {!portInline && actionSlot}
            </div>
          )}

          {domainType === "free" ? (
            <div className="flex items-end gap-2">
              <div className="min-w-0 flex-1 flex items-center gap-2">
                <div className="flex-1 flex items-center rounded-2xl border border-border/50 bg-background/60 overflow-hidden h-11">
                  <input
                    value={saveMode === "explicit" ? draftDomain : domain}
                    onChange={(event) => {
                      const next = normalizeSubdomainInput(event.target.value);
                      if (saveMode === "explicit") {
                        setDraftDomain(next);
                      } else {
                        void onDomainChange(next);
                      }
                    }}
                    onBlur={() => {
                      // Commit on blur so a typed change isn't silently lost if the
                      // modal is closed without clicking the inline Save pill.
                      if (saveMode === "explicit" && draftDomain !== domain) commitFreeDomain();
                    }}
                    placeholder={projectName || "my-project"}
                    className="min-w-0 flex-1 h-full ps-3.5 text-sm bg-transparent outline-none text-foreground placeholder:text-muted-foreground/40"
                  />
                  <span className="shrink-0 ps-2 pe-3.5 text-sm text-muted-foreground">.{baseDomain}</span>
                </div>
                {saveMode === "explicit" && draftDomain !== domain && (
                  <button
                    type="button"
                    onClick={commitFreeDomain}
                    disabled={disabled}
                    className="px-3 py-2 rounded-xl text-[12px] font-medium bg-primary text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50"
                  >
                    {w.save}
                  </button>
                )}
              </div>
              {portInline && portInlineField}
              {portInline && actionSlot}
            </div>
          ) : (
            <div className="space-y-2">
              <div className="flex items-end gap-2">
                <div className="min-w-0 flex-1 flex items-center gap-2">
                  <div className="flex-1 flex items-center rounded-2xl border border-border/50 bg-background/60 overflow-hidden h-11">
                  <input
                    value={saveMode === "explicit" ? draftCustomDomain : customDomain}
                    onChange={(event) => {
                      const next = event.target.value.toLowerCase();
                      if (saveMode === "explicit") {
                        setDraftCustomDomain(next);
                      } else {
                        void onCustomDomainChange(next);
                      }
                    }}
                    onBlur={() => {
                      if (saveMode === "explicit" && draftCustomDomain !== customDomain) commitCustomDomain();
                    }}
                    placeholder="app.example.com"
                    className="flex-1 h-full px-3.5 text-sm bg-transparent outline-none text-foreground placeholder:text-muted-foreground/40"
                  />
                </div>
                {saveMode === "explicit" && draftCustomDomain !== customDomain && (
                  <button
                    type="button"
                    onClick={commitCustomDomain}
                    disabled={disabled}
                    className="px-3 py-2 rounded-xl text-[12px] font-medium bg-primary text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50"
                  >
                    {w.save}
                  </button>
                )}
                </div>
                {portInline && portInlineField}
                {portInline && actionSlot}
              </div>

              {/* DNS hint — lazy: only shown once records are resolvable (or
                  loading). No "enter a valid domain" nag; DNS isn't required up
                  front (verified later at preflight / in domain settings). */}
              {(loadingRecords || hasRecords) && (
                <div className="rounded-lg border border-border/50 bg-muted/20 overflow-hidden">
                  <div className="flex items-center gap-2 px-3 py-2">
                    <Server className="size-3 text-muted-foreground shrink-0" />
                    {loadingRecords ? (
                      <p className="text-sm text-muted-foreground flex-1">{w.checkingDns}</p>
                    ) : (
                      <p className="text-sm text-muted-foreground flex-1">
                        {interpolate(w.addRecordHint, {
                          primary: dnsRecords.find((record) => record.type !== "TXT")?.type ?? "",
                          txt: "TXT",
                        })}
                      </p>
                    )}
                    {hasRecords && (
                      <button
                        type="button"
                        onClick={() => setShowDnsModal(true)}
                        className="text-xs text-primary hover:text-primary/80 font-medium shrink-0 transition-colors"
                      >
                        {w.viewRecords}
                      </button>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}

          {!portInline && showsPortTarget && (
            <div className="flex items-center gap-3">
              <div className="flex items-center gap-2">
                <Hash className="size-3.5 text-muted-foreground" />
                <span className="text-[13px] text-muted-foreground font-medium">{w.exposedPort}</span>
              </div>
              <input
                type="text"
                inputMode="numeric"
                value={saveMode === "explicit" ? draftPort : exposedPort}
                onChange={(event) => {
                  if (saveMode === "explicit") {
                    setDraftPort(event.target.value);
                  } else {
                    void onExposedPortChange(event.target.value);
                  }
                }}
                onBlur={() => {
                  if (saveMode === "explicit" && draftPort !== (exposedPort ?? "")) commitPort();
                }}
                placeholder="3000"
                disabled={disabled}
                list={hasPortOptions ? portListId : undefined}
                className="w-24 px-3 py-2 rounded-xl text-sm bg-muted/30 border border-border/40 text-foreground outline-none"
              />
              {hasPortOptions && (
                <datalist id={portListId}>
                  {portOptions.map((port) => (
                    <option key={port} value={port} />
                  ))}
                </datalist>
              )}
              {saveMode === "explicit" && draftPort !== (exposedPort ?? "") && (
                <button
                  type="button"
                  onClick={commitPort}
                  disabled={disabled}
                  className="px-3 py-2 rounded-xl text-[12px] font-medium bg-primary text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50"
                >
                  {w.save}
                </button>
              )}
            </div>
          )}

          {showsReadOnlyTarget && readOnlyTarget ? (
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                {readOnlyTarget.icon === "path" ? (
                  <Link2 className="size-3.5 text-muted-foreground" />
                ) : (
                  <Hash className="size-3.5 text-muted-foreground" />
                )}
                <span className="text-[13px] text-muted-foreground font-medium">
                  {readOnlyTarget.label}
                </span>
              </div>
              <span className="text-[13px] font-medium text-foreground">
                {readOnlyTarget.value}
              </span>
            </div>
          ) : null}

          {showsPathTarget && (
            <div className="space-y-2">
              <div className="flex items-center gap-3">
                <div className="flex items-center gap-2">
                  <Link2 className="size-3.5 text-muted-foreground" />
                  <span className="text-[13px] text-muted-foreground font-medium">{w.staticPath}</span>
                </div>
                <div className="flex items-center gap-2 flex-1">
                  <input
                    value={saveMode === "explicit" ? draftTargetPath : (targetPath || "/")}
                    onChange={(event) => {
                      if (saveMode === "explicit") {
                        setDraftTargetPath(event.target.value);
                      } else {
                        void onTargetPathChange(event.target.value || "/");
                      }
                    }}
                    placeholder="/"
                    disabled={disabled}
                    className="flex-1 px-3 py-2 rounded-xl text-sm bg-muted/30 border border-border/40 text-foreground outline-none"
                  />
                  {saveMode === "explicit" && draftTargetPath !== (targetPath ?? "/") && (
                    <button
                      type="button"
                      onClick={commitTargetPath}
                      disabled={disabled}
                      className="px-3 py-2 rounded-xl text-[12px] font-medium bg-primary text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50"
                    >
                      {w.save}
                    </button>
                  )}
                </div>
              </div>
              <p className="text-sm text-muted-foreground">
                {interpolate(w.staticPathHint, { path: "/" })}
              </p>
            </div>
          )}

        </div>
      )}

      {showDnsModal && hasRecords && (
        <div className="fixed inset-0 bg-background/80 backdrop-blur-sm flex items-center justify-center z-50 p-4" onClick={() => setShowDnsModal(false)}>
          <div className="max-w-xl w-full" onClick={(event) => event.stopPropagation()}>
            <div className="relative bg-card rounded-xl border border-border/50 shadow-lg overflow-hidden animate-in fade-in zoom-in-95 duration-200">
              <button onClick={() => setShowDnsModal(false)} className="absolute top-3 end-3 w-8 h-8 bg-muted/50 rounded-lg flex items-center justify-center hover:bg-muted transition-colors z-10">
                <X className="size-4 text-muted-foreground" />
              </button>

              <div className="flex items-center gap-3 px-5 py-4 border-b border-border/40">
                <div className="w-9 h-9 rounded-lg bg-primary/10 flex items-center justify-center">
                  <Server className="size-4 text-primary" />
                </div>
                <div>
                  <h3 className="text-sm font-semibold text-foreground">{w.dnsConfiguration}</h3>
                  <p className="text-xs text-muted-foreground">{interpolate(w.addRecordsFor, { hostname: previewHostname })}</p>
                </div>
              </div>

              <div className="p-5 space-y-3">
                {dnsRecords.map((record, index) => (
                  <div key={`${record.type}-${index}`} className="bg-muted/30 rounded-xl border border-border/50 p-4">
                    <div className="flex items-center gap-3 mb-3">
                      <span className="px-2.5 py-1 bg-foreground text-background text-xs font-bold rounded-lg">{record.type}</span>
                      <span className="text-xs text-muted-foreground">{w.recordLabels[record.type] ?? ""}</span>
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider mb-1.5">{w.nameHost}</p>
                        <div className="flex items-center gap-2 bg-background rounded-lg border border-border/50 px-3 py-2">
                          <code className="flex-1 text-sm font-medium text-foreground">{record.host}</code>
                          <button onClick={() => copy(record.host, `${index}-host`)} className="p-1 hover:bg-muted rounded-md transition-colors shrink-0">
                            {copied === `${index}-host` ? <Check className="size-3.5 text-success" /> : <Copy className="size-3.5 text-muted-foreground" />}
                          </button>
                        </div>
                      </div>
                      <div>
                        <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider mb-1.5">{w.valueTarget}</p>
                        <div className="flex items-center gap-2 bg-background rounded-lg border border-border/50 px-3 py-2">
                          <code className="flex-1 text-sm font-medium text-foreground truncate">{record.value}</code>
                          <button onClick={() => copy(record.value, `${index}-value`)} className="p-1 hover:bg-muted rounded-md transition-colors shrink-0">
                            {copied === `${index}-value` ? <Check className="size-3.5 text-success" /> : <Copy className="size-3.5 text-muted-foreground" />}
                          </button>
                        </div>
                      </div>
                    </div>
                  </div>
                ))}

                <div className="flex items-start gap-2 p-3 bg-primary/5 rounded-xl border border-primary/10">
                  <Info className="size-3.5 text-primary shrink-0 mt-0.5" />
                  <p className="text-xs text-muted-foreground leading-relaxed">
                    {dnsMode === "selfhosted" ? w.dnsHintSelfhosted : w.dnsHintCloud} {w.dnsPropagation}
                  </p>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
