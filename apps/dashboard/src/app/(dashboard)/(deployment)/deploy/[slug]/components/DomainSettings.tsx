import React, { useState, useEffect, useCallback } from "react";
import { Globe, Shield, Server, X, Copy, Check, ChevronDown, Info } from "lucide-react";
import { domainsApi } from "@/lib/api";

interface DnsRecord {
  type: "CNAME" | "A" | "TXT";
  host: string;
  value: string;
}

interface DomainSettingsProps {
  projectName: string;
  domain: string;
  setDomain: (domain: string) => void;
  customDomain: string;
  setCustomDomain: (domain: string) => void;
  domainType: "free" | "custom";
  setDomainType: (type: "free" | "custom") => void;
  hostDomain?: string;
}

const RECORD_LABELS: Record<string, string> = {
  CNAME: "Routes traffic through the edge network",
  A: "Points to your server IP",
  TXT: "Verifies domain ownership",
};

const DomainSettings: React.FC<DomainSettingsProps> = ({
  projectName,
  domain,
  setDomain,
  customDomain,
  setCustomDomain,
  domainType,
  setDomainType,
  hostDomain,
}) => {
  const baseDomain = hostDomain || "opsh.io";
  const [showDnsModal, setShowDnsModal] = useState(false);
  const [dnsRecords, setDnsRecords] = useState<DnsRecord[]>([]);
  const [dnsMode, setDnsMode] = useState<"cloud" | "selfhosted">("cloud");
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);

  const copy = (text: string, id: string) => {
    navigator.clipboard.writeText(text);
    setCopied(id);
    setTimeout(() => setCopied(null), 2000);
  };

  // Fetch preview records when custom domain changes (debounced)
  const fetchRecords = useCallback(async (hostname: string) => {
    if (!hostname || hostname.length < 3 || !hostname.includes(".")) return;
    setLoading(true);
    try {
      const res = await domainsApi.previewRecords(hostname);
      setDnsRecords(res.data.records);
      setDnsMode(res.data.mode);
    } catch {
      // Silently fail — user can still deploy
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (domainType !== "custom" || !customDomain) {
      setDnsRecords([]);
      return;
    }
    const timer = setTimeout(() => fetchRecords(customDomain), 400);
    return () => clearTimeout(timer);
  }, [customDomain, domainType, fetchRecords]);

  const hasRecords = dnsRecords.length > 0 && dnsRecords.every((r) => r.value);
  const routeRecord = dnsRecords.find((r) => r.type !== "TXT");

  return (
    <div className="bg-card rounded-xl border border-border/50 overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-2.5 px-4 py-3 border-b border-border/40">
        <div className="w-7 h-7 rounded-lg bg-primary/10 flex items-center justify-center">
          <Globe className="size-3.5 text-primary" />
        </div>
        <div>
          <h3 className="text-sm font-semibold text-foreground leading-tight">Domain</h3>
          <p className="text-[11px] text-muted-foreground">Where your site will be accessible</p>
        </div>
      </div>

      <div className="p-4 space-y-3">
        {/* Toggle */}
        <div className="flex items-center bg-border/50 rounded-lg p-0.5">
          <button
            type="button"
            onClick={() => setDomainType("free")}
            className={`flex-1 px-3 py-1.5 text-xs font-medium rounded-md transition-all ${
              domainType === "free"
                ? "bg-card text-foreground shadow-sm border border-border/50"
                : "text-muted-foreground hover:text-foreground border border-transparent"
            }`}
          >
            Free Subdomain
          </button>
          <button
            type="button"
            onClick={() => setDomainType("custom")}
            className={`flex-1 px-3 py-1.5 text-xs font-medium rounded-md transition-all ${
              domainType === "custom"
                ? "bg-card text-foreground shadow-sm border border-border/50"
                : "text-muted-foreground hover:text-foreground border border-transparent"
            }`}
          >
            Custom Domain
          </button>
        </div>

        {/* Input */}
        {domainType === "free" ? (
          <div>
            <div className="flex items-center bg-muted/30 border border-border rounded-lg overflow-hidden focus-within:ring-2 focus-within:ring-primary/20 transition-all">
              <input
                type="text"
                value={domain}
                onChange={(e) => setDomain(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ""))}
                placeholder={projectName || "my-project"}
                className="flex-1 px-3 py-2 bg-transparent text-sm text-foreground placeholder:text-muted-foreground/50 focus:outline-none"
              />
              <div className="px-3 py-2 bg-muted/60 border-l border-border">
                <span className="text-sm font-semibold text-foreground">.{baseDomain}</span>
              </div>
            </div>
            <p className="text-[11px] text-muted-foreground mt-1.5 flex items-center gap-1">
              <Shield className="size-3 text-emerald-500 shrink-0" />
              SSL included &mdash; live at{" "}
              <span className="font-medium text-foreground ml-0.5">
                {domain || projectName || "my-project"}.{baseDomain}
              </span>
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            <input
              type="text"
              value={customDomain}
              onChange={(e) => setCustomDomain(e.target.value.toLowerCase())}
              placeholder="example.com"
              className="w-full px-3 py-2 bg-muted/30 border border-border rounded-lg text-sm text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-2 focus:ring-primary/20 transition-all"
            />

            {/* Inline DNS hint */}
            {customDomain && (
              <div className="rounded-lg border border-border/50 bg-muted/20 overflow-hidden">
                <div className="flex items-center gap-2 px-3 py-2">
                  <Server className="size-3 text-muted-foreground shrink-0" />
                  {loading ? (
                    <p className="text-[11px] text-muted-foreground flex-1">Fetching DNS records...</p>
                  ) : hasRecords ? (
                    <p className="text-[11px] text-muted-foreground flex-1">
                      Add a <span className="font-medium text-foreground">{routeRecord?.type}</span> and{" "}
                      <span className="font-medium text-foreground">TXT</span> record at your DNS provider
                    </p>
                  ) : (
                    <p className="text-[11px] text-muted-foreground flex-1">
                      Enter a valid domain to see required DNS records
                    </p>
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
      </div>

      {/* DNS Modal */}
      {showDnsModal && hasRecords && (
        <div
          className="fixed inset-0 bg-background/80 backdrop-blur-sm flex items-center justify-center z-50 p-4"
          onClick={() => setShowDnsModal(false)}
        >
          <div className="max-w-xl w-full" onClick={(e) => e.stopPropagation()}>
            <div className="relative bg-card rounded-xl border border-border/50 shadow-lg overflow-hidden animate-in fade-in zoom-in-95 duration-200">
              <button
                onClick={() => setShowDnsModal(false)}
                className="absolute top-3 right-3 w-8 h-8 bg-muted/50 rounded-lg flex items-center justify-center hover:bg-muted transition-colors z-10"
              >
                <X className="size-4 text-muted-foreground" />
              </button>

              {/* Header */}
              <div className="flex items-center gap-3 px-5 py-4 border-b border-border/40">
                <div className="w-9 h-9 rounded-lg bg-primary/10 flex items-center justify-center">
                  <Server className="size-4 text-primary" />
                </div>
                <div>
                  <h3 className="text-sm font-semibold text-foreground">DNS Configuration</h3>
                  <p className="text-xs text-muted-foreground">
                    Add these records for{" "}
                    <span className="font-medium text-foreground">{customDomain}</span>
                  </p>
                </div>
              </div>

              {/* Records */}
              <div className="p-5 space-y-3">
                {dnsRecords.map((record, i) => (
                  <div key={i} className="bg-muted/30 rounded-xl border border-border/50 p-4">
                    <div className="flex items-center gap-3 mb-3">
                      <span className="px-2.5 py-1 bg-foreground text-background text-xs font-bold rounded-lg">
                        {record.type}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {RECORD_LABELS[record.type] ?? ""}
                      </span>
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider mb-1.5">
                          Name / Host
                        </p>
                        <div className="flex items-center gap-2 bg-background rounded-lg border border-border/50 px-3 py-2">
                          <code className="flex-1 text-sm font-medium text-foreground">{record.host}</code>
                          <button
                            onClick={() => copy(record.host, `${i}-h`)}
                            className="p-1 hover:bg-muted rounded-md transition-colors shrink-0"
                          >
                            {copied === `${i}-h` ? (
                              <Check className="size-3.5 text-emerald-500" />
                            ) : (
                              <Copy className="size-3.5 text-muted-foreground" />
                            )}
                          </button>
                        </div>
                      </div>
                      <div>
                        <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider mb-1.5">
                          Value / Target
                        </p>
                        <div className="flex items-center gap-2 bg-background rounded-lg border border-border/50 px-3 py-2">
                          <code className="flex-1 text-sm font-medium text-foreground truncate">
                            {record.value}
                          </code>
                          <button
                            onClick={() => copy(record.value, `${i}-v`)}
                            className="p-1 hover:bg-muted rounded-md transition-colors shrink-0"
                          >
                            {copied === `${i}-v` ? (
                              <Check className="size-3.5 text-emerald-500" />
                            ) : (
                              <Copy className="size-3.5 text-muted-foreground" />
                            )}
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
                      <>
                        Add the <span className="font-medium text-foreground">A record</span> pointing to your server IP,
                        then the <span className="font-medium text-foreground">TXT record</span> for verification.
                      </>
                    ) : (
                      <>
                        Add the <span className="font-medium text-foreground">CNAME record</span> for routing,
                        then the <span className="font-medium text-foreground">TXT record</span> for verification.
                      </>
                    )}{" "}
                    DNS changes can take up to 48 hours.
                  </p>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default DomainSettings;
