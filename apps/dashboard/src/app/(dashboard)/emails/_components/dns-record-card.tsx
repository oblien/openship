"use client";

import { Icon as UiIcon } from "@repo/ui/icons";

import { useState } from "react";
import { useI18n, interpolate } from "@/components/i18n-provider";

interface DnsRecord {
  type: string;
  name: string;
  value: string;
  priority?: number;
}

export function DnsRecordCard({ label, record }: { label: string; record: DnsRecord }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);

  const copyValue = () => {
    navigator.clipboard.writeText(record.value);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="rounded-xl border border-border/50 bg-card p-4">
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground/60">
          {label}
        </span>
        <span className="text-xs font-mono px-2 py-0.5 rounded-md bg-muted text-muted-foreground">
          {record.type}
        </span>
      </div>
      <p className="text-sm font-medium text-foreground mb-1">{record.name}</p>
      {record.priority !== undefined && (
        <p className="text-xs text-muted-foreground mb-1">
          {interpolate(t.emails.recordCard.priority, { priority: String(record.priority) })}
        </p>
      )}
      <div className="flex items-start gap-2 mt-2">
        <code className="flex-1 text-xs text-muted-foreground bg-muted/50 rounded-lg p-2 break-all leading-relaxed">
          {record.value}
        </code>
        <button
          onClick={copyValue}
          className="shrink-0 p-1.5 rounded-lg hover:bg-muted transition-colors"
          title={t.emails.recordCard.copyValue}
        >
          {copied ? (
            <UiIcon name="check" className="size-3.5 text-success" />
          ) : (
            <UiIcon name="copy" className="size-3.5 text-muted-foreground" />
          )}
        </button>
      </div>
    </div>
  );
}
