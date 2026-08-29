"use client";

import React, { useState } from "react";
import { Check, Copy } from "lucide-react";
import { useI18n, interpolate } from "@/components/i18n-provider";

export interface DnsRecordCardRecord {
  type: "CNAME" | "A" | "TXT";
  /** Zone-relative label (`@`, `app`) — what most provider forms want. */
  host: string;
  /** Fully-qualified record name — the always-correct fallback. */
  name?: string;
  value: string;
}

/**
 * One DNS record, laid out as the form the user is about to fill in at their
 * provider: Type / Name / Value / TTL, each labelled and separately copyable.
 *
 * The previous rendering was three unlabelled lines (type, host, value), which
 * told the user nothing about WHICH provider field each string belongs in — the
 * relative host and the FQDN in particular read as redundant duplicates rather
 * than "paste this, or that one if your provider insists on the full name".
 * Every record also gets a plain-language purpose line naming its hostname, so
 * two identical-looking A rows (apex + www) are distinguishable at a glance.
 */
export default function DnsRecordCard({
  record,
  onCopy,
}: {
  record: DnsRecordCardRecord;
  /** Host-level copy (toast). Clipboard is written here when omitted. */
  onCopy?: (text: string) => void | Promise<void>;
}) {
  const { t } = useI18n();
  const d = t.deploy.dns;
  const r = d.record;
  const [copied, setCopied] = useState<string | null>(null);

  const copy = (text: string, field: string) => {
    if (!text) return;
    if (onCopy) void onCopy(text);
    else void navigator.clipboard?.writeText(text);
    setCopied(field);
    setTimeout(() => setCopied((c) => (c === field ? null : c)), 1600);
  };

  const hostname = record.name || record.host;
  const isApex = record.host === "@";
  /** The FQDN fallback, only when it actually says something the host doesn't. */
  const fqdn = record.name && record.name !== record.host ? record.name : null;
  // A www→apex alias (`www.example.com` CNAME → `example.com`) vs a CNAME that
  // points at the edge: only the alias' target is a suffix of its own name.
  const isAliasCname =
    record.type === "CNAME" && !!record.value && hostname.endsWith(`.${record.value}`);

  // A challenge TXT lives at `_openship-challenge.<domain>`, so its purpose line
  // must name the DOMAIN being verified — "you own _openship-challenge.x.com"
  // reads as nonsense.
  const verifiedHostname = hostname.replace(/^_[^.]+\./, "");

  const purpose =
    record.type === "A"
      ? interpolate(r.purposeA, { hostname })
      : record.type === "TXT"
        ? interpolate(r.purposeTxt, { hostname: verifiedHostname })
        : isAliasCname
          ? interpolate(r.purposeCnameAlias, { hostname, target: record.value })
          : interpolate(r.purposeCname, { hostname });

  return (
    <div className="overflow-hidden rounded-xl border border-border/50 bg-muted/20">
      <div className="flex items-start gap-2.5 px-4 pt-3.5">
        <span className="mt-px shrink-0 rounded-md bg-foreground px-2 py-0.5 text-xs font-bold tracking-wide text-background">
          {record.type}
        </span>
        <p className="text-sm leading-relaxed text-muted-foreground">{purpose}</p>
      </div>

      <div className="space-y-1 px-4 py-3">
        <FieldRow label={r.fieldType} value={record.type} />
        <FieldRow
          label={r.fieldName}
          value={record.host}
          copied={copied === "host"}
          onCopy={() => copy(record.host, "host")}
          secondary={
            isApex ? (
              <span className="text-xs text-muted-foreground/70">{r.apexHint}</span>
            ) : fqdn ? (
              <span className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground/70">
                {r.fullName}
                <button
                  type="button"
                  onClick={() => copy(fqdn, "fqdn")}
                  className="inline-flex items-center gap-1 rounded px-1 py-0.5 font-mono text-muted-foreground transition-colors hover:bg-foreground/[0.06] hover:text-foreground"
                  title={r.copy}
                >
                  {fqdn}
                  {copied === "fqdn" ? (
                    <Check className="size-3 text-success" />
                  ) : (
                    <Copy className="size-3" />
                  )}
                </button>
              </span>
            ) : null
          }
        />
        <FieldRow
          label={r.fieldValue}
          value={record.value}
          placeholder={record.type === "A" ? d.serverIpPlaceholder : undefined}
          wrap={record.type === "TXT"}
          copied={copied === "value"}
          onCopy={() => copy(record.value, "value")}
        />
        <FieldRow label={r.fieldTtl} value={r.ttlValue} muted />
      </div>

      {record.type === "A" ? (
        <p className="border-t border-border/40 px-4 py-2.5 text-xs leading-relaxed text-muted-foreground/80">
          {r.proxyNote}
        </p>
      ) : null}
    </div>
  );
}

function FieldRow({
  label,
  value,
  placeholder,
  secondary,
  copied,
  onCopy,
  wrap,
  muted,
}: {
  label: string;
  value: string;
  placeholder?: string;
  secondary?: React.ReactNode;
  copied?: boolean;
  onCopy?: () => void;
  /** Long values (TXT tokens) wrap instead of truncating. */
  wrap?: boolean;
  /** Informational value (TTL) — no box emphasis. */
  muted?: boolean;
}) {
  const { t } = useI18n();
  return (
    <div className="grid grid-cols-[64px_minmax(0,1fr)] items-start gap-2">
      <span className="pt-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground/70">
        {label}
      </span>
      <div className="min-w-0">
        <div
          className={`flex items-start gap-2 rounded-lg px-2.5 py-1.5 ${
            muted ? "" : "bg-background/70"
          }`}
        >
          <code
            className={`min-w-0 flex-1 text-sm ${
              muted ? "text-muted-foreground" : "font-medium text-foreground"
            } ${wrap ? "break-all" : "truncate"}`}
          >
            {value || (
              <span className="font-normal text-muted-foreground/60">{placeholder ?? "—"}</span>
            )}
          </code>
          {onCopy && value ? (
            <button
              type="button"
              onClick={onCopy}
              className="-me-1 shrink-0 rounded-md p-1 text-muted-foreground transition-colors hover:bg-foreground/[0.06] hover:text-foreground"
              title={t.deploy.dns.record.copy}
            >
              {copied ? <Check className="size-3.5 text-success" /> : <Copy className="size-3.5" />}
            </button>
          ) : null}
        </div>
        {secondary ? <div className="mt-1 px-2.5">{secondary}</div> : null}
      </div>
    </div>
  );
}
