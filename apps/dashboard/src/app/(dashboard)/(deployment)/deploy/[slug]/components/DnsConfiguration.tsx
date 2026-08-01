"use client";

import React from "react";
import { useI18n } from "@/components/i18n-provider";
import DnsRecordCard from "@/components/domains/DnsRecordCard";

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
}

const DnsConfiguration: React.FC<DnsConfigurationProps> = ({
  domain,
  records,
  mode,
  showHeader = true,
}) => {
  const { t } = useI18n();
  const d = t.deploy.dns;

  const displayRecords = records ?? [];
  if (!displayRecords.length) return null;

  return (
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
};

export default DnsConfiguration;
