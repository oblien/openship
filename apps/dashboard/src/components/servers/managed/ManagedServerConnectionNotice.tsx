"use client";

import type { CloudWorkspaceSummary } from "@repo/contracts";
import { Icon } from "@repo/ui/icons";
import { useCloud } from "@/context/CloudContext";
import { useI18n } from "@/components/i18n-provider";
import { Button } from "@/components/ui/button";

export function ManagedServerConnectionNotice({
  issue,
  refresh,
  busy = false,
}: {
  issue: NonNullable<CloudWorkspaceSummary["connectionIssue"]>;
  refresh: () => void;
  busy?: boolean;
}) {
  const { t } = useI18n();
  const cloud = useCloud();
  const copy = t.servers.managedControls.cloudConnection;
  const needsAccount = issue !== "unavailable";
  return (
    <section role="status" className="space-y-4 rounded-2xl bg-card p-5">
      <div className="flex items-start gap-3">
        <Icon name="cloud" className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
        <div className="min-w-0">
          <h2 className="text-base font-medium">{copy.titles[issue]}</h2>
          <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
            {copy.descriptions[issue]}
          </p>
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        {needsAccount && (
          <Button disabled={cloud.connecting || busy} onClick={cloud.startConnect}>
            <Icon name="cloud" className="size-4" />
            {cloud.connecting ? copy.connecting : copy.signIn}
          </Button>
        )}
        <Button variant="secondary" disabled={busy || cloud.loading} onClick={refresh}>
          <Icon name="refresh" className={`size-4 ${busy ? "animate-spin" : ""}`} />
          {t.servers.managedControls.retry}
        </Button>
      </div>
    </section>
  );
}
