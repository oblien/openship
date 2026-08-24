"use client";

import { useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Copy,
  Loader2,
} from "lucide-react";
import { interpolate, useI18n } from "@/components/i18n-provider";
import type {
  DomainDnsCheckStatus,
  DomainDnsCheckedRecord,
  DomainDnsRecord,
} from "@/lib/api/domains";

export type DnsTableRecord = DomainDnsRecord & {
  status?: DomainDnsCheckStatus;
  observed?: string[];
};

const COLS = "grid-cols-[1.25rem_4.5rem_minmax(0,1fr)_minmax(0,1fr)]";

function assertNever(value: never): never {
  throw new Error(`Unhandled DNS status: ${String(value)}`);
}

function StatusDot({ status }: { status?: DomainDnsCheckStatus }) {
  if (!status) return <span className="size-1.5 shrink-0 rounded-full bg-muted-foreground/25" />;
  switch (status) {
    case "ok":
      return <span className="size-1.5 shrink-0 rounded-full bg-success" />;
    case "missing":
      return <span className="size-1.5 shrink-0 rounded-full bg-warning" />;
    case "mismatch":
      return <span className="size-1.5 shrink-0 rounded-full bg-danger" />;
    default:
      return assertNever(status);
  }
}

function CopyValue({
  value,
  label,
  onCopy,
}: {
  value: string;
  label: string;
  onCopy: (text: string) => void | Promise<void>;
}) {
  const { t } = useI18n();
  const s = t.projectSettings.domains.setup;
  const [copied, setCopied] = useState(false);
  if (!value) {
    return <span className="text-[12px] text-muted-foreground">{s.emptyValue}</span>;
  }
  return (
    <button
      type="button"
      title={label}
      onClick={async () => {
        await onCopy(value);
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1200);
      }}
      className="group flex min-w-0 max-w-full items-center gap-1.5 text-start"
    >
      <code className="min-w-0 truncate font-mono text-[12px] leading-5 text-foreground">{value}</code>
      <span className="inline-flex size-4 shrink-0 items-center justify-center text-muted-foreground group-hover:text-foreground">
        {copied ? <CheckCircle2 className="size-3 text-success" /> : <Copy className="size-3" />}
      </span>
    </button>
  );
}

export function DnsRecordsTable({
  records,
  checking = false,
  onCheck,
  onCopy,
  showCloudflareWarning = true,
  hideIntro = false,
}: {
  records: DnsTableRecord[];
  checking?: boolean;
  onCheck?: () => void;
  onCopy: (text: string) => void | Promise<void>;
  showCloudflareWarning?: boolean;
  hideIntro?: boolean;
}) {
  const { t } = useI18n();
  const s = t.projectSettings.domains.setup;
  const table = s.table;
  const missingValue = records.some((record) => !record.value);

  return (
    <div className="space-y-2">
      {hideIntro ? null : (
        <p className="text-[12px] leading-relaxed text-muted-foreground">{s.dnsIntro}</p>
      )}

      {showCloudflareWarning ? (
        <p className="flex items-start gap-1.5 text-[12px] text-warning">
          <AlertTriangle className="mt-0.5 size-3 shrink-0" />
          <span>{s.cloudflareWarning}</span>
        </p>
      ) : null}

      {missingValue ? (
        <p className="text-[12px] text-muted-foreground">{s.emptyValueHint}</p>
      ) : null}

      <div className="overflow-hidden rounded-lg border border-border/50">
        <div className={`grid ${COLS} items-center border-b border-border/40 bg-muted/30 text-[11px] font-medium text-muted-foreground`}>
          <div />
          <div className="py-2 pe-3 text-start">{table.type}</div>
          <div className="px-3 py-2 text-start">{table.name}</div>
          <div className="px-3 py-2 text-start">{table.value}</div>
        </div>
        {records.map((record, index) => (
          <div
            key={`${record.type}-${record.host}-${index}`}
            className={`grid ${COLS} items-center border-b border-border/30 last:border-0`}
          >
            <div className="flex items-center justify-center py-2.5">
              <StatusDot status={record.status} />
            </div>
            <div className="py-2.5 pe-3">
              <span className="font-mono text-[12px] font-medium text-foreground">{record.type}</span>
            </div>
            <div className="min-w-0 px-3 py-2.5">
              <CopyValue value={record.host} label={s.copyName} onCopy={onCopy} />
            </div>
            <div className="min-w-0 px-3 py-2.5">
              <CopyValue value={record.value} label={s.copyValue} onCopy={onCopy} />
              {record.status === "mismatch" && record.observed && record.observed.length > 0 ? (
                <p className="mt-0.5 truncate text-[10px] text-danger/80">
                  {interpolate(s.observed, { value: record.observed.join(", ") })}
                </p>
              ) : null}
            </div>
          </div>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {onCheck ? (
          <button
            type="button"
            onClick={onCheck}
            disabled={checking || records.length === 0}
            className="inline-flex min-h-8 items-center gap-1.5 rounded-lg border border-border px-3 text-[13px] font-medium text-foreground hover:bg-foreground/[0.06] disabled:opacity-50"
          >
            {checking ? <Loader2 className="size-3.5 animate-spin" /> : null}
            {checking ? s.checkingDns : s.checkDns}
          </button>
        ) : null}
        <p className="text-[12px] text-muted-foreground">{s.propagation}</p>
      </div>
    </div>
  );
}

export function mergeCheckedRecords(
  records: DnsTableRecord[],
  checked: DomainDnsCheckedRecord[],
): DnsTableRecord[] {
  return records.map((record, index) => {
    const match =
      checked.find(
        (row) => row.type === record.type && row.name === record.name && row.host === record.host,
      ) ?? checked[index];
    if (!match) return record;
    return { ...record, status: match.status, observed: match.observed };
  });
}
