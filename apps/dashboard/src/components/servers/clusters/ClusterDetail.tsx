"use client";

import { Icon as UiIcon } from "@repo/ui/icons";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { ClusterCapabilities, ComputeCluster } from "@repo/contracts";
import { useI18n, interpolate } from "@/components/i18n-provider";
import { PageContainer } from "@/components/ui/PageContainer";
import { Button } from "@/components/ui/button";
import { BlurIp } from "@/components/BlurIp";
import { usePlatform } from "@/context/PlatformContext";
import { useRunEvents } from "@/hooks/useRunEvents";
import { getApiErrorMessage } from "@/lib/api";
import { computeClustersApi } from "@/lib/api/compute-clusters";
import { privateNetworksApi } from "@/lib/api/private-networks";
import { NetworkStatus } from "./NetworkStatus";
import { NetworkSource } from "./NetworkSource";
import { NetworkDiagnosticText } from "./NetworkSetupProgress";
import { NetworkSetupConfirmation } from "./NetworkSetupConfirmation";
import { NetworkStreamNotice } from "./NetworkStreamNotice";
import { ClusterRuntimePanel } from "./ClusterRuntimePanel";

export function ClusterDetail({ id }: { id: string }) {
  const { t } = useI18n();
  const c = t.servers.clusters;
  const { selfHosted, deployMode } = usePlatform();
  const eligible = selfHosted && deployMode !== "cloud";
  const router = useRouter();
  const [cluster, setCluster] = useState<ComputeCluster | null>(null);
  const [capabilities, setCapabilities] = useState<ClusterCapabilities | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [removing, setRemoving] = useState(false);
  const [removeTarget, setRemoveTarget] = useState<Pick<ComputeCluster, "id" | "revision"> | null>(
    null,
  );
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let active = true;
    setCluster(null);
    setError(null);
    if (eligible)
      void Promise.all([computeClustersApi.get(id), privateNetworksApi.capabilities()])
        .then(([next, caps]) => {
          if (active) {
            setCluster(next);
            setCapabilities(caps);
          }
        })
        .catch((err) => {
          if (active) setError(getApiErrorMessage(err));
        });
    return () => {
      active = false;
    };
  }, [id, eligible, attempt]);
  const stream = useRunEvents<{ computeClusters: ComputeCluster[] }>(
    eligible && cluster?.id === id ? "system/networks/stream" : null,
    (snapshot) => {
      const next = snapshot.computeClusters.find((item) => item.id === id);
      if (next) setCluster(next);
      else router.replace("/servers?tab=cluster");
    },
  );
  const remove = useCallback(async () => {
    if (!removeTarget || busy || !capabilities?.canManage) return;
    setBusy(true);
    setError(null);
    try {
      await computeClustersApi.remove(removeTarget);
      router.replace("/servers?tab=cluster");
    } catch (err) {
      setError(getApiErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }, [removeTarget, busy, capabilities, router]);
  if (!eligible)
    return (
      <PageContainer>
        <p className="text-sm text-muted-foreground">{c.selfHostedOnly}</p>
      </PageContainer>
    );
  return (
    <PageContainer>
      <Link
        href="/servers?tab=cluster"
        className="mb-5 inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground"
      >
        <UiIcon name="arrow-left" className="size-4 rtl:rotate-180" />
        {c.backToClusters}
      </Link>
      <NetworkStreamNotice stream={stream} />
      {error && !removing && (
        <div role="alert" className="mb-5 rounded-xl bg-danger/10 p-4 text-sm text-danger">
          {error}
          <Button variant="ghost" onClick={() => setAttempt((value) => value + 1)}>
            {c.retry}
          </Button>
        </div>
      )}
      {!cluster && !error && (
        <UiIcon name="spinner" className="mx-auto my-16 size-5 animate-spin text-muted-foreground" />
      )}
      {cluster && (
        <>
          <div className="mb-6 flex flex-wrap items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <span className="grid size-12 place-items-center rounded-xl bg-primary/10 text-primary">
                <UiIcon name="cluster" className="size-6" />
              </span>
              <div>
                <h1 className="text-2xl font-semibold tracking-tight">{cluster.name}</h1>
                <p className="mt-1 text-sm text-muted-foreground">
                  {cluster.location || c.noLocation} ·{" "}
                  {interpolate(cluster.serverIds.length === 1 ? c.memberCountOne : c.memberCount, {
                    count: String(cluster.serverIds.length),
                  })}
                </p>
              </div>
            </div>
            {capabilities?.canManage && (
              <div className="flex items-center gap-2">
                <Button asChild variant="secondary">
                  <Link href={`/servers/clusters/${encodeURIComponent(id)}/edit`}>
                    <UiIcon name="sliders" className="size-4" />
                    {c.editCluster}
                  </Link>
                </Button>
                <Button
                  variant="ghost"
                  onClick={() => {
                    setError(null);
                    setRemoveTarget({ id: cluster.id, revision: cluster.revision });
                    setRemoving(true);
                  }}
                  className="hover:bg-danger/10 hover:text-danger"
                >
                  <UiIcon name="trash" className="size-4" />
                  {c.removeCluster}
                </Button>
              </div>
            )}
          </div>
          <ClusterRuntimePanel
            key={cluster.id}
            cluster={cluster}
            canManage={!!capabilities?.canManage}
          />
          <div className="@container/cluster-detail">
            <div className="grid grid-cols-1 items-start gap-6 @4xl/cluster-detail:grid-cols-[minmax(0,1fr)_320px]">
              <section
                className="min-w-0 rounded-2xl bg-card p-5 sm:p-7"
                aria-labelledby="cluster-members-title"
              >
                <h2 id="cluster-members-title" className="text-base font-semibold">
                  {c.members}
                </h2>
                <div className="mt-3 divide-y divide-border/50">
                  {cluster.network.members
                    .filter((member) => cluster.serverIds.includes(member.serverId))
                    .map((member) => (
                      <Link
                        key={member.serverId}
                        href={`/servers/${encodeURIComponent(member.serverId)}`}
                        className="flex items-center gap-3 py-4 text-sm hover:text-primary"
                      >
                        <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-muted/40 text-muted-foreground">
                          <UiIcon name="server" className="size-4" />
                        </span>
                        <span className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
                          <NetworkDiagnosticText value={member.name} />
                          <span aria-hidden="true" className="h-3 w-px bg-border" />
                          <span className="font-mono text-xs text-muted-foreground">
                            <BlurIp>{member.privateIp}</BlurIp>
                          </span>
                        </span>
                        <UiIcon name="arrow-up-right" className="size-4 shrink-0 text-muted-foreground rtl:-rotate-90" />
                      </Link>
                    ))}
                </div>
              </section>
              <aside className="space-y-4 rounded-2xl bg-card p-5">
                <div className="flex items-center gap-2 text-sm font-semibold">
                  <UiIcon name="network" className="size-4 text-info" />
                  {cluster.network.name}
                </div>
                <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                  <NetworkStatus cluster={cluster.network} />
                  <NetworkSource cluster={cluster.network} />
                </div>
                <p className="break-words font-mono text-xs text-muted-foreground">
                  <BlurIp>{cluster.network.network.cidrs.join(", ")}</BlurIp>
                </p>
                <Button asChild variant="secondary" className="w-full">
                  <Link href={`/servers/networks/${encodeURIComponent(cluster.networkId)}`}>
                    {c.openNetwork}
                    <UiIcon name="arrow-up-right" className="size-4 rtl:-rotate-90" />
                  </Link>
                </Button>
              </aside>
            </div>
          </div>
          {removing && (
            <NetworkSetupConfirmation
              title={c.removeCluster}
              description={c.removeDescription}
              confirmLabel={c.removeCluster}
              busy={busy}
              error={error}
              onClose={() => setRemoving(false)}
              onConfirm={() => void remove()}
            />
          )}
        </>
      )}
    </PageContainer>
  );
}
