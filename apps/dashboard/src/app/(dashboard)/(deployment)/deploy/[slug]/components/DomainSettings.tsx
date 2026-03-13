import React, { useState } from "react";
import { Globe, Info, X, Shield } from "lucide-react";
import DnsConfiguration from "./DnsConfiguration";

interface DomainSettingsProps {
  projectName: string;
  domain: string;
  setDomain: (domain: string) => void;
  customDomain: string;
  setCustomDomain: (domain: string) => void;
  domainType: "free" | "custom";
  setDomainType: (type: "free" | "custom") => void;
}

const DomainSettings: React.FC<DomainSettingsProps> = ({
  projectName,
  domain,
  setDomain,
  customDomain,
  setCustomDomain,
  domainType,
  setDomainType,
}) => {
  const [showDnsModal, setShowDnsModal] = useState(false);

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
              onChange={(e) => setDomain(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))}
              placeholder={projectName || "my-project"}
              className="flex-1 px-3 py-2 bg-transparent text-sm text-foreground placeholder:text-muted-foreground/50 focus:outline-none"
            />
            <div className="px-3 py-2 bg-muted/60 border-l border-border">
              <span className="text-sm font-semibold text-foreground">.opsh.io</span>
            </div>
          </div>
          <p className="text-[11px] text-muted-foreground mt-1.5 flex items-center gap-1">
            <Shield className="size-3 text-emerald-500 shrink-0" />
            SSL included &mdash; live at <span className="font-medium text-foreground ml-0.5">{domain || projectName || "my-project"}.opsh.io</span>
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
          {customDomain && (
            <button
              onClick={() => setShowDnsModal(true)}
              className="flex items-center gap-1.5 text-xs text-primary hover:text-primary/80 transition-colors"
            >
              <Info className="size-3" />
              View DNS Configuration
            </button>
          )}
        </div>
      )}

      {showDnsModal && (
        <div className="fixed inset-0 bg-background/80 backdrop-blur-sm flex items-center justify-center z-50 p-4" onClick={() => setShowDnsModal(false)}>
          <div className="max-w-2xl w-full" onClick={(e) => e.stopPropagation()}>
            <div className="relative">
              <button
                onClick={() => setShowDnsModal(false)}
                className="absolute -top-3 -right-3 w-10 h-10 bg-card rounded-full shadow-lg border border-border/50 flex items-center justify-center hover:bg-muted transition-colors z-10"
              >
                <X className="w-5 h-5 text-muted-foreground" />
              </button>
              <DnsConfiguration domain={customDomain} />
            </div>
          </div>
        </div>
      )}
      </div>
    </div>
  );
};

export default DomainSettings;
