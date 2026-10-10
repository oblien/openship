"use client";

import { useCallback } from "react";
import { Icon } from "@repo/ui/icons";
import { actionsApi } from "@/lib/api/actions";
import { formatBytes } from "@/lib/formatBytes";
import { useI18n } from "@/components/i18n-provider";
import { Button } from "@/components/ui/button";
import { ActionError } from "./ActionStatus";
import { useActionMutation, useActionResource } from "./useActions";

export function RunArtifacts({ runId, settled }: { runId: string; settled: boolean }) {
  const { t, locale } = useI18n();
  const a = t.actions;
  const fetcher = useCallback(() => actionsApi.artifacts(runId), [runId]);
  const resource = useActionResource(fetcher, settled ? 0 : 8000);
  const mutation = useActionMutation();
  if (!resource.data?.length && !resource.error) return null;
  return (
    <section className="space-y-4 rounded-2xl bg-card p-5">
      <h2 className="text-sm font-semibold">{a.artifacts}</h2>
      <ActionError message={resource.error || mutation.error} onRetry={resource.refresh} />
      <div className="divide-y divide-border/40">
        {resource.data?.map((artifact) => (
          <div
            key={artifact.id}
            className="flex flex-wrap items-center gap-3 py-3 first:pt-0 last:pb-0"
          >
            <Icon name="archive" className="size-5 text-muted-foreground" />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">{artifact.name}</p>
              <p className="mt-1 text-xs text-muted-foreground">
                {formatBytes(artifact.size)} · {a.expires}{" "}
                {new Date(artifact.expiresAt).toLocaleDateString(locale)}
              </p>
            </div>
            <Button
              size="sm"
              variant="secondary"
              disabled={mutation.busy}
              aria-label={`${a.download}: ${artifact.name}`}
              onClick={async () => {
                const response = await mutation.execute(() =>
                  actionsApi.artifactDownload(runId, artifact.id),
                );
                if (!response) return;
                const link = document.createElement("a");
                link.href = response.url;
                link.download = `${artifact.name}.zip`;
                link.rel = "noopener noreferrer";
                document.body.appendChild(link);
                link.click();
                link.remove();
              }}
            >
              <Icon name="download" />
              {a.download}
            </Button>
          </div>
        ))}
      </div>
    </section>
  );
}
