"use client";

import { Icon as UiIcon } from "@repo/ui/icons";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import type { ClusterCapabilities, ServerCluster, ComputeCluster } from "@repo/contracts";
import {
  managedNetworkUnsettled,
  networkMemberProvider,
  nativeNetworkSource,
  type ClusterSpeedTest,
} from "@repo/core";
import { PageContainer } from "@/components/ui/PageContainer";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/Modal";
import { Tabs } from "@/components/ui/Tabs";
import { BlurIp } from "@/components/BlurIp";
import { useI18n, interpolate } from "@/components/i18n-provider";
import { usePlatform } from "@/context/PlatformContext";
import { getApiErrorMessage } from "@/lib/api";
import { computeClustersApi } from "@/lib/api/compute-clusters";
import { privateNetworksApi } from "@/lib/api/private-networks";
import { randomUUID } from "@/lib/random-uuid";
import { NetworkStatus } from "./NetworkStatus";
import { clusterStatus, PROVIDER_COLORS } from "./model";
import { useRunEvents } from "@/hooks/useRunEvents";
import { NetworkStreamNotice } from "./NetworkStreamNotice";
import { ClusterNetworkDiagnostics } from "./ClusterNetworkDiagnostics";
import { NetworkSource } from "./NetworkSource";

export function NetworkDetail({ id }: { id: string }) {
  const { t } = useI18n();
  const c = t.servers.networks;
  const router = useRouter();
  const params = useSearchParams();
  const { selfHosted, deployMode } = usePlatform();
  const eligible = selfHosted && deployMode !== "cloud";
  const [cluster, setCluster] = useState<ServerCluster | null>(null);
  const [references, setReferences] = useState<ComputeCluster[]>([]);
  const [capabilities, setCapabilities] = useState<ClusterCapabilities | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [removing, setRemoving] = useState(false);
  const [busy, setBusy] = useState(false);
  const removalRequest = useRef<{ key: string; id: string } | null>(null);
  const removalPending = useRef(false);
  const alive = useRef(true);
  const tab = params.get("tab") === "members" ? "members" : "network";
  const overviewHref = "/servers?tab=networking";
  const refresh = useCallback(async () => {
    try {
      const [next, caps, groups] = await Promise.all([
        privateNetworksApi.get(id),
        privateNetworksApi.capabilities(),
        computeClustersApi.list(),
      ]);
      if (alive.current) {
        setCluster(next);
        setReferences(groups.filter((group) => group.networkId === id));
        setCapabilities(caps);
        setError(null);
      }
    } catch (err) {
      if (alive.current) setError(getApiErrorMessage(err));
    }
  }, [id]);
  useEffect(() => {
    alive.current = true;
    if (eligible) void refresh();
    return () => {
      alive.current = false;
    };
  }, [refresh, eligible]);
  const stream = useRunEvents<{ networks: ServerCluster[]; computeClusters: ComputeCluster[] }>(
    eligible && cluster?.id === id ? "system/networks/stream" : null,
    (snapshot) => {
      const next = snapshot.networks.find((item) => item.id === id);
      if (next) {
        setCluster(next);
        setReferences(snapshot.computeClusters.filter((group) => group.networkId === id));
      } else router.replace(overviewHref);
    },
  );

  const verify = async (speedTest?: ClusterSpeedTest) => {
    if (!cluster || !capabilities?.canManage || busy) return;
    setBusy(true);
    setError(null);
    try {
      const verification = await privateNetworksApi.verify(cluster, speedTest);
      setCluster((old) => old && { ...old, verification });
    } catch (err) {
      setError(getApiErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    if (!cluster || busy || removalPending.current || !capabilities?.canManage || references.length)
      return;
    if (cluster.operation && managedNetworkUnsettled(cluster.operation.status)) {
      router.push(`/servers/networks/operations/${cluster.operation.id}`);
      return;
    }
    removalPending.current = true;
    setBusy(true);
    setError(null);
    try {
      if (cluster.network.mode === "wireguard") {
        const key = `${cluster.id}:${cluster.revision}`;
        if (removalRequest.current?.key !== key) removalRequest.current = { key, id: randomUUID() };
        const operation = await privateNetworksApi.planManaged({
          requestId: removalRequest.current.id,
          clusterId: cluster.id,
          revision: cluster.revision,
          intent: "remove",
          name: cluster.name,
          location: cluster.location ?? undefined,
          members: cluster.members.map((member) => ({
            serverId: member.serverId,
            providerId: member.providerId,
            endpoint: member.endpoint,
            listenPort: member.listenPort,
          })),
        });
        router.push(`/servers/networks/operations/${operation.id}`);
        return;
      }
      await privateNetworksApi.remove(cluster);
      router.push(overviewHref);
    } catch (err) {
      setError(getApiErrorMessage(err));
      setRemoving(false);
    } finally {
      removalPending.current = false;
      setBusy(false);
    }
  };

  if (!eligible)
    return (
      <PageContainer>
        <p className="rounded-xl bg-muted p-6 text-sm text-muted-foreground">{c.selfHostedOnly}</p>
      </PageContainer>
    );
  const running = cluster ? clusterStatus(cluster) === "checking" : false;
  const unsettled = !!cluster?.operation && managedNetworkUnsettled(cluster.operation.status);
  const report = unsettled ? cluster?.operation?.report : cluster?.verification?.report;
  const checks = report?.peers ?? [];
  const networkMembers = cluster
    ? cluster.members.map((member) =>
        cluster.network.mode === "native"
          ? { ...member, providerId: networkMemberProvider(cluster.network, member) }
          : member,
      )
    : [];
  return (
    <PageContainer>
      <Link
        href={overviewHref}
        className="mb-5 inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground"
      >
        <UiIcon name="arrow-left" className="size-4" />
        {c.networkGroups.back}
      </Link>
      <NetworkStreamNotice stream={stream} />
      {error && (
        <div
          role="alert"
          className="mb-5 flex items-center justify-between gap-3 rounded-xl bg-danger/10 p-4 text-sm text-danger"
        >
          <span>{error}</span>
          <button type="button" className="shrink-0 underline" onClick={() => void refresh()}>
            {c.retry}
          </button>
        </div>
      )}
      {!cluster && !error && (
        <UiIcon name="spinner" className="mx-auto my-20 size-6 animate-spin text-muted-foreground" />
      )}
      {cluster && (
        <>
          <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
            <div className="flex items-center gap-3">
              <div className="grid size-12 place-items-center rounded-xl bg-primary/10 text-primary">
                <UiIcon name="network" className="size-6" />
              </div>
              <div>
                <h1 className="text-2xl font-semibold tracking-tight">{cluster.name}</h1>
                <p className="mt-1 text-sm text-muted-foreground">
                  {cluster.location || c.noLocation} ·{" "}
                  {interpolate(c.memberCount, { count: String(cluster.members.length) })}
                </p>
              </div>
            </div>
            {capabilities?.canManage && (
              <div className="flex max-w-full flex-wrap items-center gap-2">
                <button
                  type="button"
                  disabled={running || busy || unsettled}
                  aria-label={c.editCluster}
                  onClick={() => router.push(`/servers/networks/${id}/edit`)}
                  className="rounded-lg border border-border p-2.5 text-muted-foreground hover:bg-muted disabled:opacity-40"
                >
                  <UiIcon name="sliders" className="size-4" />
                </button>
                <Button
                  type="button"
                  variant="ghost"
                  disabled={running || busy || references.length > 0}
                  title={
                    references.length
                      ? c.inUseBy
                      : unsettled
                        ? c.managed.cleanupBeforeRemove
                        : undefined
                  }
                  onClick={() =>
                    cluster.network.mode === "wireguard" ? void remove() : setRemoving(true)
                  }
                  className="h-auto min-h-10 whitespace-normal py-2.5 hover:bg-danger/10 hover:text-danger"
                >
                  <UiIcon name="trash" className="size-4" />
                  {unsettled && cluster.operation?.plan.baseRevision === null
                    ? c.managed.cleanupSetup
                    : c.removeCluster}
                </Button>
                <button
                  type="button"
                  disabled={running || busy || unsettled}
                  onClick={() => void verify()}
                  className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground disabled:opacity-50"
                >
                  {running || busy ? (
                    <UiIcon name="spinner" className="size-4 animate-spin" />
                  ) : (
                    <UiIcon name="play" className="size-4" />
                  )}
                  {c.verify}
                </button>
              </div>
            )}
          </div>
          {cluster.operation && (
            <Link
              href={`/servers/networks/operations/${cluster.operation.id}`}
              className="mb-5 flex flex-wrap items-center justify-between gap-3 rounded-xl bg-primary/5 p-4 text-sm text-primary"
            >
              <span>{c.managed.status[cluster.operation.status]}</span>
              <span className="font-medium">{c.managed.viewOperation} →</span>
            </Link>
          )}
          {unsettled && !running && (
            <p className="mb-5 text-sm leading-relaxed text-muted-foreground">
              {c.managed.cleanupBeforeRemove}
            </p>
          )}
          <div className="mb-6 grid gap-3 sm:grid-cols-3">
            <div className="rounded-xl border border-border bg-card p-4">
              <p className="mb-2 text-xs text-muted-foreground">{c.networkStatus}</p>
              <NetworkStatus cluster={cluster} />
              <p className="mt-2 text-xs text-muted-foreground">
                {cluster.verification?.finishedAt
                  ? new Date(cluster.verification.finishedAt).toLocaleString()
                  : c.notChecked}
              </p>
            </div>
            <div className="rounded-xl border border-border bg-card p-4">
              <p className="mb-2 text-xs text-muted-foreground">{c.addressRanges}</p>
              <p className="break-words font-mono text-sm">
                <BlurIp>{cluster.network.cidrs.join(", ")}</BlurIp>
              </p>
              <div className="mt-2">
                <NetworkSource cluster={cluster} />
              </div>
            </div>
            <div className="rounded-xl border border-border bg-card p-4">
              <p className="mb-2 text-xs text-muted-foreground">{c.privateConnections}</p>
              <p className="text-sm font-medium tabular-nums">
                {checks.filter((p) => p.tcp && p.udp && p.mtu).length} /{" "}
                {cluster.members.length * (cluster.members.length - 1)}
              </p>
              <p className="mt-2 text-xs text-muted-foreground">{c.bothDirections}</p>
            </div>
          </div>
          {!!references.length && (
            <div className="mb-5 flex flex-wrap items-center gap-3 rounded-xl bg-card p-4 text-sm">
              <span className="text-muted-foreground">{c.inUseBy}</span>
              {references.map((group) => (
                <Link
                  key={group.id}
                  href={`/servers/clusters/${encodeURIComponent(group.id)}`}
                  className="font-medium text-primary hover:underline"
                >
                  {group.name}
                </Link>
              ))}
            </div>
          )}
          {capabilities?.canManage && !unsettled && (
            <div className="mb-5">
              <Button asChild variant="secondary">
                <Link href={`/servers/clusters/new?networkId=${encodeURIComponent(id)}`}>
                  <UiIcon name="cluster" className="size-4" />
                  {t.servers.clusters.createCluster}
                </Link>
              </Button>
            </div>
          )}
          <Tabs
            value={tab}
            onChange={(next) => {
              const query = new URLSearchParams({ tab: next });
              router.replace(`/servers/networks/${id}?${query}`);
            }}
            tabs={[
              { key: "network", label: c.diagnostics.topologyTab, icon: "network" },
              { key: "members", label: c.members, icon: "server" },
            ]}
            className="mb-5"
          />
          {running && (
            <div
              role="status"
              className="mb-5 flex items-center gap-3 rounded-xl bg-primary/5 p-4 text-sm"
            >
              <UiIcon name="spinner" className="size-4 animate-spin text-primary" />
              <span>
                {report?.stage === "inspecting"
                  ? c.inspectingHosts
                  : report?.stage === "handshakes"
                    ? c.diagnostics.checkingHandshakes
                    : report?.stage === "throughput"
                      ? c.diagnostics.speedRunning
                      : c.probingPeers}
              </span>
            </div>
          )}
          {cluster.verification?.error && (
            <p className="mb-5 rounded-xl bg-warning/10 p-4 text-sm text-warning">
              {cluster.verification.error}
            </p>
          )}
          {tab === "members" && (
            <div className="grid gap-4 lg:grid-cols-2 xl:grid-cols-3">
              {networkMembers.map((member) => {
                const hostCheck = report?.hosts.find((h) => h.serverId === member.serverId);
                return (
                  <div
                    key={member.serverId}
                    className="rounded-xl border border-border bg-card p-5"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex min-w-0 items-center gap-2">
                        <UiIcon name="server" className="size-4 shrink-0 text-muted-foreground" />
                        <Link
                          href={`/servers/${member.serverId}`}
                          className="truncate font-medium hover:text-primary"
                        >
                          {member.name}
                        </Link>
                      </div>
                      {member.providerId !== "custom" && (
                        <span
                          className={`shrink-0 rounded-md px-2 py-1 text-[10px] font-medium ${PROVIDER_COLORS[member.providerId]}`}
                        >
                          {capabilities?.providers.find((p) => p.id === member.providerId)?.name ??
                            member.providerId}
                        </span>
                      )}
                    </div>
                    <dl className="mt-4 grid grid-cols-2 gap-y-2 text-xs">
                      <dt className="text-muted-foreground">{c.privateAddress}</dt>
                      <dd className="text-end font-mono">
                        <BlurIp>{member.privateIp}</BlurIp>
                      </dd>
                      <dt className="text-muted-foreground">{c.interfaceName}</dt>
                      <dd className="text-end font-mono">
                        {hostCheck?.interfaceName || member.interfaceName || c.autoDetect}
                      </dd>
                      {member.networkRef &&
                        cluster.network.mode === "native" &&
                        nativeNetworkSource(cluster).providerId === "custom" && (
                          <>
                            <dt className="text-muted-foreground">{c.networkReference}</dt>
                            <dd className="truncate text-end" title={member.networkRef}>
                              {member.networkRef}
                            </dd>
                          </>
                        )}
                    </dl>
                    <div className="mt-4 border-t border-border pt-3 text-xs text-muted-foreground">
                      {hostCheck ? (
                        <span
                          className={`flex items-start gap-1.5 ${hostCheck.ok ? "text-success" : "text-warning"}`}
                        >
                          {hostCheck.ok ? (
                            <UiIcon name="check" className="size-3.5 shrink-0" />
                          ) : (
                            <UiIcon name="alert-circle" className="size-3.5 shrink-0" />
                          )}
                          {hostCheck.ok ? c.interfaceVerified : hostCheck.message}
                        </span>
                      ) : (
                        c.notChecked
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
          {tab === "network" && (
            <div className="space-y-5">
              <div className="grid gap-4 rounded-xl border border-border bg-card p-5 text-sm sm:grid-cols-3">
                <div>
                  <p className="text-xs text-muted-foreground">{c.mtu}</p>
                  <p className="mt-1 font-medium">{cluster.network.mtu}</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">{c.probePort}</p>
                  <p className="mt-1 font-medium">{cluster.network.probePort} · TCP / UDP</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">{c.encryption}</p>
                  <p className="mt-1 font-medium">
                    {cluster.network.mode === "wireguard" ? "WireGuard" : c.externalEncryption}
                  </p>
                </div>
                <p className="text-xs leading-relaxed text-muted-foreground sm:col-span-3">
                  {c.verificationScope}
                </p>
              </div>
              <ClusterNetworkDiagnostics
                network={cluster.network}
                members={networkMembers}
                report={report}
                running={running}
                observedAt={
                  unsettled ? cluster.operation?.updatedAt : cluster.verification?.finishedAt
                }
                onSpeedTest={
                  capabilities?.canManage && !unsettled ? (pair) => void verify(pair) : undefined
                }
                speedDisabled={busy || running}
              />
            </div>
          )}
          <p className="mt-6 max-w-3xl text-xs leading-relaxed text-muted-foreground">
            {c.projectScope}
          </p>
          {removing && (
            <Modal
              isOpen
              onClose={() => setRemoving(false)}
              closable={!busy}
              width="480px"
              maxWidth="94vw"
            >
              <div
                className="p-6"
                role="dialog"
                aria-modal="true"
                aria-labelledby="remove-cluster-title"
              >
                <h2 id="remove-cluster-title" className="text-lg font-semibold">
                  {c.removeCluster}
                </h2>
                <p className="my-4 text-sm leading-relaxed text-muted-foreground">
                  {c.removeDescription}
                </p>
                <div className="flex justify-end gap-3">
                  <button
                    disabled={busy}
                    className="rounded-lg border border-border px-4 py-2 text-sm"
                    onClick={() => setRemoving(false)}
                  >
                    {c.cancel}
                  </button>
                  <button
                    disabled={busy}
                    className="inline-flex items-center gap-2 rounded-lg bg-danger px-4 py-2 text-sm text-white"
                    onClick={() => void remove()}
                  >
                    {busy && <UiIcon name="spinner" className="size-4 animate-spin" />}
                    {c.removeCluster}
                  </button>
                </div>
              </div>
            </Modal>
          )}
        </>
      )}
    </PageContainer>
  );
}
