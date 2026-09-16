"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ArrowRight, Boxes, Loader2, Network, Plus, RefreshCw, Server } from "lucide-react";
import type { ClusterCapabilities, ServerCluster } from "@repo/contracts";
import { useI18n, interpolate } from "@/components/i18n-provider";
import { Button } from "@/components/ui/button";
import { getApiErrorMessage } from "@/lib/api";
import { serverClustersApi } from "@/lib/api/server-clusters";
import { ClusterStatus } from "./ClusterStatus";
import { ClusterEmptyState } from "./ClusterEmptyState";
import { PROVIDER_COLORS } from "./model";

export function ServerClustersPanel({
  capabilities,
  view = "clusters",
}: {
  capabilities: ClusterCapabilities;
  view?: "clusters" | "networks";
}) {
  const { t } = useI18n();
  const c = t.servers.clusters;
  const isNetworks = view === "networks";
  const [clusters, setClusters] = useState<ServerCluster[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const request = useRef(0);
  const load = useCallback(async () => {
    const current = ++request.current;
    setRefreshing(true);
    try {
      const next = await serverClustersApi.list();
      if (current === request.current) {
        setClusters(next);
        setError(null);
      }
    } catch (err) {
      if (current === request.current) setError(getApiErrorMessage(err));
    } finally {
      if (current === request.current) setRefreshing(false);
    }
  }, []);
  useEffect(() => {
    if (capabilities.available) void load();
    return () => {
      request.current++;
    };
  }, [load, capabilities.available]);
  useEffect(() => {
    if (!clusters?.some((cluster) => cluster.verification?.status === "running")) return;
    const timer = setTimeout(() => void load(), 2500);
    return () => clearTimeout(timer);
  }, [clusters, load]);

  if (!capabilities.available) return null;
  return (
    <section>
      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold">{isNetworks ? c.networksTitle : c.listTitle}</h2>
          <p className="mt-1 max-w-2xl text-sm leading-relaxed text-muted-foreground">
            {isNetworks ? c.networksDescription : c.listDescription}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={() => void load()}
            disabled={refreshing}
            aria-label={c.refresh}
          >
            <RefreshCw className={`size-4 ${refreshing ? "animate-spin" : ""}`} />
          </Button>
          {!isNetworks && capabilities.canManage && !!clusters?.length && (
            <Button asChild>
              <Link href="/servers/clusters/new">
                <Plus />
                {c.createCluster}
              </Link>
            </Button>
          )}
        </div>
      </div>
      {error && (
        <div
          role="alert"
          className="mb-4 flex items-center justify-between gap-3 rounded-xl bg-danger/10 p-4 text-sm text-danger"
        >
          <span>{error}</span>
          <button
            type="button"
            onClick={() => void load()}
            className="shrink-0 font-medium underline"
          >
            {c.retry}
          </button>
        </div>
      )}
      {!clusters && !error && (
        <Loader2 className="mx-auto my-16 size-5 animate-spin text-muted-foreground" />
      )}
      {clusters?.length === 0 && !error && (
        <ClusterEmptyState view={view} canManage={capabilities.canManage} />
      )}
      {!isNetworks ? (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {clusters?.map((cluster) => (
            <Link
              key={cluster.id}
              href={`/servers/clusters/${cluster.id}`}
              className="group rounded-2xl border border-border bg-card p-5 transition-colors hover:border-primary/30"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="grid size-10 place-items-center rounded-xl bg-primary/8 text-primary">
                  <Boxes className="size-5" />
                </span>
                <ClusterStatus cluster={cluster} />
              </div>
              <h3 className="mt-4 truncate font-semibold">{cluster.name}</h3>
              <p className="mt-1 text-xs text-muted-foreground">
                {cluster.location || c.noLocation}
              </p>
              <div className="my-4 flex items-center gap-4 text-sm text-muted-foreground">
                <span className="inline-flex items-center gap-1.5">
                  <Server className="size-3.5" />
                  {interpolate(c.memberCount, { count: String(cluster.members.length) })}
                </span>
                <span className="inline-flex items-center gap-1.5">
                  <Network className="size-3.5" />
                  {c.nativeNetwork}
                </span>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {[...new Set(cluster.members.map((m) => m.providerId))].map((id) => (
                  <span
                    key={id}
                    className={`rounded-md px-2 py-1 text-[11px] font-medium ${PROVIDER_COLORS[id]}`}
                  >
                    {id === "custom"
                      ? c.customProvider
                      : (capabilities.providers.find((p) => p.id === id)?.name ?? id)}
                  </span>
                ))}
              </div>
              <div className="mt-5 flex items-center justify-between border-t border-border pt-3 text-xs text-muted-foreground">
                <span className="truncate font-mono">{cluster.network.cidrs.join(", ")}</span>
                <ArrowRight className="ms-3 size-4 shrink-0 transition-transform group-hover:translate-x-0.5" />
              </div>
            </Link>
          ))}
        </div>
      ) : (
        clusters &&
        clusters.length > 0 && (
          <div className="overflow-x-auto rounded-xl border border-border bg-card">
            <table className="w-full text-start text-sm">
              <thead className="bg-muted/40 text-xs text-muted-foreground">
                <tr>
                  {[c.addressRanges, c.stepCluster, c.members, c.mtu, c.networkStatus].map(
                    (label) => (
                      <th key={label} className="px-4 py-3 text-start font-medium">
                        {label}
                      </th>
                    ),
                  )}
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {clusters.map((cluster) => (
                  <tr key={cluster.id}>
                    <td className="px-4 py-4">
                      <Link
                        className="font-mono text-xs text-primary hover:underline"
                        href={`/servers/clusters/${cluster.id}?tab=network`}
                      >
                        {cluster.network.cidrs.join(", ")}
                      </Link>
                    </td>
                    <td className="px-4 py-4">
                      <Link
                        className="font-medium hover:text-primary"
                        href={`/servers/clusters/${cluster.id}`}
                      >
                        {cluster.name}
                      </Link>
                    </td>
                    <td className="px-4 py-4">{cluster.members.length}</td>
                    <td className="px-4 py-4 tabular-nums">{cluster.network.mtu}</td>
                    <td className="px-4 py-4">
                      <ClusterStatus cluster={cluster} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      )}
    </section>
  );
}
