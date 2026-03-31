"use client";

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Globe, Shield, Server, X, Copy, Check, Info, Eye, EyeOff, Link2, ExternalLink, Hash } from "lucide-react";
import { domainsApi } from "@/lib/api";
import { usePlatform } from "@/context/PlatformContext";

interface DnsRecord {
  type: "CNAME" | "A" | "TXT";
  host: string;
  value: string;
}

const RECORD_LABELS: Record<string, string> = {
  CNAME: "Routes traffic through the edge network",
  A: "Points to your server IP",
  TXT: "Verifies domain ownership",
};

export interface RoutingSettingsCardProps {
  projectName: string;
  domain: string;
  customDomain: string;
  domainType: "free" | "custom";
  disabled?: boolean;
  liveUrl?: string | null;
  exposed?: boolean;
  onExposedChange?: (value: boolean) => void | Promise<void>;
  ports?: string[] | null;
  exposedPort?: string;
  onExposedPortChange?: (value: string) => void | Promise<void>;
  onDomainTypeChange: (value: "free" | "custom") => void | Promise<void>;
  onDomainChange: (value: string) => void | Promise<void>;
  onCustomDomainChange: (value: string) => void | Promise<void>;
  saveMode?: "change" | "explicit";
}

export function RoutingSettingsCard({
  projectName,
  domain,
  customDomain,
  domainType,
  disabled = false,
  liveUrl,
  exposed,
  onExposedChange,
  ports,
  exposedPort,
  onExposedPortChange,
  onDomainTypeChange,
  onDomainChange,
  onCustomDomainChange,
  saveMode = "change",
}: RoutingSettingsCardProps) {
  const { baseDomain } = usePlatform();
  const [showDnsModal, setShowDnsModal] = useState(false);
  const [dnsRecords, setDnsRecords] = useState<DnsRecord[]>([]);
  const [dnsMode, setDnsMode] = useState<"cloud" | "selfhosted">("cloud");
  const [loadingRecords, setLoadingRecords] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const [draftDomain, setDraftDomain] = useState(domain);
  const [draftCustomDomain, setDraftCustomDomain] = useState(customDomain);
  const [draftPort, setDraftPort] = useState(exposedPort ?? "");

  useEffect(() => {
    setDraftDomain(domain);
  }, [domain]);

  useEffect(() => {
    setDraftCustomDomain(customDomain);
  }, [customDomain]);

  useEffect(() => {
    setDraftPort(exposedPort ?? "");
  }, [exposedPort]);

  const visible = exposed ?? true;
  const hasPortOptions = (ports ?? []).length > 0;
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
    const next = draftDomain.toLowerCase().replace(/[^a-z0-9-]/g, "");
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

  return (
    <div className="space-y-3">
      {typeof exposed === "boolean" && onExposedChange && (
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            {visible ? <Eye className="size-4 text-blue-500" /> : <EyeOff className="size-4 text-muted-foreground" />}
            <span className="text-sm font-medium text-foreground">
              {visible ? "Publicly exposed" : "Internal only"}
            </span>
          </div>
          <button
            onClick={() => void onExposedChange(!visible)}
            disabled={disabled}
            className={`relative rounded-full transition-colors duration-200 ${visible ? "bg-blue-500" : "bg-muted-foreground/20"}`}
            style={{ height: "22px", width: "40px" }}
          >
            <span className={`absolute top-0.5 left-0.5 w-[18px] h-[18px] rounded-full bg-white shadow-sm transition-transform duration-200 ${visible ? "translate-x-[18px]" : "translate-x-0"}`} />
          </button>
        </div>
      )}

      {visible && (
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => void onDomainTypeChange("free")}
              disabled={disabled}
              className={`px-4 py-2 rounded-xl text-sm font-medium transition-colors ${domainType === "free" ? "bg-primary/10 text-primary ring-1 ring-primary/15" : "bg-muted/40 text-muted-foreground hover:bg-muted/60"}`}
            >
              Free subdomain
            </button>
            <button
              type="button"
              onClick={() => void onDomainTypeChange("custom")}
              disabled={disabled}
              className={`px-4 py-2 rounded-xl text-sm font-medium transition-colors ${domainType === "custom" ? "bg-primary/10 text-primary ring-1 ring-primary/15" : "bg-muted/40 text-muted-foreground hover:bg-muted/60"}`}
            >
              Custom domain
            </button>
          </div>

          {domainType === "free" ? (
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <div className="flex-1 flex items-center rounded-2xl border border-border/50 bg-muted/20 overflow-hidden min-h-12">
                  <input
                    value={saveMode === "explicit" ? draftDomain : domain}
                    onChange={(event) => {
                      const next = event.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "");
                      if (saveMode === "explicit") {
                        setDraftDomain(next);
                      } else {
                        void onDomainChange(next);
                      }
                    }}
                    placeholder={projectName || "my-project"}
                    className="flex-1 px-3.5 py-3 text-sm bg-transparent outline-none text-foreground placeholder:text-muted-foreground/40"
                  />
                  <span className="text-sm text-muted-foreground pr-3.5 shrink-0">.{baseDomain}</span>
                </div>
                {saveMode === "explicit" && draftDomain !== domain && (
                  <button
                    onClick={commitFreeDomain}
                    disabled={disabled}
                    className="px-3 py-2 rounded-2xl text-[12px] font-medium bg-primary text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50"
                  >
                    Save
                  </button>
                )}
              </div>
              <p className="text-[11px] text-muted-foreground flex items-center gap-1">
                <Shield className="size-3 text-emerald-500 shrink-0" />
                SSL included. Live at <span className="font-medium text-foreground">{freePreview}</span>
              </p>
            </div>
          ) : (
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <div className="flex-1 flex items-center rounded-2xl border border-border/50 bg-muted/20 overflow-hidden min-h-12">
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
                    placeholder="app.example.com"
                    className="flex-1 px-3.5 py-3 text-sm bg-transparent outline-none text-foreground placeholder:text-muted-foreground/40"
                  />
                </div>
                {saveMode === "explicit" && draftCustomDomain !== customDomain && (
                  <button
                    onClick={commitCustomDomain}
                    disabled={disabled}
                    className="px-3 py-2 rounded-2xl text-[12px] font-medium bg-primary text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50"
                  >
                    Save
                  </button>
                )}
              </div>

              {(previewHostname || hasRecords) && (
                <div className="rounded-lg border border-border/50 bg-muted/20 overflow-hidden">
                  <div className="flex items-center gap-2 px-3 py-2">
                    <Server className="size-3 text-muted-foreground shrink-0" />
                    {loadingRecords ? (
                      <p className="text-[11px] text-muted-foreground flex-1">Fetching DNS records...</p>
                    ) : hasRecords ? (
                      <p className="text-[11px] text-muted-foreground flex-1">
                        Add a <span className="font-medium text-foreground">{dnsRecords.find((record) => record.type !== "TXT")?.type}</span> and <span className="font-medium text-foreground">TXT</span> record
                      </p>
                    ) : (
                      <p className="text-[11px] text-muted-foreground flex-1">Enter a valid domain to preview required DNS records</p>
                    )}
                    {hasRecords && (
                      <button
                        type="button"
                        onClick={() => setShowDnsModal(true)}
                        className="text-[11px] text-primary hover:text-primary/80 font-medium shrink-0 transition-colors"
                      >
                        View records
                      </button>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}

          {typeof exposedPort !== "undefined" && onExposedPortChange && (
            <div className="flex items-center gap-3">
              <div className="flex items-center gap-2">
                <Hash className="size-3.5 text-muted-foreground" />
                <span className="text-[13px] text-muted-foreground font-medium">Exposed port</span>
              </div>
              {hasPortOptions ? (
                <select
                  value={saveMode === "explicit" ? draftPort : exposedPort}
                  onChange={(event) => {
                    if (saveMode === "explicit") {
                      setDraftPort(event.target.value);
                    } else {
                      void onExposedPortChange(event.target.value);
                    }
                  }}
                  disabled={disabled}
                  className="px-3 py-2 rounded-xl text-sm bg-muted/30 border border-border/40 text-foreground outline-none"
                >
                  <option value="">Auto</option>
                  {portOptions.map((port) => (
                    <option key={port} value={port}>{port}</option>
                  ))}
                </select>
              ) : (
                <input
                  value={saveMode === "explicit" ? draftPort : exposedPort}
                  onChange={(event) => {
                    if (saveMode === "explicit") {
                      setDraftPort(event.target.value);
                    } else {
                      void onExposedPortChange(event.target.value);
                    }
                  }}
                  placeholder="3000"
                  disabled={disabled}
                  className="w-24 px-3 py-2 rounded-xl text-sm bg-muted/30 border border-border/40 text-foreground outline-none"
                />
              )}
              {saveMode === "explicit" && draftPort !== (exposedPort ?? "") && (
                <button
                  onClick={commitPort}
                  disabled={disabled}
                  className="px-3 py-2 rounded-xl text-[12px] font-medium bg-primary text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50"
                >
                  Save
                </button>
              )}
            </div>
          )}

          {liveUrl && (
            <div className="flex items-center gap-2">
              <Link2 className="size-4 text-emerald-500" />
              <a href={liveUrl} target="_blank" rel="noopener noreferrer" className="text-sm font-medium text-blue-500 dark:text-blue-400 hover:underline flex items-center gap-1.5">
                {liveUrl.replace("https://", "")}
                <ExternalLink className="size-3.5" />
              </a>
            </div>
          )}
        </div>
      )}

      {showDnsModal && hasRecords && (
        <div className="fixed inset-0 bg-background/80 backdrop-blur-sm flex items-center justify-center z-50 p-4" onClick={() => setShowDnsModal(false)}>
          <div className="max-w-xl w-full" onClick={(event) => event.stopPropagation()}>
            <div className="relative bg-card rounded-xl border border-border/50 shadow-lg overflow-hidden animate-in fade-in zoom-in-95 duration-200">
              <button onClick={() => setShowDnsModal(false)} className="absolute top-3 right-3 w-8 h-8 bg-muted/50 rounded-lg flex items-center justify-center hover:bg-muted transition-colors z-10">
                <X className="size-4 text-muted-foreground" />
              </button>

              <div className="flex items-center gap-3 px-5 py-4 border-b border-border/40">
                <div className="w-9 h-9 rounded-lg bg-primary/10 flex items-center justify-center">
                  <Server className="size-4 text-primary" />
                </div>
                <div>
                  <h3 className="text-sm font-semibold text-foreground">DNS Configuration</h3>
                  <p className="text-xs text-muted-foreground">Add these records for <span className="font-medium text-foreground">{previewHostname}</span></p>
                </div>
              </div>

              <div className="p-5 space-y-3">
                {dnsRecords.map((record, index) => (
                  <div key={`${record.type}-${index}`} className="bg-muted/30 rounded-xl border border-border/50 p-4">
                    <div className="flex items-center gap-3 mb-3">
                      <span className="px-2.5 py-1 bg-foreground text-background text-xs font-bold rounded-lg">{record.type}</span>
                      <span className="text-xs text-muted-foreground">{RECORD_LABELS[record.type] ?? ""}</span>
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider mb-1.5">Name / Host</p>
                        <div className="flex items-center gap-2 bg-background rounded-lg border border-border/50 px-3 py-2">
                          <code className="flex-1 text-sm font-medium text-foreground">{record.host}</code>
                          <button onClick={() => copy(record.host, `${index}-host`)} className="p-1 hover:bg-muted rounded-md transition-colors shrink-0">
                            {copied === `${index}-host` ? <Check className="size-3.5 text-emerald-500" /> : <Copy className="size-3.5 text-muted-foreground" />}
                          </button>
                        </div>
                      </div>
                      <div>
                        <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider mb-1.5">Value / Target</p>
                        <div className="flex items-center gap-2 bg-background rounded-lg border border-border/50 px-3 py-2">
                          <code className="flex-1 text-sm font-medium text-foreground truncate">{record.value}</code>
                          <button onClick={() => copy(record.value, `${index}-value`)} className="p-1 hover:bg-muted rounded-md transition-colors shrink-0">
                            {copied === `${index}-value` ? <Check className="size-3.5 text-emerald-500" /> : <Copy className="size-3.5 text-muted-foreground" />}
                          </button>
                        </div>
                      </div>
                    </div>
                  </div>
                ))}

                <div className="flex items-start gap-2 p-3 bg-primary/5 rounded-xl border border-primary/10">
                  <Info className="size-3.5 text-primary shrink-0 mt-0.5" />
                  <p className="text-xs text-muted-foreground leading-relaxed">
                    {dnsMode === "selfhosted" ? (
                      <>Add the <span className="font-medium text-foreground">A record</span> pointing to your server IP, then the <span className="font-medium text-foreground">TXT record</span> for verification.</>
                    ) : (
                      <>Add the <span className="font-medium text-foreground">CNAME record</span> for routing, then the <span className="font-medium text-foreground">TXT record</span> for verification.</>
                    )} DNS changes can take up to 48 hours.
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