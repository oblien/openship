"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, Check, Loader2, Network, Plus, Search, Server } from "lucide-react";
import type { ClusterCapabilities, ServerCluster } from "@repo/contracts";
import {
  isInfrastructurePrivateIp,
  privateHostInterfaces,
  validateNativeCluster,
  type ClusterMemberConfig,
  type NetworkHostObservation,
} from "@repo/core";
import { BlurIp } from "@/components/BlurIp";
import { useI18n, interpolate } from "@/components/i18n-provider";
import { useToast } from "@/components/toast";
import { useAddServerModal } from "@/components/servers/add-server-modal";
import { InfrastructureProviderSelect } from "@/components/servers/InfrastructureProviderSelect";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/Checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { getApiErrorMessage, systemApi } from "@/lib/api";
import type { ServerInfo } from "@/lib/api/system";
import { serverClustersApi } from "@/lib/api/server-clusters";
import { randomUUID } from "@/lib/random-uuid";
import { clusterConfig } from "./model";

export function ClusterWizard({
  capabilities,
  initial,
  onCancel,
  onSaved,
}: {
  capabilities: ClusterCapabilities;
  initial?: ServerCluster;
  onCancel(): void;
  onSaved(cluster: ServerCluster): void;
}) {
  const { t } = useI18n();
  const c = t.servers.clusters;
  const { toast } = useToast();
  const addServer = useAddServerModal();
  // Capture the revision with the draft. Background refreshes must never rebase it silently.
  const [baseline] = useState(initial);
  const [draft, setDraft] = useState(() => clusterConfig(initial));
  const [ranges, setRanges] = useState(() => initial?.network.cidrs.join(", ") ?? "");
  const [step, setStep] = useState(0);
  const [servers, setServers] = useState<ServerInfo[]>([]);
  const [occupied, setOccupied] = useState(new Set<string>());
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [inspections, setInspections] = useState<Record<string, NetworkHostObservation>>({});
  const [inspecting, setInspecting] = useState<string | null>(null);
  const requestId = useRef(randomUUID());
  const steps = [c.stepCluster, c.stepNetwork, c.stepReview];
  const stepHeading = useRef<HTMLHeadingElement>(null);
  const errorMessage = useRef<HTMLDivElement>(null);
  const previousStep = useRef(step);

  useEffect(() => {
    if (previousStep.current === step) return;
    previousStep.current = step;
    stepHeading.current?.focus({ preventScroll: true });
    stepHeading.current?.scrollIntoView({ block: "start" });
  }, [step]);

  useEffect(() => {
    if (!error) return;
    errorMessage.current?.focus({ preventScroll: true });
    errorMessage.current?.scrollIntoView({ block: "nearest" });
  }, [error]);

  useEffect(() => {
    let active = true;
    void Promise.all([systemApi.listServers(), serverClustersApi.list()])
      .then(([rows, clusters]) => {
        if (!active) return;
        setServers(rows);
        setOccupied(
          new Set(
            clusters
              .filter((cluster) => cluster.id !== baseline?.id)
              .flatMap((cluster) => cluster.members.map((m) => m.serverId)),
          ),
        );
      })
      .catch((err) => {
        if (active) setError(getApiErrorMessage(err));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [baseline?.id]);

  const memberLabel = (id: string) => {
    const server = servers.find((s) => s.id === id);
    const name =
      server?.name ||
      server?.sshHost ||
      baseline?.members.find((m) => m.serverId === id)?.name ||
      id;
    return (
      <span className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
        {name !== server?.sshHost && <span className="truncate font-medium">{name}</span>}
        {server?.sshHost && (
          <span className="inline-flex min-w-0 max-w-full items-center gap-2 font-mono text-xs font-normal text-muted-foreground">
            {name !== server.sshHost && (
              <span aria-hidden="true" className="h-3 w-px shrink-0 bg-border" />
            )}
            <span dir="ltr" className="truncate">
              <BlurIp>{server.sshHost}</BlurIp>
            </span>
          </span>
        )}
      </span>
    );
  };
  const updateMember = (id: string, changes: Partial<ClusterMemberConfig>) => {
    setDraft((old) => ({
      ...old,
      members: old.members.map((m) => (m.serverId === id ? { ...m, ...changes } : m)),
    }));
    setError(null);
  };
  const selectServer = (id: string) =>
    setDraft((old) => ({
      ...old,
      members: old.members.some((m) => m.serverId === id)
        ? old.members.filter((m) => m.serverId !== id)
        : [...old.members, { serverId: id, providerId: "custom", privateIp: "" }],
    }));
  const config = () => ({
    ...draft,
    network: {
      ...draft.network,
      cidrs: ranges
        .trim()
        .split(/[\s,]+/)
        .filter(Boolean),
    },
  });

  const inspect = async (id: string) => {
    setInspecting(id);
    setError(null);
    try {
      const observed = await serverClustersApi.inspect(id);
      setInspections((old) => ({ ...old, [id]: observed }));
      const choices = privateHostInterfaces(observed.interfaces).flatMap((n) =>
        n.addresses
          .filter((a) => isInfrastructurePrivateIp(a.address))
          .map((a) => ({ interfaceName: n.name, privateIp: a.address })),
      );
      if (choices.length === 1) updateMember(id, choices[0]!);
      if (!choices.length) setError(c.noPrivateInterface);
    } catch (err) {
      setError(getApiErrorMessage(err));
    } finally {
      setInspecting(null);
    }
  };

  const next = () => {
    setError(null);
    if (
      step === 0 &&
      (!draft.name.trim() ||
        draft.members.length < 2 ||
        draft.members.length > capabilities.maxMembers)
    ) {
      setError(interpolate(c.chooseMembers, { max: String(capabilities.maxMembers) }));
      return;
    }
    if (step === 1) {
      try {
        validateNativeCluster(config());
      } catch (err) {
        setError(err instanceof Error ? err.message : c.invalidConfig);
        return;
      }
    }
    setStep((old) => old + 1);
  };

  const save = async () => {
    if (!capabilities.canManage || saving) return;
    setSaving(true);
    setError(null);
    let saved: ServerCluster | null = null;
    try {
      const value = config();
      validateNativeCluster(value);
      saved = baseline
        ? await serverClustersApi.update({
            ...value,
            clusterId: baseline.id,
            revision: baseline.revision,
          })
        : await serverClustersApi.create({ ...value, requestId: requestId.current });
      const verification = await serverClustersApi.verify(saved);
      onSaved({ ...saved, verification });
    } catch (err) {
      if (saved) {
        toast("error", `${c.savedCheckFailed} ${getApiErrorMessage(err)}`);
        onSaved(saved);
      } else setError(getApiErrorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="@container/cluster-setup" aria-labelledby="cluster-wizard-title">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={onCancel}
        disabled={saving}
        className="mb-5 max-w-full justify-start px-0 text-sm font-normal hover:bg-transparent"
      >
        <ArrowLeft className="size-4 shrink-0 rtl:rotate-180" />
        <span className="truncate">{baseline?.name || c.backToClusters}</span>
      </Button>
      <h1 id="cluster-wizard-title" className="text-2xl font-semibold tracking-tight">
        {baseline ? c.editCluster : c.createCluster}
      </h1>
      <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted-foreground">
        {c.wizardDescription}
      </p>
      <div className="mt-6 grid grid-cols-1 items-start gap-6 @4xl/cluster-setup:grid-cols-[minmax(0,1fr)_340px]">
        <div className="@container/cluster-form min-w-0 rounded-2xl bg-card p-5 sm:p-7">
          <h2
            ref={stepHeading}
            tabIndex={-1}
            className="mb-6 scroll-mt-6 text-lg font-semibold outline-none"
          >
            {steps[step]}
          </h2>
          {error && (
            <div
              ref={errorMessage}
              role="alert"
              tabIndex={-1}
              className="mb-4 scroll-mt-6 rounded-lg bg-danger/10 p-3 text-sm text-danger outline-none"
            >
              {error}
            </div>
          )}

          {step === 0 && (
            <div className="space-y-5">
              <div className="grid gap-4 @md/cluster-form:grid-cols-2">
                <Label>
                  {c.name}
                  <Input
                    variant="filled"
                    autoFocus
                    className="mt-1.5"
                    maxLength={100}
                    placeholder={c.namePlaceholder}
                    value={draft.name}
                    onChange={(e) => setDraft((old) => ({ ...old, name: e.target.value }))}
                  />
                </Label>
                <Label>
                  {c.location}
                  <Input
                    variant="filled"
                    className="mt-1.5"
                    maxLength={100}
                    placeholder={c.locationPlaceholder}
                    value={draft.location}
                    onChange={(e) => setDraft((old) => ({ ...old, location: e.target.value }))}
                  />
                </Label>
              </div>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <p className="text-sm font-medium">
                  {c.selectServers}{" "}
                  <span className="ms-1 text-muted-foreground">
                    {draft.members.length}/{capabilities.maxMembers}
                  </span>
                </p>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    addServer((server) => {
                      setServers((old) => [...old.filter((s) => s.id !== server.id), server]);
                      if (draft.members.length < capabilities.maxMembers) selectServer(server.id);
                    })
                  }
                >
                  <Plus className="size-3.5" />
                  {t.servers.list.addServer}
                </Button>
              </div>
              {loading ? (
                <Loader2 className="mx-auto my-8 size-5 animate-spin" />
              ) : (
                <div className="grid gap-3 @md/cluster-form:grid-cols-2">
                  {servers.map((server) => {
                    const selected = draft.members.some((m) => m.serverId === server.id);
                    const unavailable =
                      occupied.has(server.id) ||
                      (!selected && draft.members.length >= capabilities.maxMembers);
                    return (
                      <label
                        key={server.id}
                        className={`flex cursor-pointer items-center gap-3 rounded-xl p-3 transition-colors ${selected ? "bg-primary/10" : "bg-muted/40 hover:bg-muted/60"} ${unavailable ? "cursor-not-allowed opacity-50" : ""}`}
                      >
                        <Checkbox
                          checked={selected}
                          disabled={unavailable}
                          onCheckedChange={() => selectServer(server.id)}
                          aria-label={server.name || server.sshHost}
                        />
                        <Server className="size-4 shrink-0 text-muted-foreground" />
                        <span className="min-w-0 flex-1 text-sm">
                          {memberLabel(server.id)}
                          {occupied.has(server.id) && (
                            <span className="block truncate text-xs text-muted-foreground">
                              {c.alreadyMember}
                            </span>
                          )}
                        </span>
                      </label>
                    );
                  })}
                  {!servers.length && (
                    <p className="col-span-full py-4 text-sm text-muted-foreground">
                      {c.addServersFirst}
                    </p>
                  )}
                </div>
              )}
            </div>
          )}

          {step === 1 && (
            <div className="space-y-5">
              <div className="flex items-start gap-3 rounded-xl bg-muted/50 p-4">
                <Network className="mt-0.5 size-5 shrink-0 text-primary" />
                <div>
                  <p className="text-sm font-medium">{c.nativeNetwork}</p>
                  <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
                    {c.prepareNetwork}
                  </p>
                </div>
              </div>
              <Label className="block">
                {c.addressRanges}
                <Input
                  variant="filled"
                  className="mt-1.5"
                  placeholder="10.20.0.0/24, 10.30.0.0/24"
                  value={ranges}
                  onChange={(e) => setRanges(e.target.value)}
                />
                <span className="mt-1 block text-xs font-normal text-muted-foreground">
                  {c.addressRangesHint}
                </span>
              </Label>
              <div className="space-y-3">
                {draft.members.map((member) => {
                  const provider = capabilities.providers.find((p) => p.id === member.providerId);
                  const observed = inspections[member.serverId];
                  const choices = privateHostInterfaces(observed?.interfaces ?? []).flatMap((n) =>
                    n.addresses
                      .filter((a) => isInfrastructurePrivateIp(a.address))
                      .map((a) => ({ address: a.address, nic: n.name })),
                  );
                  return (
                    <div key={member.serverId} className="rounded-xl bg-muted/40 p-4">
                      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
                        <p className="flex min-w-0 items-center gap-2 text-sm font-medium">
                          <Server className="size-4 shrink-0 text-muted-foreground" />
                          {memberLabel(member.serverId)}
                        </p>
                        <Button
                          type="button"
                          onClick={() => void inspect(member.serverId)}
                          disabled={inspecting !== null}
                          variant="outline"
                          size="sm"
                        >
                          {inspecting === member.serverId ? (
                            <Loader2 className="size-3.5 animate-spin" />
                          ) : (
                            <Search className="size-3.5" />
                          )}
                          {c.inspect}
                        </Button>
                      </div>
                      <div className="grid gap-3 @lg/cluster-form:grid-cols-2">
                        <InfrastructureProviderSelect
                          providers={capabilities.providers}
                          value={member.providerId}
                          onChange={(providerId) => updateMember(member.serverId, { providerId })}
                          disabled={saving || inspecting !== null}
                        />
                        <Label className="text-muted-foreground">
                          {c.networkReference}
                          <Input
                            variant="filled"
                            className="mt-1.5"
                            value={member.networkRef ?? ""}
                            placeholder={provider?.network}
                            maxLength={200}
                            onChange={(e) =>
                              updateMember(member.serverId, { networkRef: e.target.value })
                            }
                          />
                        </Label>
                        <Label className="text-muted-foreground">
                          {c.privateAddress}
                          <Input
                            variant="filled"
                            className="mt-1.5"
                            value={member.privateIp}
                            placeholder="10.20.0.10"
                            maxLength={15}
                            onChange={(e) =>
                              updateMember(member.serverId, { privateIp: e.target.value })
                            }
                          />
                        </Label>
                        <Label className="text-muted-foreground">
                          {c.interfaceName}
                          <Input
                            variant="filled"
                            className="mt-1.5"
                            value={member.interfaceName ?? ""}
                            placeholder={c.autoDetect}
                            maxLength={15}
                            onChange={(e) =>
                              updateMember(member.serverId, { interfaceName: e.target.value })
                            }
                          />
                        </Label>
                      </div>
                      {choices.length > 0 && (
                        <div className="mt-3 flex flex-wrap items-center gap-2">
                          <span className="text-xs text-muted-foreground">
                            {c.detectedAddresses}
                          </span>
                          {choices.map((choice) => (
                            <Button
                              type="button"
                              key={`${choice.nic}:${choice.address}`}
                              variant="secondary"
                              size="sm"
                              className="font-mono"
                              onClick={() =>
                                updateMember(member.serverId, {
                                  privateIp: choice.address,
                                  interfaceName: choice.nic,
                                })
                              }
                            >
                              {choice.address} · {choice.nic}
                            </Button>
                          ))}
                        </div>
                      )}
                      {provider?.docs && (
                        <a
                          className="mt-3 inline-flex text-xs text-primary hover:underline"
                          href={provider.docs}
                          target="_blank"
                          rel="noreferrer"
                        >
                          {c.providerGuide} ↗
                        </a>
                      )}
                    </div>
                  );
                })}
              </div>
              <details className="rounded-xl bg-muted/40 p-4">
                <summary className="cursor-pointer text-sm font-medium">{c.advancedChecks}</summary>
                <div className="mt-3 grid gap-4 @md/cluster-form:grid-cols-2">
                  <Label className="text-muted-foreground">
                    {c.mtu}
                    <Input
                      variant="filled"
                      className="mt-1.5"
                      type="number"
                      min={1280}
                      max={9000}
                      value={draft.network.mtu}
                      onChange={(e) =>
                        setDraft((old) => ({
                          ...old,
                          network: { ...old.network, mtu: Number(e.target.value) },
                        }))
                      }
                    />
                  </Label>
                  <Label className="text-muted-foreground">
                    {c.probePort}
                    <Input
                      variant="filled"
                      className="mt-1.5"
                      type="number"
                      min={1024}
                      max={65535}
                      value={draft.network.probePort}
                      onChange={(e) =>
                        setDraft((old) => ({
                          ...old,
                          network: { ...old.network, probePort: Number(e.target.value) },
                        }))
                      }
                    />
                  </Label>
                </div>
                <p className="mt-3 text-xs leading-relaxed text-muted-foreground">{c.probeHint}</p>
              </details>
            </div>
          )}

          {step === 2 && (
            <div className="space-y-4">
              <div className="rounded-xl bg-muted/40 p-4">
                <p className="font-semibold">{draft.name}</p>
                <p className="mt-1 text-sm text-muted-foreground">
                  {draft.location || c.noLocation} ·{" "}
                  {interpolate(c.memberCount, { count: String(draft.members.length) })}
                </p>
              </div>
              <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
                <dt className="text-muted-foreground">{c.nativeNetwork}</dt>
                <dd className="break-words font-mono text-xs">
                  {config().network.cidrs.join(", ")}
                </dd>
                <dt className="text-muted-foreground">{c.mtu}</dt>
                <dd>{draft.network.mtu}</dd>
                <dt className="text-muted-foreground">{c.probePort}</dt>
                <dd>{draft.network.probePort} · TCP / UDP</dd>
              </dl>
              <div className="divide-y divide-border/50 rounded-xl bg-muted/40">
                {draft.members.map((m) => (
                  <div
                    key={m.serverId}
                    className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 text-sm"
                  >
                    {memberLabel(m.serverId)}
                    <span className="font-mono text-xs text-muted-foreground">
                      {m.privateIp} · {m.interfaceName || c.autoDetect}
                    </span>
                  </div>
                ))}
              </div>
              <div className="rounded-xl bg-primary/5 p-4 text-sm leading-relaxed text-muted-foreground">
                {c.reviewEffect}
              </div>
            </div>
          )}
        </div>
        <aside
          aria-label={c.setupSteps}
          className="min-w-0 rounded-2xl bg-card @4xl/cluster-setup:sticky @4xl/cluster-setup:top-6 @4xl/cluster-setup:self-start"
        >
          <div className="px-5 py-4">
            <h2 className="text-sm font-semibold">{c.setupSteps}</h2>
          </div>
          <ol className="space-y-1 p-3" aria-label={c.setupSteps}>
            {steps.map((label, index) => (
              <li key={label} aria-current={index === step ? "step" : undefined}>
                <button
                  type="button"
                  disabled={index >= step || saving || inspecting !== null}
                  onClick={() => {
                    setError(null);
                    setStep(index);
                  }}
                  className={`flex w-full items-center gap-3 rounded-xl px-3 py-3 text-start text-sm transition-colors enabled:hover:bg-muted/60 ${index === step ? "bg-primary/5 font-medium text-foreground" : "text-muted-foreground"}`}
                >
                  <span
                    className={`grid size-7 shrink-0 place-items-center rounded-full text-xs font-medium ${index === step ? "bg-primary text-primary-foreground" : index < step ? "bg-primary/10 text-primary" : "bg-muted"}`}
                  >
                    {index < step ? <Check className="size-3.5" /> : index + 1}
                  </span>
                  <span className="min-w-0 break-words">{label}</span>
                </button>
              </li>
            ))}
          </ol>
          <div className="space-y-3 p-5">
            <Button
              type="button"
              disabled={saving || loading || inspecting !== null || !capabilities.canManage}
              onClick={() => (step < 2 ? next() : void save())}
              className="w-full"
            >
              {saving && <Loader2 className="size-4 shrink-0 animate-spin" />}
              {step < 2 ? c.continue : baseline ? c.saveAndVerify : c.createAndVerify}
              {step < 2 && <ArrowRight className="size-4 shrink-0 rtl:rotate-180" />}
            </Button>
            {step > 0 && (
              <Button
                type="button"
                variant="outline"
                className="w-full"
                disabled={saving || inspecting !== null}
                onClick={() => {
                  setError(null);
                  setStep((old) => old - 1);
                }}
              >
                <ArrowLeft className="size-4 shrink-0 rtl:rotate-180" />
                {c.back}
              </Button>
            )}
            <Button
              type="button"
              variant="ghost"
              className="w-full"
              disabled={saving}
              onClick={onCancel}
            >
              {c.cancel}
            </Button>
          </div>
        </aside>
      </div>
    </section>
  );
}
