import React from "react";
import { Globe } from "lucide-react";
import { RoutingSettingsCard } from "@/components/routing/RoutingSettingsCard";

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
  const resolvedUrl = domainType === "custom" && customDomain
    ? `https://${customDomain}`
    : null;

  return (
    <div className="bg-card rounded-xl border border-border/50 overflow-hidden">
      <div className="flex items-center gap-2.5 px-4 py-3 border-b border-border/40">
        <div className="w-7 h-7 rounded-lg bg-primary/10 flex items-center justify-center">
          <Globe className="size-3.5 text-primary" />
        </div>
        <div>
          <h3 className="text-sm font-semibold text-foreground leading-tight">Domain</h3>
          <p className="text-[11px] text-muted-foreground">Where your site will be accessible</p>
        </div>
      </div>

      <div className="p-4">
        <RoutingSettingsCard
          projectName={projectName}
          domain={domain}
          customDomain={customDomain}
          domainType={domainType}
          liveUrl={resolvedUrl}
          onDomainChange={setDomain}
          onCustomDomainChange={setCustomDomain}
          onDomainTypeChange={setDomainType}
          saveMode="change"
        />
      </div>
    </div>
  );
};

export default DomainSettings;
