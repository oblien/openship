"use client";

/**
 * Settings → Infrastructure. POLICY ONLY: the two instance-wide preferences for
 * managed containers (edge / mail) — auto-update on a control-plane version bump,
 * and quiet auto-scan — plus a one-line roll-up that links to the fleet view.
 *
 * The list, the Scan button and every fix action live on the Servers tab (and the
 * per-server Components tab) on purpose: "which of my 15 boxes has a stopped edge"
 * is an operational question, and nobody firefights in Settings. This tab is where
 * you set the rules once.
 *
 * Self-hosted / desktop only (the SaaS has no operator-managed infra) and
 * owner-gated like the other instance-level cards.
 */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { ArrowRight, Boxes, CheckCircle2 } from "lucide-react";

import { useI18n, interpolate } from "@/components/i18n-provider";
import { systemApi } from "@/lib/api/system";
import { authClient, useSession } from "@/lib/auth-client";
import { SettingsSection } from "./SettingsSection";
import { SettingsToggleRow } from "./SettingsToggleRow";

/** Same narrow cast the other instance cards use to reach the org member list. */
const orgClient = (authClient as unknown as {
  organization: {
    listMembers: () => Promise<{ data?: { members?: Array<{ userId: string; role: string }> } }>;
  };
}).organization;

export function InfrastructureTab() {
  const { t } = useI18n();
  const { data: session } = useSession();
  const copy = t.settings.infrastructure;

  const [isOwner, setIsOwner] = useState<boolean | null>(null);
  const [autoUpdateInfra, setAutoUpdateInfra] = useState(false);
  const [autoScanInfra, setAutoScanInfra] = useState(true);
  /** Cached counts only — this tab never probes a server. */
  const [rollup, setRollup] = useState<{ attention: number; updates: number } | null>(null);

  useEffect(() => {
    let cancelled = false;
    orgClient
      .listMembers()
      .then((res) => {
        if (cancelled) return;
        const me = res.data?.members?.find((m) => m.userId === session?.user?.id);
        setIsOwner(me?.role === "owner");
      })
      .catch(() => {
        if (!cancelled) setIsOwner(false);
      });
    return () => {
      cancelled = true;
    };
  }, [session?.user?.id]);

  // Owner-only, so don't spend the reads until we know.
  useEffect(() => {
    if (isOwner !== true) return;
    let cancelled = false;
    void Promise.all([
      systemApi.containerIssues().catch(() => null),
      systemApi.containersBehind().catch(() => null),
    ]).then(([issues, behind]) => {
      if (cancelled) return;
      setRollup({ attention: issues?.total ?? 0, updates: behind?.components ?? 0 });
    });
    void systemApi.getInfraAutoUpdate().then(setAutoUpdateInfra).catch(() => {});
    void systemApi.getInfraAutoScan().then(setAutoScanInfra).catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [isOwner]);

  const toggleAutoInfra = useCallback((v: boolean) => {
    setAutoUpdateInfra(v);
    void systemApi.setInfraAutoUpdate(v).catch(() => setAutoUpdateInfra(!v));
  }, []);

  const toggleAutoScan = useCallback((v: boolean) => {
    setAutoScanInfra(v);
    void systemApi.setInfraAutoScan(v).catch(() => setAutoScanInfra(!v));
  }, []);

  // Same rule as the other instance cards: non-owners see nothing, not a denied card.
  if (isOwner !== true) return null;

  const parts = rollup
    ? [
        rollup.attention > 0
          ? interpolate(rollup.attention === 1 ? copy.attentionOne : copy.attentionMany, {
              n: String(rollup.attention),
            })
          : null,
        rollup.updates > 0
          ? interpolate(rollup.updates === 1 ? copy.updatesOne : copy.updatesMany, {
              n: String(rollup.updates),
            })
          : null,
      ].filter((p): p is string => Boolean(p))
    : [];

  return (
    <SettingsSection icon={Boxes} title={copy.title} description={copy.description}>
      <div className="space-y-5">
        <SettingsToggleRow
          checked={autoUpdateInfra}
          onChange={toggleAutoInfra}
          label={copy.autoUpdateLabel}
          description={copy.autoUpdateDesc}
        />

        <SettingsToggleRow
          checked={autoScanInfra}
          onChange={toggleAutoScan}
          label={copy.autoScanLabel}
          description={copy.autoScanDesc}
        />

        {/* Roll-up → the fleet view. One line, cached counts, no action here. */}
        <div className="flex items-center justify-between gap-3 border-t border-border/50 pt-4">
          {parts.length > 0 ? (
            <p className="min-w-0 text-[13px] text-foreground">{parts.join(" · ")}</p>
          ) : (
            <p className="inline-flex min-w-0 items-center gap-1.5 text-[13px] text-muted-foreground">
              <CheckCircle2 className="size-3.5 shrink-0 text-success" />
              {copy.allHealthy}
            </p>
          )}
          <Link
            href="/servers"
            className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-muted/50 px-3 py-1.5 text-[12px] font-medium text-foreground transition-colors hover:bg-muted"
          >
            {copy.manageLink}
            <ArrowRight className="size-3.5 rtl:rotate-180" />
          </Link>
        </div>
      </div>
    </SettingsSection>
  );
}
