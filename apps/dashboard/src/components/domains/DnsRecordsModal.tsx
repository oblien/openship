"use client";

import React, { useEffect, useState } from "react";
import { Server, Loader2 } from "lucide-react";
import { useI18n } from "@/components/i18n-provider";
import { domainsApi } from "@/lib/api";
import type { DomainDnsRecord } from "@/lib/api/domains";
import DnsConfiguration from "@/app/(dashboard)/(deployment)/deploy/[slug]/components/DnsConfiguration";

interface DnsRecordsModalProps {
  /** Every custom hostname this deploy will serve. Compose may have several. */
  targets: Array<{
    hostname: string;
    includeWww?: boolean;
    /** Existing persisted row; absent during the pre-deploy preview. */
    domainId?: string | null;
  }>;
  /** Selected remote deployment target, so A records point at that server. */
  serverId?: string;
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
  targets,
  serverId,
  onConfirm,
  onCancel,
}: DnsRecordsModalProps) {
  const { t } = useI18n();
  const d = t.deploy.dns;
  const [sections, setSections] = useState<Array<{
    hostname: string;
    domainId?: string;
    records: DomainDnsRecord[];
    mode: "cloud" | "selfhosted";
  }>>([]);
  const [loading, setLoading] = useState(true);
  const targetKey = JSON.stringify({ targets, serverId });

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const loaded = await Promise.all(
          targets.map(async (target) => {
            try {
              const res = target.domainId
                ? await domainsApi.records(target.domainId)
                : await domainsApi.previewRecords(
                    target.hostname,
                    target.includeWww === true,
                    serverId,
                  );
              const mode = res.data.mode === "cloud" ? "cloud" as const : "selfhosted" as const;
              let records = res.data.records;
              if (
                target.includeWww &&
                mode === "selfhosted" &&
                !records.some((record) => record.type === "CNAME" && record.host.startsWith("www"))
              ) {
                records = [
                  ...records,
                  {
                    type: "CNAME" as const,
                    host: "www",
                    name: `www.${target.hostname}`,
                    value: target.hostname,
                  },
                ];
              }
              return {
                hostname: target.hostname,
                domainId: target.domainId ?? undefined,
                records,
                mode,
              };
            } catch {
              return {
                hostname: target.hostname,
                domainId: target.domainId ?? undefined,
                records: [],
                mode: "selfhosted" as const,
              };
            }
          }),
        );
        if (cancelled) return;
        setSections(loaded);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  // The serialized key is stable across equivalent arrays, avoiding a refetch
  // if a parent rebuilds the target list during an unrelated render.
  }, [targetKey]);

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
          <p className="text-xs text-muted-foreground break-words">
            {d.addRecordsFor}{" "}
            <span className="font-medium text-foreground">
              {targets.map((target) => target.hostname).join(", ")}
            </span>
          </p>
        </div>
      </div>

      <p className="mb-4 text-xs leading-relaxed text-muted-foreground">
        {d.modalSubtitle}
      </p>

      {loading ? (
        <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> {d.loadingRecords}
        </div>
      ) : (
        <div className="max-h-[60vh] space-y-4 overflow-y-auto pe-1">
          {sections.map((section) => (
            <DnsConfiguration
              key={section.hostname}
              domain={section.hostname}
              records={section.records}
              mode={section.mode}
              showHeader={targets.length > 1}
              domainId={section.domainId}
            />
          ))}
        </div>
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
