"use client";

import Link from "next/link";
import { ArrowRight, Boxes, Loader2, Server } from "lucide-react";
import type { ClusterCapabilities } from "@repo/contracts";
import { BlurIp } from "@/components/BlurIp";
import { useI18n, interpolate } from "@/components/i18n-provider";
import type { ServerClustersOverview } from "@/hooks/useServerClustersOverview";
import { NetworkStatus } from "./NetworkStatus";
import { ClusterEmptyState } from "./ClusterEmptyState";
import { NetworkGroups } from "./NetworkGroups";
import { NetworkStreamNotice } from "./NetworkStreamNotice";
import { NetworkPreparationActions } from "./NetworkPreparationActions";

export function ServerClustersPanel({
  capabilities,
  overview,
  view = "clusters",
}: {
  capabilities: ClusterCapabilities;
  overview: ServerClustersOverview;
  view?: "clusters" | "networks";
}) {
  const { t } = useI18n();
  const c = t.servers.clusters;
  const n = t.servers.networks;
  const isNetworks = view === "networks";
  const { clusters, networks, preparations, stream } = overview;
  const error = stream.error;

  if (!capabilities.available) return null;
  return (
    <section>
      <NetworkStreamNotice stream={stream} />
      {!(isNetworks ? networks : clusters) && !error && (
        <Loader2 className="mx-auto my-16 size-5 animate-spin text-muted-foreground" />
      )}
      {isNetworks && !!preparations.length && (
        <div className="mb-6 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {preparations.map((setup) => (
            <article
              key={setup.id}
              className="relative rounded-2xl bg-card p-5 transition-colors hover:bg-muted/40"
            >
              <div className="flex items-center gap-2 pe-8 text-xs text-muted-foreground">
                {setup.status === "preparing" && <Loader2 className="size-3.5 animate-spin" />}
                {n.managed.preparationStatus[setup.status]}
              </div>
              <div className="absolute end-3 top-3 z-10">
                <NetworkPreparationActions
                  preparation={setup}
                  name={setup.name}
                  canManage={capabilities.canManage}
                  onDiscarded={overview.onDiscarded}
                  onRefresh={stream.reconnect}
                />
              </div>
              <h3 id={`setup-${setup.id}-name`} className="mt-2 truncate font-medium">
                {setup.name}
              </h3>
              <Link
                href={`/servers/networks/preparations/${setup.id}`}
                aria-labelledby={`setup-${setup.id}-name setup-${setup.id}-view`}
                className="mt-3 inline-flex items-center gap-1.5 text-xs font-medium text-primary after:absolute after:inset-0 after:rounded-2xl focus-visible:outline-none focus-visible:after:ring-2 focus-visible:after:ring-ring"
              >
                <span id={`setup-${setup.id}-view`}>{n.managed.viewPreparation}</span>
                <ArrowRight className="size-3.5 rtl:rotate-180" />
              </Link>
            </article>
          ))}
        </div>
      )}
      {(isNetworks ? networks?.length === 0 && !preparations.length : clusters?.length === 0) &&
        !error && <ClusterEmptyState view={view} canManage={capabilities.canManage} />}
      {!isNetworks ? (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {clusters?.map((cluster) => (
            <Link
              key={cluster.id}
              href={`/servers/clusters/${cluster.id}`}
              className="group rounded-2xl bg-card p-5 transition-colors hover:bg-muted/40"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="grid size-10 place-items-center rounded-xl bg-primary/8 text-primary">
                  <Boxes className="size-5" />
                </span>
                <NetworkStatus cluster={cluster.network} />
              </div>
              <h3 className="mt-4 truncate font-semibold">{cluster.name}</h3>
              <p className="mt-1 text-xs text-muted-foreground">
                {cluster.location || c.noLocation}
              </p>
              <div className="my-4 flex items-center gap-4 text-sm text-muted-foreground">
                <span className="inline-flex items-center gap-1.5">
                  <Server className="size-3.5" />
                  {interpolate(cluster.serverIds.length === 1 ? c.memberCountOne : c.memberCount, {
                    count: String(cluster.serverIds.length),
                  })}
                </span>
              </div>
              <span className="text-xs text-muted-foreground">{cluster.network.name}</span>
              <div className="mt-5 flex items-center justify-between border-t border-border pt-3 text-xs text-muted-foreground">
                <span className="truncate font-mono">
                  <BlurIp>{cluster.network.network.cidrs.join(", ")}</BlurIp>
                </span>
                <ArrowRight className="ms-3 size-4 shrink-0 transition-transform group-hover:translate-x-0.5" />
              </div>
            </Link>
          ))}
        </div>
      ) : (
        networks && networks.length > 0 && <NetworkGroups clusters={networks} />
      )}
    </section>
  );
}
