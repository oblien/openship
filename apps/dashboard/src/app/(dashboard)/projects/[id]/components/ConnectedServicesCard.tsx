"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2, Trash2, Network, Globe, PlugZap } from "lucide-react";
import { connectionsApi, type ProjectConnection } from "@/lib/api/connections";
import { getApiErrorMessage } from "@/lib/api/client";
import { AppLogo } from "@/components/AppLogo";
import { useToast } from "@/context/ToastContext";
import { useI18n } from "@/components/i18n-provider";

/**
 * "Connected services" — databases/apps wired into THIS (consumer) project, each
 * injecting a secret connection env var. Lists the links with a remove action.
 * Renders nothing when the project has no connections. Changes apply on the
 * project's next deploy (env is read at deploy time).
 */
export function ConnectedServicesCard({ projectId }: { projectId: string }) {
  const { t } = useI18n();
  const c = t.projects.connections;
  const { showToast } = useToast();
  const [links, setLinks] = useState<ProjectConnection[] | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);

  const load = useCallback(() => {
    connectionsApi
      .list(projectId)
      .then((res) => setLinks(res?.data ?? []))
      .catch(() => setLinks([]));
  }, [projectId]);

  useEffect(() => {
    load();
  }, [load]);

  const remove = async (link: ProjectConnection) => {
    if (removing) return;
    setRemoving(link.id);
    try {
      await connectionsApi.remove(projectId, link.id);
      showToast(c.removed, "success");
      load();
    } catch (err) {
      showToast(getApiErrorMessage(err, c.failed), "error");
    } finally {
      setRemoving(null);
    }
  };

  // Nothing wired in → render nothing (keeps the overview clean).
  if (!links || links.length === 0) return null;

  return (
    <div className="bg-card rounded-2xl border border-border/50 p-5">
      <div className="mb-1 flex items-center gap-2">
        <PlugZap className="size-4 text-primary" />
        <h3 className="text-sm font-semibold text-foreground">{c.cardTitle}</h3>
      </div>
      <p className="mb-4 text-xs leading-relaxed text-muted-foreground">{c.redeployHint}</p>
      <div className="divide-y divide-border/40">
        {links.map((l) => (
          <div key={l.id} className="flex items-center gap-3 py-3 first:pt-0 last:pb-0">
            <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted/50">
              <AppLogo appId={l.sourceAppTemplateId ?? undefined} className="size-4" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium text-foreground">{l.sourceName}</p>
              <p className="flex items-center gap-1.5 truncate text-[11px] text-muted-foreground">
                <code className="font-mono">{l.envKey}</code>
                <span className="inline-flex items-center gap-1 text-muted-foreground/60">
                  {l.mode === "internal" ? (
                    <Network className="size-3" />
                  ) : (
                    <Globe className="size-3" />
                  )}
                  {l.mode === "internal" ? c.modeInternalShort : c.modePublicShort}
                </span>
              </p>
            </div>
            <button
              type="button"
              onClick={() => remove(l)}
              disabled={removing === l.id}
              aria-label={c.remove}
              className="shrink-0 rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-danger-bg hover:text-danger disabled:opacity-50"
            >
              {removing === l.id ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <Trash2 className="size-3.5" />
              )}
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
