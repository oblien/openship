"use client";

/**
 * Shared DNS-records grid. Renders the 4 required records (MX/SPF/DKIM/
 * DMARC) plus optional A/AAAA host records.
 *
 * Used in two places:
 *   - The DKIM hold banner (`/emails` page) while the install is paused.
 *   - The Mail tab's ProvisionedView (server detail page) as a permanent
 *     reference card - so the user can re-copy a record they botched at
 *     publication time without SSHing to the VPS to read the state file.
 *
 * Same component, same UX in both places (Type chip, short-form Name,
 * copy buttons).
 */

import { useState } from "react";
import { Copy, Check } from "lucide-react";
import { useI18n, interpolate } from "@/components/i18n-provider";
import type { DnsRecord, DnsRecords } from "@/lib/api";

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Convert an FQDN into the form DNS-provider UIs accept:
 *   - Root domain (`oblien.com` when domain=oblien.com) → `@`
 *   - Subdomain (`dkim._domainkey.oblien.com`)           → `dkim._domainkey`
 *   - Anything else                                      → as-is
 */
export function displayDnsName(fullName: string, domain: string): string {
  if (fullName === domain) return "@";
  if (fullName.endsWith(`.${domain}`)) {
    return fullName.slice(0, fullName.length - domain.length - 1);
  }
  return fullName;
}

/**
 * Iteration order: host records first, mail-delivery records next, then any
 * `extraRecords` (e.g. the SES send-hop DKIM CNAMEs + MAIL FROM added by the
 * outbound relay) last.
 */
export function recordsToList(records: DnsRecords): DnsRecord[] {
  return [
    records.a,
    records.aaaa,
    records.mx,
    records.spf,
    records.dkim,
    records.dmarc,
    ...(records.extraRecords ?? []),
  ].filter((r): r is DnsRecord => r !== undefined);
}

// ─── Components ──────────────────────────────────────────────────────────────

interface DnsRecordsViewProps {
  records: DnsRecords;
  domain: string;
  /** Grid columns at lg+. Default 2; pass 1 for a tighter sidebar layout. */
  columns?: 1 | 2;
}

/**
 * Self-contained grid of record cards. Drop into any container; takes
 * care of iteration and per-card UI.
 */
export function DnsRecordsView({
  records,
  domain,
  columns = 2,
}: DnsRecordsViewProps) {
  const rows = recordsToList(records);
  const colsClass = columns === 1 ? "grid-cols-1" : "grid-cols-1 lg:grid-cols-2";
  return (
    <div className={`grid ${colsClass} gap-3`}>
      {rows.map((rec, i) => (
        <DnsRecordCard key={i} rec={rec} domain={domain} />
      ))}
    </div>
  );
}

export function DnsRecordCard({
  rec,
  domain,
}: {
  rec: DnsRecord;
  domain: string;
}) {
  const { t } = useI18n();
  const w = t.widgets.shared.dnsRecords;
  const [copied, setCopied] = useState<"name" | "value" | null>(null);
  const displayedName = displayDnsName(rec.name, domain);

  const copy = async (which: "name" | "value", text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(which);
      setTimeout(() => setCopied(null), 1200);
    } catch {
      // Non-HTTPS context - silently no-op.
    }
  };

  return (
    <div className="bg-card rounded-xl border border-border/60 p-4">
      <div className="flex items-center gap-2 mb-3">
        <span className="text-[11px] font-mono px-1.5 py-0.5 rounded bg-muted text-muted-foreground">
          {rec.type}
        </span>
        {rec.type === "MX" && rec.priority !== undefined && (
          <span className="text-xs text-muted-foreground">
            {interpolate(w.priority, { n: String(rec.priority) })}
          </span>
        )}
        {rec.required === false && (
          <span className="text-xs text-muted-foreground ms-auto">
            {w.recommended}
          </span>
        )}
      </div>

      <div className="space-y-2 font-mono text-[12px]">
        <DnsRecordField
          fieldLabel={w.name}
          value={displayedName}
          copied={copied === "name"}
          onCopy={() => copy("name", displayedName)}
        />
        <DnsRecordField
          fieldLabel={w.value}
          value={rec.value}
          copied={copied === "value"}
          onCopy={() => copy("value", rec.value)}
        />
      </div>
    </div>
  );
}

function DnsRecordField({
  fieldLabel,
  value,
  copied,
  onCopy,
}: {
  fieldLabel: string;
  value: string;
  copied: boolean;
  onCopy: () => void;
}) {
  const { t } = useI18n();
  return (
    <div className="flex items-start gap-2">
      <span className="text-xs text-muted-foreground font-sans w-10 shrink-0 mt-0.5">
        {fieldLabel}
      </span>
      <div className="flex-1 min-w-0 bg-muted/40 rounded-md px-2 py-1.5 text-foreground/90 break-all">
        {value}
      </div>
      <button
        onClick={onCopy}
        className="text-muted-foreground hover:text-foreground transition-colors p-1.5"
        title={t.widgets.shared.dnsRecords.copy}
      >
        {copied ? (
          <Check className="size-3.5 text-success" />
        ) : (
          <Copy className="size-3.5" />
        )}
      </button>
    </div>
  );
}
