"use client";

import Link from "next/link";
import { ArrowUpRight, Globe, Network, Share2 } from "lucide-react";
import { type ConnectionConsumer } from "@/lib/api/connections";
import { useProjectConnections } from "@/hooks/use-project-connections";
import { useI18n } from "@/components/i18n-provider";

/**
 * "Used by" — the projects consuming THIS app's connection.
 *
 * The mirror of ConnectedServicesCard, which only ever showed the consumer's own
 * side. One shared database backs as many apps as you like (the link's unique
 * index is on `(target, envKey)`, not the source), so without this the shared app
 * was the one place that couldn't see its own dependents — and deleting it was a
 * surprise. Read-only: unlinking stays on the consumer, which owns the env var.
 *
 * Renders nothing when nothing consumes it.
 */
export function UsedByCard({ projectId, serviceId }: { projectId: string; serviceId?: string }) {
  const { t } = useI18n();
  const c = t.projects.connections;
  const allConsumers = useProjectConnections(projectId, "consumers");
  const consumers = allConsumers?.filter(link => !serviceId || link.sourceServiceId === serviceId);

  if (!consumers || consumers.length === 0) return null;

  // One project can hold several links (two env vars off the same database), so
  // group by project — the card is about dependents, not rows.
  const byProject = new Map<string, { name: string; links: ConnectionConsumer[] }>();
  for (const item of consumers) {
    const entry = byProject.get(item.targetProjectId);
    if (entry) entry.links.push(item);
    else byProject.set(item.targetProjectId, { name: item.targetName, links: [item] });
  }

  return (
    <div className="bg-card rounded-2xl border border-border/50 p-5">
      <div className="mb-1 flex items-center gap-2">
        <Share2 className="size-4 text-primary" />
        <h3 className="text-sm font-semibold text-foreground">{c.usedByTitle}</h3>
      </div>
      <p className="mb-4 text-xs leading-relaxed text-muted-foreground">
        {c.usedByHint.replace("{count}", String(byProject.size))}
      </p>
      <div className="divide-y divide-border/40">
        {[...byProject.entries()].map(([targetId, group]) => (
          <div key={targetId} className="flex items-center gap-3 py-3 first:pt-0 last:pb-0">
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium text-foreground">{group.name}</p>
              <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
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
            <Link
              href={`/projects/${targetId}`}
              aria-label={c.usedByOpen}
              className="shrink-0 rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <ArrowUpRight className="size-3.5" />
            </Link>
          </div>
        ))}
      </div>
    </div>
  );
}
