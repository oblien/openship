"use client";

import React, { useState } from "react";
import { Copy, Check } from "lucide-react";
import { useI18n } from "@/components/i18n-provider";

interface DnsRecord {
  type: "CNAME" | "A" | "TXT";
  host: string;
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
  const recordDescriptions: Record<string, string> = {
    CNAME: d.descCname,
    A: d.descA,
    TXT: d.descTxt,
  };
  const [copied, setCopied] = useState<string | null>(null);

  const copyToClipboard = (text: string, id: string) => {
    if (!text) return;
    navigator.clipboard.writeText(text);
    setCopied(id);
    setTimeout(() => setCopied(null), 2000);
  };

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
          <div key={i} className="rounded-lg bg-background p-3.5">
            <div className="mb-2.5 flex items-center gap-2.5">
              <span className="rounded-md bg-foreground px-2 py-0.5 text-[11px] font-bold text-background">
                {record.type}
              </span>
              <span className="text-xs text-muted-foreground">
                {recordDescriptions[record.type] ?? ""}
              </span>
            </div>
            <div className="grid grid-cols-2 gap-2.5">
              <Field
                label={d.nameHost}
                value={record.host}
                copied={copied === `${i}-host`}
                onCopy={() => copyToClipboard(record.host, `${i}-host`)}
              />
              <Field
                label={d.valueTarget}
                value={record.value}
                copied={copied === `${i}-value`}
                onCopy={() => copyToClipboard(record.value, `${i}-value`)}
              />
            </div>
          </div>
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

function Field({
  label,
  value,
  copied,
  onCopy,
}: {
  label: string;
  value: string;
  copied: boolean;
  onCopy: () => void;
}) {
  return (
    <div className="min-w-0">
      <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        {label}
      </p>
      <div className="flex items-center gap-2 rounded-lg bg-muted/50 px-3 py-2">
        <code className="flex-1 truncate text-sm font-medium text-foreground">
          {value || "—"}
        </code>
        <button
          type="button"
          onClick={onCopy}
          disabled={!value}
          className="shrink-0 rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted disabled:opacity-40"
        >
          {copied ? <Check className="size-3.5 text-success" /> : <Copy className="size-3.5" />}
        </button>
      </div>
    </div>
  );
}

export default DnsConfiguration;
