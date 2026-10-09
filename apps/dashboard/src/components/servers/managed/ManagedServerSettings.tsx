"use client";

import Link from "next/link";
import { useState } from "react";
import { useI18n } from "@/components/i18n-provider";
import { Button } from "@/components/ui/button";
import { systemApi } from "@/lib/api/system";
import { CapacitySummary } from "@/components/shared/CapacitySummary";
import type { ManagedServerActions } from "./useManagedServerActions";
import { ManagedControlPanel, ConnectionValue } from "./ManagedControlPanel";
import { useManagedServerResource } from "./useManagedServerResource";

export function ManagedServerSettings({
  serverId,
  actions,
}: {
  serverId: string;
  actions: ManagedServerActions;
}) {
  const { t } = useI18n();
  const common = t.servers.managedControls,
    copy = common.settings;
  const resource = useManagedServerResource(serverId, systemApi.managedInfo);
  const [logs, setLogs] = useState<{ logs: string; truncated: boolean } | null>(null);
  const info = resource.data;
  return (
    <ManagedControlPanel
      title={copy.title}
      description={copy.description}
      icon="server-settings"
      {...resource}
    >
      {info ? (
        <>
          <div className="grid min-w-0 grid-cols-1 gap-4 @min-[32rem]/server-detail:grid-cols-2">
            <ConnectionValue label={copy.image} value={info.image} />
            <ConnectionValue label={copy.providerId} value={info.workspaceId} />
            <div>
              <p className="text-xs text-muted-foreground">{copy.os}</p>
              <p className="mt-1 break-words text-sm">
                {info.operatingSystem ?? common.unavailable}
              </p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">{copy.lifecycle}</p>
              <p className="mt-1 text-sm">
                {info.mode === "permanent" ? copy.persistent : (info.mode ?? common.unavailable)}
              </p>
            </div>
          </div>
          <p className="rounded-xl bg-muted/30 p-4 text-sm text-muted-foreground">
            {copy.imageHint}
          </p>
          <div className="space-y-3">
            <h3 className="text-sm font-medium">{copy.resources}</h3>
            <CapacitySummary resources={info.resources} />
            <p className="text-sm text-muted-foreground">{copy.resourceHint}</p>
            <Button
              variant="secondary"
              disabled={actions.busy || resource.busy}
              onClick={() => void actions.previewResize()}
            >
              {t.billing.workspaces.resize}
            </Button>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button asChild variant="secondary">
              <Link href={`/servers/${encodeURIComponent(serverId)}?tab=terminal`}>
                {copy.terminal}
              </Link>
            </Button>
            <Button asChild variant="ghost">
              <Link href={`/servers/${encodeURIComponent(serverId)}?tab=overview`}>
                {copy.projects}
              </Link>
            </Button>
          </div>
          <div className="space-y-3">
            <Button
              variant="secondary"
              disabled={resource.busy}
              onClick={() => {
                setLogs(null);
                void resource.run(
                  () => systemApi.managedBootLogs(serverId, { tail: 200 }),
                  setLogs,
                );
              }}
            >
              {copy.bootLogs}
            </Button>
            {logs && (
              <div className="space-y-2 rounded-xl bg-muted/30 p-4">
                <pre
                  dir="ltr"
                  className="max-h-96 overflow-auto whitespace-pre-wrap break-all text-xs"
                >
                  {logs.logs || common.noLogs}
                </pre>
                {logs.truncated && (
                  <p className="text-xs text-muted-foreground">{common.logsTruncated}</p>
                )}
                <Button variant="ghost" size="sm" onClick={() => setLogs(null)}>
                  {common.close}
                </Button>
              </div>
            )}
          </div>
        </>
      ) : (
        resource.busy && <div className="h-32 animate-pulse rounded-xl bg-muted/40" />
      )}
    </ManagedControlPanel>
  );
}
