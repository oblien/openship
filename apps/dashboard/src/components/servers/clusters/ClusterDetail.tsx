"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import {
  ArrowLeft,
  Boxes,
  Check,
  CircleAlert,
  Loader2,
  Network,
  Play,
  Server,
  Settings2,
  Trash2,
} from "lucide-react";
import type { ClusterCapabilities, ServerCluster } from "@repo/contracts";
import { PageContainer } from "@/components/ui/PageContainer";
import { Modal } from "@/components/ui/Modal";
import { Tabs } from "@/components/ui/Tabs";
import { BlurIp } from "@/components/BlurIp";
import { useI18n, interpolate } from "@/components/i18n-provider";
import { usePlatform } from "@/context/PlatformContext";
import { getApiErrorMessage } from "@/lib/api";
import { serverClustersApi } from "@/lib/api/server-clusters";
import { ClusterStatus } from "./ClusterStatus";
import { clusterStatus, PROVIDER_COLORS } from "./model";

export function ClusterDetail({ id }: { id: string }) {
  const { t } = useI18n();
  const c = t.servers.clusters;
  const router = useRouter();
  const params = useSearchParams();
  const { selfHosted, deployMode } = usePlatform();
  const eligible = selfHosted && deployMode !== "cloud";
  const [cluster, setCluster] = useState<ServerCluster | null>(null);
  const [capabilities, setCapabilities] = useState<ClusterCapabilities | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [removing, setRemoving] = useState(false);
  const [busy, setBusy] = useState(false);
  const alive = useRef(true);
  const tab = params.get("tab") === "network" ? "network" : "overview";
  const refresh = useCallback(async () => {
    try {
      const [next, caps] = await Promise.all([
        serverClustersApi.get(id),
        serverClustersApi.capabilities(),
      ]);
      if (alive.current) {
        setCluster(next);
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
  useEffect(() => {
    if (!eligible || !cluster || cluster.verification?.status !== "running") return;
    const timer = setTimeout(() => void refresh(), 2000);
    return () => clearTimeout(timer);
  }, [cluster, eligible, refresh]);

  const verify = async () => {
    if (!cluster || !capabilities?.canManage || busy) return;
    setBusy(true);
    setError(null);
    try {
      const verification = await serverClustersApi.verify(cluster);
      setCluster((old) => old && { ...old, verification });
    } catch (err) {
      setError(getApiErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    if (!cluster || busy) return;
    setBusy(true);
    try {
      await serverClustersApi.remove(cluster);
      router.push("/servers?tab=cluster");
    } catch (err) {
      setError(getApiErrorMessage(err));
      setRemoving(false);
    } finally {
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
  const report = cluster?.verification?.report;
  const checks = report?.peers ?? [];
  return (
    <PageContainer>
      <Link
        href="/servers?tab=cluster"
        className="mb-5 inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-4" />
        {c.backToClusters}
      </Link>
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
        <Loader2 className="mx-auto my-20 size-6 animate-spin text-muted-foreground" />
      )}
      {cluster && (
        <>
          <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
            <div className="flex items-center gap-3">
              <div className="grid size-12 place-items-center rounded-xl bg-primary/10 text-primary">
                <Boxes className="size-6" />
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
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  disabled={running || busy}
                  aria-label={c.editCluster}
                  onClick={() => router.push(`/servers/clusters/${id}/edit`)}
                  className="rounded-lg border border-border p-2.5 text-muted-foreground hover:bg-muted disabled:opacity-40"
                >
                  <Settings2 className="size-4" />
                </button>
                <button
                  type="button"
                  disabled={running || busy}
                  aria-label={c.removeCluster}
                  onClick={() => setRemoving(true)}
                  className="rounded-lg border border-border p-2.5 text-muted-foreground hover:bg-danger/10 hover:text-danger disabled:opacity-40"
                >
                  <Trash2 className="size-4" />
                </button>
                <button
                  type="button"
                  disabled={running || busy}
                  onClick={() => void verify()}
                  className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground disabled:opacity-50"
                >
                  {running || busy ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <Play className="size-4" />
                  )}
                  {c.verify}
                </button>
              </div>
            )}
          </div>
          <div className="mb-6 grid gap-3 sm:grid-cols-3">
            <div className="rounded-xl border border-border bg-card p-4">
              <p className="mb-2 text-xs text-muted-foreground">{c.networkStatus}</p>
              <ClusterStatus cluster={cluster} />
              <p className="mt-2 text-xs text-muted-foreground">
                {cluster.verification?.finishedAt
                  ? new Date(cluster.verification.finishedAt).toLocaleString()
                  : c.notChecked}
              </p>
            </div>
            <div className="rounded-xl border border-border bg-card p-4">
              <p className="mb-2 text-xs text-muted-foreground">{c.addressRanges}</p>
              <p className="break-words font-mono text-sm">{cluster.network.cidrs.join(", ")}</p>
              <p className="mt-2 text-xs text-muted-foreground">{c.nativeNetwork}</p>
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
          <Tabs
            value={tab}
            onChange={(next) =>
              router.replace(`/servers/clusters/${id}${next === "network" ? "?tab=network" : ""}`)
            }
            tabs={[
              { key: "overview", label: c.members, icon: Server },
              { key: "network", label: c.networkDetails, icon: Network },
            ]}
            className="mb-5"
          />
          {running && (
            <div
              role="status"
              className="mb-5 flex items-center gap-3 rounded-xl bg-primary/5 p-4 text-sm"
            >
              <Loader2 className="size-4 animate-spin text-primary" />
              <span>{report?.stage === "inspecting" ? c.inspectingHosts : c.probingPeers}</span>
            </div>
          )}
          {cluster.verification?.error && (
            <p className="mb-5 rounded-xl bg-warning/10 p-4 text-sm text-warning">
              {cluster.verification.error}
            </p>
          )}
          {tab === "overview" && (
            <div className="grid gap-4 lg:grid-cols-2 xl:grid-cols-3">
              {cluster.members.map((member) => {
                const hostCheck = report?.hosts.find((h) => h.serverId === member.serverId);
                return (
                  <div
                    key={member.serverId}
                    className="rounded-xl border border-border bg-card p-5"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex min-w-0 items-center gap-2">
                        <Server className="size-4 shrink-0 text-muted-foreground" />
                        <Link
                          href={`/servers/${member.serverId}`}
                          className="truncate font-medium hover:text-primary"
                        >
                          {member.name}
                        </Link>
                      </div>
                      <span
                        className={`shrink-0 rounded-md px-2 py-1 text-[10px] font-medium ${PROVIDER_COLORS[member.providerId]}`}
                      >
                        {member.providerId === "custom"
                          ? c.customProvider
                          : (capabilities?.providers.find((p) => p.id === member.providerId)
                              ?.name ?? member.providerId)}
                      </span>
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
                      {member.networkRef && (
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
                            <Check className="size-3.5 shrink-0" />
                          ) : (
                            <CircleAlert className="size-3.5 shrink-0" />
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
                  <p className="mt-1 font-medium">{c.externalEncryption}</p>
                </div>
                <p className="text-xs leading-relaxed text-muted-foreground sm:col-span-3">
                  {c.verificationScope}
                </p>
              </div>
              <div className="overflow-x-auto rounded-xl border border-border bg-card">
                <table className="w-full text-sm">
                  <thead className="bg-muted/40 text-xs text-muted-foreground">
                    <tr>
                      {[c.source, c.destination, "TCP", "UDP", "MTU"].map((label) => (
                        <th key={label} className="px-4 py-3 text-start font-medium">
                          {label}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {checks.map((peer) => (
                      <tr key={`${peer.sourceServerId}:${peer.targetServerId}`}>
                        <td className="px-4 py-3">
                          {cluster.members.find((m) => m.serverId === peer.sourceServerId)?.name}
                        </td>
                        <td className="px-4 py-3">
                          {cluster.members.find((m) => m.serverId === peer.targetServerId)?.name}
                        </td>
                        {[peer.tcp, peer.udp, peer.mtu].map((ok, index) => (
                          <td key={index} className="px-4 py-3">
                            <span
                              className={`inline-flex items-center gap-1.5 text-xs ${ok ? "text-success" : "text-warning"}`}
                              title={peer.message ?? undefined}
                            >
                              {ok ? (
                                <Check className="size-3.5" />
                              ) : (
                                <CircleAlert className="size-3.5" />
                              )}
                              {ok ? c.passed : c.failed}
                            </span>
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
                {!checks.length && (
                  <p className="px-4 py-8 text-center text-sm text-muted-foreground">
                    {c.noPeerChecks}
                  </p>
                )}
              </div>
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
                    {busy && <Loader2 className="size-4 animate-spin" />}
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
