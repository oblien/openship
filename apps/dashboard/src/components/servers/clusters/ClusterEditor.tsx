"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, Boxes, Loader2, Network, Plus, Server } from "lucide-react";
import type { ClusterCapabilities, ComputeCluster, PrivateNetwork } from "@repo/contracts";
import { managedNetworkUnsettled } from "@repo/core";
import { useI18n, interpolate } from "@/components/i18n-provider";
import { PageContainer } from "@/components/ui/PageContainer";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/Checkbox";
import { CustomSelect } from "@/components/ui/CustomSelect";
import { BlurIp } from "@/components/BlurIp";
import { usePlatform } from "@/context/PlatformContext";
import { getApiErrorMessage } from "@/lib/api";
import { privateNetworksApi } from "@/lib/api/private-networks";
import { computeClustersApi } from "@/lib/api/compute-clusters";
import { randomUUID } from "@/lib/random-uuid";
import { NetworkStatus } from "./NetworkStatus";
import { NetworkDiagnosticText } from "./NetworkSetupProgress";

interface EditorData {
  capabilities: ClusterCapabilities;
  networks: PrivateNetwork[];
  clusters: ComputeCluster[];
  initial?: ComputeCluster;
}

/** Compute-only editor. Network creation, attachment and diagnostics have their own routes. */
export function ClusterEditor({ id, networkId }: { id?: string; networkId?: string }) {
  const { t } = useI18n();
  const c = t.servers.clusters;
  const { selfHosted, deployMode } = usePlatform();
  const eligible = selfHosted && deployMode !== "cloud";
  const [data, setData] = useState<EditorData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    setData(null);
    setError(null);
    if (eligible)
      void (async () => {
        try {
          const capabilities = await privateNetworksApi.capabilities();
          const [networks, clusters, initial] =
            capabilities.available && capabilities.canManage
              ? await Promise.all([
                  privateNetworksApi.list(),
                  computeClustersApi.list(),
                  id ? computeClustersApi.get(id) : Promise.resolve(undefined),
                ])
              : [[], [], undefined];
          if (active) setData({ capabilities, networks, clusters, initial });
        } catch (err) {
          if (active) setError(getApiErrorMessage(err));
        }
      })();
    return () => {
      active = false;
    };
  }, [id, eligible, attempt]);
  const unavailable =
    !eligible || (data && !data.capabilities.available)
      ? c.selfHostedOnly
      : data && !data.capabilities.canManage
        ? c.managePermissionRequired
        : null;
  return (
    <PageContainer>
      <Link
        href={id ? `/servers/clusters/${encodeURIComponent(id)}` : "/servers?tab=cluster"}
        className="mb-5 inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-4 rtl:rotate-180" />
        {c.backToClusters}
      </Link>
      <h1 className="text-2xl font-semibold tracking-tight">
        {id ? c.editCluster : c.createCluster}
      </h1>
      <p className="mt-2 text-sm text-muted-foreground">{c.setupHint}</p>
      {unavailable ? (
        <p className="mt-6 rounded-xl bg-muted/50 p-5 text-sm text-muted-foreground">
          {unavailable}
        </p>
      ) : error ? (
        <div role="alert" className="mt-6 rounded-xl bg-danger/10 p-4 text-sm text-danger">
          {error}
          <Button variant="ghost" onClick={() => setAttempt((value) => value + 1)}>
            {c.retry}
          </Button>
        </div>
      ) : data ? (
        <ClusterForm key={`${id ?? "new"}:${attempt}`} data={data} networkId={networkId} />
      ) : (
        <Loader2 className="mx-auto my-16 size-5 animate-spin text-muted-foreground" />
      )}
    </PageContainer>
  );
}

function ClusterForm({ data, networkId }: { data: EditorData; networkId?: string }) {
  const { t } = useI18n();
  const c = t.servers.clusters;
  const n = t.servers.networks;
  const router = useRouter();
  const [name, setName] = useState(data.initial?.name ?? "");
  const [location, setLocation] = useState(data.initial?.location ?? "");
  const [selectedNetwork, setSelectedNetwork] = useState(
    data.initial?.networkId ?? networkId ?? "",
  );
  const occupied = new Set(
    data.clusters
      .filter((cluster) => cluster.id !== data.initial?.id)
      .flatMap((cluster) => cluster.serverIds),
  );
  const available = (id: string) =>
    data.networks
      .find((network) => network.id === id)
      ?.members.filter((member) => !occupied.has(member.serverId))
      .map((member) => member.serverId) ?? [];
  const [selected, setSelected] = useState(data.initial?.serverIds ?? available(selectedNetwork));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const request = useRef<{ fingerprint: string; id: string } | null>(null);
  const network = data.networks.find((item) => item.id === selectedNetwork);
  const networkBusy = !!network?.operation && managedNetworkUnsettled(network.operation.status);
  const valid =
    !!name.trim() &&
    !!network &&
    selected.length > 0 &&
    selected.every(
      (id) => network.members.some((member) => member.serverId === id) && !occupied.has(id),
    ) &&
    !networkBusy;
  const save = async () => {
    if (!valid || busy || pending.current) return;
    pending.current = true;
    setBusy(true);
    setError(null);
    try {
      const input = {
        name: name.trim(),
        location: location.trim() || undefined,
        networkId: selectedNetwork,
        serverIds: [...selected].sort(),
      };
      const fingerprint = JSON.stringify(input);
      if (request.current?.fingerprint !== fingerprint)
        request.current = { fingerprint, id: randomUUID() };
      const saved = data.initial
        ? await computeClustersApi.update({
            ...input,
            clusterId: data.initial.id,
            revision: data.initial.revision,
          })
        : await computeClustersApi.create({ ...input, requestId: request.current.id });
      router.replace(`/servers/clusters/${encodeURIComponent(saved.id)}`);
    } catch (err) {
      setError(getApiErrorMessage(err));
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };
  return (
    <div className="@container/cluster-editor mt-6">
      <div className="grid grid-cols-1 items-start gap-6 @4xl/cluster-editor:grid-cols-[minmax(0,1fr)_320px]">
        <div className="min-w-0 space-y-5">
          <div className="space-y-6 rounded-2xl bg-card p-5 sm:p-7">
            <div className="grid grid-cols-1 gap-5 @2xl/cluster-editor:grid-cols-2">
              <label className="min-w-0 space-y-2 text-sm font-medium">
                <span>{c.name}</span>
                <Input
                  variant="filled"
                  value={name}
                  maxLength={100}
                  placeholder={c.namePlaceholder}
                  onChange={(event) => setName(event.target.value)}
                  disabled={busy}
                />
              </label>
              <label className="min-w-0 space-y-2 text-sm font-medium">
                <span>{c.location}</span>
                <Input
                  variant="filled"
                  value={location}
                  maxLength={100}
                  placeholder={c.locationPlaceholder}
                  onChange={(event) => setLocation(event.target.value)}
                  disabled={busy}
                />
              </label>
            </div>
            <div className="space-y-2">
              <label htmlFor="cluster-network" className="text-sm font-medium">
                {c.chooseNetwork}
              </label>
              <CustomSelect
                id="cluster-network"
                value={selectedNetwork}
                variant="filled"
                placeholder={c.chooseNetwork}
                disabled={busy || !data.networks.length}
                options={data.networks.map((item) => ({
                  value: item.id,
                  label: item.name,
                  icon: <Network className="size-4 text-info" />,
                  description: interpolate(n.memberCount, { count: String(item.members.length) }),
                }))}
                onChange={(id) => {
                  setSelectedNetwork(id);
                  setSelected(available(id));
                  setError(null);
                }}
              />
              <p className="text-xs leading-relaxed text-muted-foreground">{c.networkHelp}</p>
              <div className="flex flex-wrap gap-4 pt-1 text-xs font-medium text-primary">
                {network && (
                  <Link
                    href={`/servers/networks/${encodeURIComponent(network.id)}`}
                    className="inline-flex items-center gap-1.5"
                  >
                    <Network className="size-3.5" />
                    {c.manageNetwork}
                  </Link>
                )}
                <Link href="/servers/networks/new" className="inline-flex items-center gap-1.5">
                  <Plus className="size-3.5" />
                  {c.createNetwork}
                </Link>
              </div>
            </div>
          </div>
          {network && (
            <section
              className="rounded-2xl bg-card p-5 sm:p-7"
              aria-labelledby="cluster-members-title"
            >
              <h2 id="cluster-members-title" className="text-base font-semibold">
                {c.members}
              </h2>
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{c.membersHint}</p>
              <div className="mt-5 divide-y divide-border/50">
                {network.members.map((member) => {
                  const used = occupied.has(member.serverId);
                  return (
                    <label
                      key={member.serverId}
                      className={`flex items-center gap-3 py-4 ${used ? "opacity-50" : "cursor-pointer"}`}
                    >
                      <Checkbox
                        checked={selected.includes(member.serverId)}
                        disabled={busy || used || networkBusy}
                        aria-label={member.name}
                        onCheckedChange={(checked) =>
                          setSelected((current) =>
                            checked
                              ? [...new Set([...current, member.serverId])]
                              : current.filter((id) => id !== member.serverId),
                          )
                        }
                      />
                      <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-muted/40 text-muted-foreground">
                        <Server className="size-4" />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
                          <NetworkDiagnosticText value={member.name} />
                          <span aria-hidden="true" className="h-3 w-px bg-border" />
                          <span className="font-mono text-xs text-muted-foreground">
                            <BlurIp>{member.privateIp}</BlurIp>
                          </span>
                        </span>
                        {used && (
                          <span className="mt-1 block text-xs text-muted-foreground">
                            {c.alreadyMember}
                          </span>
                        )}
                      </span>
                    </label>
                  );
                })}
              </div>
            </section>
          )}
        </div>
        <aside className="min-w-0 space-y-5 rounded-2xl bg-card p-5 @4xl/cluster-editor:sticky @4xl/cluster-editor:top-6">
          <div className="flex items-center gap-2 text-sm font-semibold">
            <Boxes className="size-4 text-primary" />
            {name || c.createCluster}
          </div>
          <p className="text-sm text-muted-foreground">
            {interpolate(selected.length === 1 ? c.memberCountOne : c.memberCount, {
              count: String(selected.length),
            })}
          </p>
          {network && (
            <div className="space-y-2 text-sm">
              <p>{network.name}</p>
              <NetworkStatus cluster={network} />
            </div>
          )}
          {networkBusy && (
            <p role="status" className="text-xs leading-relaxed text-warning">
              {c.networkBusy}
            </p>
          )}
          {error && (
            <p role="alert" className="text-sm text-danger">
              {error}
            </p>
          )}
          <Button
            className="h-auto min-h-10 w-full whitespace-normal py-2"
            disabled={!valid || busy}
            onClick={() => void save()}
          >
            {busy && <Loader2 className="size-4 animate-spin" />}
            {data.initial ? c.save : c.createCluster}
          </Button>
          <Button asChild variant="ghost" className="w-full">
            <Link
              href={data.initial ? `/servers/clusters/${data.initial.id}` : "/servers?tab=cluster"}
            >
              {c.cancel}
            </Link>
          </Button>
        </aside>
      </div>
    </div>
  );
}
