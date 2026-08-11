"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { ArrowUpRight, Globe, Loader2, Network, PlugZap, Unplug } from "lucide-react";
import { connectionsApi, type ProjectConnection } from "@/lib/api/connections";
import { getApiErrorMessage } from "@/lib/api/client";
import { AppLogo } from "@/components/AppLogo";
import { useToast } from "@/context/ToastContext";
import { useI18n, interpolate } from "@/components/i18n-provider";

/**
 * Linked apps, listed alongside the project's own services.
 *
 * An app wired into this project (a database, a cache) is something the project
 * runs against but does NOT own: no container of ours, no volume of ours, no
 * start/stop. It still belongs on this tab, because "what is this project made
 * of" is the question this tab answers — and the link was previously only
 * visible on Overview. Rows are read-only apart from unlinking, and they lead to
 * the app's own project page.
 *
 * Renders nothing when nothing is wired in.
 */
export function LinkedAppsCard({ projectId }: { projectId: string }) {
  const { t } = useI18n();
  const c = t.projects.connections;
  const { showToast } = useToast();
  const [links, setLinks] = useState<ProjectConnection[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(() => {
    connectionsApi
      .list(projectId)
      .then((res) => setLinks(res?.data ?? []))
      .catch(() => setLinks([]));
  }, [projectId]);

  useEffect(() => {
    load();
  }, [load]);

  if (!links || links.length === 0) return null;

  // One row per linked APP — an app can inject several env vars into the same
  // project, and the row represents the app, not each variable.
  const byApp = new Map<string, { name: string; appTemplateId: string | null; links: ProjectConnection[] }>();
  for (const l of links) {
    const group = byApp.get(l.sourceProjectId);
    if (group) group.links.push(l);
    else
      byApp.set(l.sourceProjectId, {
        name: l.sourceName,
        appTemplateId: l.sourceAppTemplateId,
        links: [l],
      });
  }

  /** Unlink the whole app: every variable it injects here goes with it. */
  const unlink = async (sourceProjectId: string, group: { name: string; links: ProjectConnection[] }) => {
    if (busy) return;
    setBusy(sourceProjectId);
    try {
      for (const l of group.links) {
        await connectionsApi.remove(projectId, l.id);
      }
      showToast(c.removed, "success");
      load();
    } catch (err) {
      showToast(getApiErrorMessage(err, c.failed), "error", group.name);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="bg-card rounded-2xl border border-border/50 overflow-hidden">
      <div className="flex items-center gap-3 border-b border-border/40 px-5 py-4">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-primary/10">
          <PlugZap className="size-4 text-primary" />
        </div>
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-foreground">
            {interpolate(byApp.size === 1 ? c.linkedCountOne : c.linkedCountOther, {
              count: String(byApp.size),
            })}
          </h3>
          <p className="mt-0.5 text-xs text-muted-foreground">{c.linkedHint}</p>
        </div>
      </div>

      <div className="divide-y divide-border/40">
        {[...byApp].map(([sourceId, group]) => (
          <div key={sourceId} className="flex items-center gap-4 px-5 py-4">
            <div className="w-10 h-10 rounded-xl bg-muted/50 flex items-center justify-center shrink-0 overflow-hidden">
              <AppLogo appId={group.appTemplateId ?? undefined} className="size-5" />
            </div>

            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-[14px] font-semibold text-foreground truncate">
                  {group.name}
                </span>
                <span className="inline-flex items-center gap-1 rounded-full bg-muted/60 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground/70">
                  <PlugZap className="size-2.5" />
                  {c.linkedBadge}
                </span>
              </div>
              <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-muted-foreground">
                {group.links.map((l) => (
                  <span key={l.id} className="inline-flex items-center gap-1">
                    <code className="font-mono">{l.envKey}</code>
                    <span className="inline-flex items-center gap-1 text-muted-foreground/60">
                      {l.mode === "internal" ? (
                        <Network className="size-3" />
                      ) : (
                        <Globe className="size-3" />
                      )}
                      {l.mode === "internal" ? c.modeInternalShort : c.modePublicShort}
                    </span>
                  </span>
                ))}
              </p>
            </div>

            <div className="flex items-center gap-1 shrink-0">
              <button
                type="button"
                onClick={() => unlink(sourceId, group)}
                disabled={busy === sourceId}
                aria-label={c.unlink}
                title={c.unlink}
                className="rounded-lg p-2 text-muted-foreground transition-colors hover:bg-danger-bg hover:text-danger disabled:opacity-50"
              >
                {busy === sourceId ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <Unplug className="size-3.5" />
                )}
              </button>
              <Link
                href={`/projects/${sourceId}`}
                aria-label={c.openApp}
                title={c.openApp}
                className="rounded-lg p-2 text-muted-foreground transition-colors hover:bg-foreground/[0.1] hover:text-foreground"
              >
                <ArrowUpRight className="size-3.5" />
              </Link>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
