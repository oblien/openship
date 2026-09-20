"use client";

import React from "react";
import { useI18n } from "@/components/i18n-provider";
import DnsRecordCard from "@/components/domains/DnsRecordCard";
import { AutoDnsPanel } from "@/components/shared/AutoDnsPanel";
import { domainsApi } from "@/lib/api";

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
  /** A persisted domain's id. When set, the on-demand auto-configure panel is
   *  shown above the manual records — pre-add previews (no id) stay manual. */
  domainId?: string;
  /** Explicit pre-deploy server; it wins over any previous project deployment. */
  serverId?: string;
}

const DnsConfiguration: React.FC<DnsConfigurationProps> = ({
  domain,
  records,
  mode,
  showHeader = true,
  domainId,
  serverId,
}) => {
  const { t } = useI18n();
  const d = t.deploy.dns;

  const displayRecords = records ?? [];
  if (!displayRecords.length && !domainId) return null;

  const manual = displayRecords.length > 0 && (
    <div className="rounded-xl bg-muted/30">
      {showHeader && (
        <div className="px-4 pt-4">
          <p className="text-xs text-muted-foreground">
            {d.addRecordsFor} <span className="font-medium text-foreground">{domain}</span>
          </p>
        </div>
      )}

      <div className="space-y-2.5 p-4">
        {displayRecords.map((record, i) => (
          <DnsRecordCard key={`${record.type}-${record.host}-${i}`} record={record} />
        ))}

        <p className="px-0.5 text-xs leading-relaxed text-muted-foreground">
          {mode === "selfhosted" ? (
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
    </div>
  );

  return (
    <div className="space-y-3">
      {domainId && (
        <AutoDnsPanel
          plan={() => domainsApi.dnsPlan(domainId, serverId).then((r) => r.data)}
          apply={() => domainsApi.dnsApply(domainId, serverId).then((r) => r.data)}
          reloadKey={`${domainId}:${serverId ?? "project"}`}
        />
      )}
      {manual}
    </div>
  );
};

export default DnsConfiguration;
