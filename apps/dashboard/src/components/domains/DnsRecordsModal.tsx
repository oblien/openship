"use client";

import { Icon as UiIcon } from "@repo/ui/icons";

import React, { useCallback, useEffect, useId, useState } from "react";
import { useI18n } from "@/components/i18n-provider";
import { domainsApi } from "@/lib/api";
import { getApiErrorMessage } from "@/lib/api/client";
import { Button } from "@/components/ui/button";
import { useDialogFocus } from "@/hooks/useDialogFocus";
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
  confirmLabel?: string;
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
  confirmLabel,
  onConfirm,
  onCancel,
}: DnsRecordsModalProps) {
  const { t } = useI18n();
  const d = t.deploy.dns;
  const titleId = useId();
  const { dialog, onKeyDown } = useDialogFocus(onCancel);
  const [sections, setSections] = useState<
    Array<{
      hostname: string;
      domainId?: string;
      records: DomainDnsRecord[];
      mode: "cloud" | "selfhosted";
      error?: string;
    }>
  >([]);
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  const [connectionRevision, setConnectionRevision] = useState(0);
  const [applying, setApplying] = useState<Set<string>>(() => new Set());
  const handleApplying = useCallback((hostname: string, busy: boolean) => {
    setApplying((current) => {
      if (current.has(hostname) === busy) return current;
      const next = new Set(current);
      if (busy) next.add(hostname);
      else next.delete(hostname);
      return next;
    });
  }, []);
  const handleConnected = useCallback(() => setConnectionRevision((value) => value + 1), []);
  const targetKey = JSON.stringify({ targets, serverId });

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void (async () => {
      try {
        const loaded = await Promise.all(
          targets.map(async (target) => {
            try {
              const res = target.domainId
                ? await domainsApi.records(target.domainId, serverId)
                : await domainsApi.previewRecords(
                    target.hostname,
                    target.includeWww === true,
                    serverId,
                  );
              const mode = res.data.mode === "cloud" ? ("cloud" as const) : ("selfhosted" as const);
              return {
                hostname: target.hostname,
                domainId: target.domainId ?? undefined,
                records: res.data.records,
                mode,
              };
            } catch (error) {
              return {
                hostname: target.hostname,
                domainId: target.domainId ?? undefined,
                records: [],
                mode: "selfhosted" as const,
                error: getApiErrorMessage(error, t.autoDns.recordsFailed),
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
  }, [targetKey, revision]);

  return (
    <div
      ref={dialog}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      className="flex max-h-[90vh] min-h-0 flex-col p-5 outline-none"
    >
      <div className="mb-4 flex shrink-0 items-center gap-3">
        <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/10">
          <UiIcon name="server" className="size-4 text-primary" />
        </div>
        <div className="min-w-0">
          <h2 id={titleId} className="text-lg font-semibold text-foreground">
            {d.title}
          </h2>
          <p className="text-xs text-muted-foreground break-words">
            {d.addRecordsFor}{" "}
            <span className="font-medium text-foreground">
              {targets.map((target) => target.hostname).join(", ")}
            </span>
          </p>
        </div>
      </div>

      <p className="mb-4 shrink-0 text-xs leading-relaxed text-muted-foreground">{d.modalSubtitle}</p>

      {loading ? (
        <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
          <UiIcon name="spinner" className="size-4 animate-spin" /> {d.loadingRecords}
        </div>
      ) : (
        <div className="max-h-[60vh] min-h-0 space-y-4 overflow-y-auto pe-1">
          {sections.map((section) =>
            section.error ? (
              <div key={section.hostname} className="space-y-3 rounded-xl bg-card p-4">
                <p className="break-all text-sm font-medium text-foreground">{section.hostname}</p>
                <p role="alert" className="break-words text-sm text-danger">
                  {section.error}
                </p>
                <Button
                  type="button"
                  variant="secondary"
                  disabled={applying.size > 0}
                  onClick={() => setRevision((value) => value + 1)}
                >
                  {t.autoDns.retry}
                </Button>
              </div>
            ) : (
              <DnsConfiguration
                key={section.hostname}
                domain={section.hostname}
                records={section.records}
                mode={section.mode}
                showHeader={targets.length > 1}
                domainId={section.domainId}
                serverId={serverId}
                connectionRevision={connectionRevision}
                onConnected={handleConnected}
                onApplyingChange={handleApplying}
              />
            ),
          )}
        </div>
      )}

      <div className="mt-5 flex shrink-0 items-center justify-end gap-2">
        <Button type="button" onClick={onCancel} variant="ghost">
          {d.cancel}
        </Button>
        <Button type="button" onClick={onConfirm} disabled={loading || applying.size > 0}>
          {confirmLabel ?? d.deployAction}
        </Button>
      </div>
    </div>
  );
}
