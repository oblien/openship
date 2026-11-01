"use client";

import React from "react";
import { useI18n } from "@/components/i18n-provider";
import DnsRecordCard from "@/components/domains/DnsRecordCard";
import { AutoDnsPanel } from "@/components/shared/AutoDnsPanel";
import { domainsApi } from "@/lib/api";
import { dnsApi } from "@/lib/api/dns";

interface DnsRecord {
  type: "CNAME" | "A" | "TXT";
  host: string;
  /** FQDN fallback for providers that reject the zone-relative host. */
  name?: string;
  value: string;
}

interface DnsConfigurationProps {
  domain: string;
  records?: DnsRecord[];
  mode?: "cloud" | "selfhosted";
  /** Hide the internal header when the container already titles the section. */
  showHeader?: boolean;
  /** A persisted domain's id. Pre-add previews can connect a provider, but
   * record writes remain scoped to persisted domains. */
  domainId?: string;
  /** Explicit pre-deploy server; it wins over any previous project deployment. */
  serverId?: string;
  connectionRevision?: number;
  onConnected?: () => void;
  onApplyingChange?: (hostname: string, applying: boolean) => void;
}

const DnsConfiguration: React.FC<DnsConfigurationProps> = ({
  domain,
  records,
  mode,
  showHeader = true,
  domainId,
  serverId,
  connectionRevision = 0,
  onConnected,
  onApplyingChange,
}) => {
  const { t } = useI18n();
  const d = t.deploy.dns;

  const displayRecords = records ?? [];
  if (!displayRecords.length && !domainId) return null;

  const manual = displayRecords.length > 0 && (
    <details className="rounded-xl bg-muted/30" open={!domainId}>
      <summary className="cursor-pointer rounded-xl px-4 py-3 text-sm font-medium text-foreground focus-visible:outline-primary">
        {t.autoDns.manualSetup}
      </summary>

      <div className="space-y-2.5 p-4">
        {displayRecords.map((record, i) => (
          <DnsRecordCard key={`${record.type}-${record.host}-${i}`} record={record} />
        ))}

        <p className="px-0.5 text-xs leading-relaxed text-muted-foreground">
          {mode === "selfhosted" && domain.startsWith("*.") ? (
            t.projectSettings.domains.wildcard.notice
          ) : mode === "selfhosted" ? (
            <>
              {d.selfInfoPre}
              <span className="font-medium text-foreground">{d.recordA}</span>
              {d.selfInfoMid}
            </>
          ) : (
            <>
              {d.cloudInfoPre}
              <span className="font-medium text-foreground">{d.recordCname}</span>
              {d.cloudInfoMid}
              <span className="font-medium text-foreground">{d.recordTxt}</span>
              {d.verifySuffix}
            </>
          )}
        </p>
      </div>
    </details>
  );

  return (
    <div className="space-y-3">
      {showHeader && <h3 className="break-all text-sm font-medium text-foreground">{domain}</h3>}
      <AutoDnsPanel
        plan={
          domainId
            ? () => domainsApi.dnsPlan(domainId, serverId).then((r) => r.data)
            : () =>
                dnsApi.verifyZone(domain).then((result) => ({
                  status: result.status,
                  provider: result.provider,
                  zoneName: result.zoneName,
                  reason: result.message,
                  records: [],
                }))
        }
        apply={
          domainId ? () => domainsApi.dnsApply(domainId, serverId).then((r) => r.data) : undefined
        }
        reloadKey={`${domainId ?? domain}:${serverId ?? "project"}`}
        refreshKey={connectionRevision}
        hostname={domain}
        onConnected={onConnected}
        onApplyingChange={onApplyingChange}
      />
      {manual}
    </div>
  );
};

export default DnsConfiguration;
