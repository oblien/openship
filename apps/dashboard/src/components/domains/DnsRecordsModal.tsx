"use client";

import React, { useEffect, useMemo, useState } from "react";
import { Server, Loader2 } from "lucide-react";
import { useI18n } from "@/components/i18n-provider";
import { domainsApi } from "@/lib/api";
import type { DomainDnsRecord } from "@/lib/api/domains";
import DnsConfiguration from "@/app/(dashboard)/(deployment)/deploy/[slug]/components/DnsConfiguration";

interface DnsRecordsModalProps {
  /** The apex/primary custom hostname the deploy will serve. */
  hostname: string;
  /** When set, fetch the project-aware records for the existing row; otherwise
   *  preview from the hostname alone (server IP still resolves on self-hosted). */
  domainId?: string | null;
  /** Show the synthesized `www` CNAME line (the www variant endpoint is enabled). */
  includeWww?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * Pre-deploy modal for a custom domain: shows the DNS records to add BEFORE the
 * first deploy so DNS is pointed when the first-deploy SSL attempt runs (a failed
 * attempt just marks the domain Action Required — see the deploy-time tracked SSL
 * provider). Informational-blocking: Deploy proceeds, Cancel aborts.
 */
export default function DnsRecordsModal({
  hostname,
  domainId,
  includeWww,
  onConfirm,
  onCancel,
}: DnsRecordsModalProps) {
  const { t } = useI18n();
  const d = t.deploy.dns;
  const [records, setRecords] = useState<DomainDnsRecord[] | null>(null);
  const [mode, setMode] = useState<"cloud" | "selfhosted">("selfhosted");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = domainId
          ? await domainsApi.records(domainId)
          : await domainsApi.previewRecords(hostname);
        if (cancelled) return;
        setRecords(res.data.records);
        setMode(res.data.mode === "cloud" ? "cloud" : "selfhosted");
      } catch {
        if (!cancelled) setRecords([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [hostname, domainId]);

  // Synthesized, display-only `www → apex` CNAME. The backend still mints the
  // apex A record used for actual verification; this is guidance only.
  const shown = useMemo<DomainDnsRecord[]>(() => {
    if (!records) return [];
    if (!includeWww || mode === "cloud") return records;
    const apex = hostname.replace(/^www\./, "");
    if (records.some((r) => r.type === "CNAME" && r.host.startsWith("www"))) return records;
    return [...records, { type: "CNAME", host: "www", name: `www.${apex}`, value: apex }];
  }, [records, includeWww, mode, hostname]);

  return (
    <div className="p-5">
      {/* Same clean header as the "view DNS" modal — records + the hint carry
          everything; the old "Point your domain, then deploy" title/subtitle and
          the "auto-configure" row were redundant chrome. */}
      <div className="mb-4 flex items-center gap-3">
        <div className="flex size-9 items-center justify-center rounded-lg bg-primary/10">
          <Server className="size-4 text-primary" />
        </div>
        <div>
          <h2 className="text-sm font-semibold text-foreground">{d.title}</h2>
          <p className="text-xs text-muted-foreground">
            {d.addRecordsFor} <span className="font-medium text-foreground">{hostname}</span>
          </p>
        </div>
      </div>

      {loading ? (
        <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> {d.loadingRecords}
        </div>
      ) : (
        <DnsConfiguration domain={hostname} records={shown} mode={mode} showHeader={false} />
      )}

      <div className="mt-5 flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="rounded-xl px-4 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-muted/60"
        >
          {d.cancel}
        </button>
        <button
          type="button"
          onClick={onConfirm}
          className="rounded-xl bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
        >
          {d.deployAction}
        </button>
      </div>
    </div>
  );
}
