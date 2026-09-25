"use client";

import { Icon as UiIcon } from "@repo/ui/icons";

import { useEffect, useRef, useState } from "react";
import type { ClusterCapabilities, ServerCluster } from "@repo/contracts";
import {
  ClusterConfigError,
  privateInterfaceChoices,
  selectClusterInterface,
  suggestNativeClusterConfig,
  validateNativeCluster,
  nativeNetworkSource,
  networkMemberProvider,
  retainNetworkAccess,
  type NetworkAccessPolicy,
  type ClusterMemberConfig,
  type NetworkHostObservation,
  type PrivateInterfaceChoice,
  type ManagedNetworkPreparation,
  type ManagedNetworkPreparationInput,
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
import { privateNetworksApi } from "@/lib/api/private-networks";
import { randomUUID } from "@/lib/random-uuid";
import { clusterConfig } from "./model";
import { NetworkFirewallRules } from "./NetworkFirewallRules";
import { NetworkSource } from "./NetworkSource";
import { ClusterNetworkDiagnostics } from "./ClusterNetworkDiagnostics";
import {
  NetworkFirewallConfirmation,
  useNetworkFirewallConfirmation,
} from "./NetworkFirewallConfirmation";

export function NetworkWizard({
  capabilities,
  protectedServerIds = [],
  initial,
  initialRequest,
  onCancel,
  onSaved,
  onManagedPreparation,
}: {
  capabilities: ClusterCapabilities;
  protectedServerIds?: string[];
  initial?: ServerCluster;
  initialRequest?: ManagedNetworkPreparationInput;
  onCancel(): void;
  onSaved(cluster: ServerCluster): void;
  onManagedPreparation(preparation: ManagedNetworkPreparation): void;
}) {
  const { t } = useI18n();
  const c = t.servers.networks;
  const m = c.managed;
  const { toast } = useToast();
  const addServer = useAddServerModal();
  // Capture the revision with the draft. Background refreshes must never rebase it silently.
  const [baseline] = useState(initial);
  const [draft, setDraft] = useState(() => {
    const value = clusterConfig(initial);
    return initialRequest
      ? {
          ...value,
          name: initialRequest.name,
          location: initialRequest.location,
          members: initialRequest.members.map((member) => ({
            ...value.members.find((old) => old.serverId === member.serverId),
            serverId: member.serverId,
            providerId: member.providerId,
            privateIp:
              value.members.find((old) => old.serverId === member.serverId)?.privateIp ?? "",
          })),
        }
      : value;
  });
  const [mode, setMode] = useState<"native" | "wireguard">(() =>
    initialRequest
      ? "wireguard"
      : (initial?.network.mode ??
        (capabilities.modes.includes("wireguard") ? "wireguard" : "native")),
  );
  const [managedPeers, setManagedPeers] = useState<
    Record<string, { endpoint?: string; listenPort?: number }>
  >(() =>
    Object.fromEntries(
      (initialRequest?.members ?? initial?.members)?.map((member) => [
        member.serverId,
        { endpoint: member.endpoint, listenPort: member.listenPort },
      ]) ?? [],
    ),
  );
  const [managedMtu, setManagedMtu] = useState(
    initialRequest?.mtu !== undefined
      ? String(initialRequest.mtu)
      : initial?.network.mode === "wireguard"
        ? String(initial.network.mtu)
        : "",
  );
  const [managedProbePort, setManagedProbePort] = useState(
    initialRequest?.probePort ??
      (initial?.network.mode === "wireguard" ? initial.network.probePort : 45876),
  );
  const [rotateKeys, setRotateKeys] = useState(initialRequest?.rotateKeys ?? false);
  const [managedAccess, setManagedAccess] = useState<NetworkAccessPolicy | undefined>(
    initialRequest?.access ??
      (initial?.network.mode === "wireguard" ? initial.network.access : undefined),
  );
  const connectionAccess = retainNetworkAccess(
    managedAccess,
    draft.members.map((member) => member.serverId),
  );
  const managedBusy = useRef(false);
  const preparationRequest = useRef<{ fingerprint: string; requestId: string } | null>(null);
  const [ranges, setRanges] = useState(
    () => initialRequest?.cidr ?? initial?.network.cidrs.join(", ") ?? "",
  );
  const [step, setStep] = useState(initialRequest ? 1 : 0);
  const [servers, setServers] = useState<ServerInfo[]>([]);
  const [occupied, setOccupied] = useState(new Set<string>());
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [inspections, setInspections] = useState<Record<string, NetworkHostObservation>>({});
  const [inspectionErrors, setInspectionErrors] = useState<Record<string, string>>({});
  const [inspecting, setInspecting] = useState<string[] | null>(null);
  const [inspectionProgress, setInspectionProgress] = useState(0);
  const [detectionSummary, setDetectionSummary] = useState<{ count: number; total: number } | null>(
    null,
  );
  const inspectionRun = useRef(0);
  const inspectionBusy = useRef(false);
  const requestId = useRef(randomUUID());
  const steps =
    mode === "wireguard"
      ? [c.stepNetwork, c.members, m.preparationTitle, c.stepReview]
      : [c.stepNetwork, c.members, c.stepReview];
  const source = nativeNetworkSource(draft);
  const sourceProvider = capabilities.providers.find(
    (provider) => provider.id === source.providerId,
  );
  const stepHeading = useRef<HTMLHeadingElement>(null);
  const errorMessage = useRef<HTMLDivElement>(null);
  const previousStep = useRef(step);
  const firewall = useNetworkFirewallConfirmation(
    JSON.stringify({ mode, network: draft.network, ranges, members: draft.members }),
  );

  useEffect(
    () => () => {
      inspectionRun.current += 1;
    },
    [],
  );

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
    void Promise.all([systemApi.listServers(), privateNetworksApi.list()])
      .then(([rows, clusters]) => {
        if (!active) return;
        setServers(rows);
        setOccupied(
          new Set(
            clusters
              .filter(
                (cluster) =>
                  cluster.id !== baseline?.id &&
                  cluster.operation &&
                  [
                    "applying",
                    "verifying",
                    "committing",
                    "rolling_back",
                    "interrupted",
                    "needs_attention",
                  ].includes(cluster.operation.status),
              )
              .flatMap((cluster) => cluster.operation!.plan.hosts.map((host) => host.serverId)),
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

  const memberName = (id: string) => {
    const server = servers.find((s) => s.id === id);
    return (
      server?.name ||
      server?.sshHost ||
      baseline?.members.find((m) => m.serverId === id)?.name ||
      id
    );
  };
  const memberLabel = (id: string) => {
    const server = servers.find((s) => s.id === id);
    const name = memberName(id);
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
    setDetectionSummary(null);
  };
  const selectServer = (id: string) => {
    setDraft((old) => ({
      ...old,
      members: old.members.some((m) => m.serverId === id)
        ? old.members.filter((m) => m.serverId !== id)
        : [...old.members, { serverId: id, providerId: "custom", privateIp: "" }],
    }));
    setDetectionSummary(null);
    setInspections(({ [id]: _, ...remaining }) => remaining);
    setInspectionErrors(({ [id]: _, ...remaining }) => remaining);
    setError(null);
  };
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

  const inspect = async (ids: string[]) => {
    if (inspectionBusy.current || saving || !ids.length) return;
    inspectionBusy.current = true;
    const run = ++inspectionRun.current;
    const observed = { ...inspections };
    const failures = { ...inspectionErrors };
    for (const id of ids) {
      delete observed[id];
      delete failures[id];
    }
    setInspecting(ids);
    setInspectionProgress(0);
    setInspectionErrors({ ...failures });
    setDetectionSummary(null);
    setError(null);
    try {
      // Reuse the existing read-only inspection endpoint, with bounded SSH fan-out.
      for (let start = 0; start < ids.length; start += 3) {
        const batch = ids.slice(start, start + 3);
        const results = await Promise.allSettled(batch.map((id) => privateNetworksApi.inspect(id)));
        if (inspectionRun.current !== run) return;
        results.forEach((result, index) => {
          const id = batch[index]!;
          if (result.status === "fulfilled") observed[id] = result.value;
          else failures[id] = getApiErrorMessage(result.reason);
        });
        setInspectionProgress(start + batch.length);
      }
      const next = suggestNativeClusterConfig(config(), observed, ids);
      setInspections(observed);
      setInspectionErrors(failures);
      setDraft(next);
      setRanges(next.network.cidrs.join(", "));
      setDetectionSummary({
        total: ids.length,
        count: next.members.filter(
          (member) =>
            ids.includes(member.serverId) &&
            privateInterfaceChoices(observed[member.serverId]?.interfaces ?? []).some(
              (choice) =>
                choice.privateIp === member.privateIp &&
                choice.interfaceName === member.interfaceName,
            ),
        ).length,
      });
    } catch (err) {
      if (inspectionRun.current === run) setError(getApiErrorMessage(err));
    } finally {
      if (inspectionRun.current === run) {
        inspectionBusy.current = false;
        setInspecting(null);
      }
    }
  };

  const applyDetectedChoice = (id: string, choice: PrivateInterfaceChoice) => {
    const value = config();
    value.members = value.members.map((member) =>
      member.serverId === id
        ? { ...member, privateIp: choice.privateIp, interfaceName: choice.interfaceName }
        : member,
    );
    const next = suggestNativeClusterConfig(value, inspections, [id]);
    setDraft(next);
    setRanges(next.network.cidrs.join(", "));
    setDetectionSummary(null);
    setError(null);
  };

  const validationMessage = (err: unknown) => {
    if (err instanceof ClusterConfigError && err.issue?.kind === "address_outside_ranges")
      return interpolate(c.addressOutsideRanges, { server: memberName(err.issue.serverId) });
    return err instanceof Error ? err.message : c.invalidConfig;
  };

  const next = async () => {
    if (managedBusy.current || saving) return;
    setError(null);
    if (step === 0 && !draft.name.trim()) {
      setError(c.networkSetup.nameRequired);
      return;
    }
    if (
      step === 1 &&
      (draft.members.length < 2 || draft.members.length > capabilities.maxMembers)
    ) {
      setError(interpolate(c.chooseMembers, { max: String(capabilities.maxMembers) }));
      return;
    }
    if (step === 1) {
      if (mode === "wireguard") {
        managedBusy.current = true;
        setSaving(true);
        let navigating = false;
        try {
          const input = {
            name: draft.name.trim(),
            location: draft.location?.trim() || undefined,
            ...(baseline ? { clusterId: baseline.id, revision: baseline.revision } : {}),
            cidr: ranges.trim() || undefined,
            mtu: managedMtu ? Number(managedMtu) : undefined,
            probePort: managedProbePort,
            rotateKeys,
            ...(connectionAccess ? { access: connectionAccess } : {}),
            members: draft.members.map((member) => ({
              serverId: member.serverId,
              providerId: member.providerId,
              endpoint: managedPeers[member.serverId]?.endpoint?.trim() || undefined,
              listenPort: managedPeers[member.serverId]?.listenPort ?? 51820,
            })),
          };
          const fingerprint = JSON.stringify(input);
          if (preparationRequest.current?.fingerprint !== fingerprint)
            preparationRequest.current = { fingerprint, requestId: randomUUID() };
          const preparation = await privateNetworksApi.prepareManaged({
            ...input,
            requestId: preparationRequest.current.requestId,
          });
          onManagedPreparation(preparation);
          navigating = true;
        } catch (err) {
          // The server may have accepted the request before its response was
          // lost. Reattach to that saved attempt without submitting more work.
          const pendingId = preparationRequest.current?.requestId;
          if (pendingId) {
            const saved = await privateNetworksApi.managedPreparation(pendingId).catch(() => null);
            if (saved?.id === pendingId) {
              onManagedPreparation(saved);
              navigating = true;
              return;
            }
          }
          setError(getApiErrorMessage(err));
        } finally {
          // App Router starts navigation before the destination is ready.
          // Keep the draft locked until this wizard unmounts after the handoff.
          if (!navigating) {
            managedBusy.current = false;
            setSaving(false);
          }
        }
        return;
      }
      try {
        const value = config();
        validateNativeCluster(value);
        for (const member of value.members) {
          const observed = inspections[member.serverId];
          if (observed)
            selectClusterInterface(
              observed,
              {
                ...member,
                providerId: networkMemberProvider(value.network, member),
              },
              value.network.mtu,
            );
        }
      } catch (err) {
        setError(validationMessage(err));
        return;
      }
    }
    setStep((old) => old + 1);
  };

  const save = async () => {
    if (!capabilities.canManage || saving || managedBusy.current) return;
    if (mode === "wireguard") return;
    if (!firewall.checked) {
      setError(m.firewallRules.confirmRequired);
      return;
    }
    setSaving(true);
    setError(null);
    let saved: ServerCluster | null = null;
    try {
      const value = config();
      validateNativeCluster(value);
      saved = baseline
        ? await privateNetworksApi.update({
            ...value,
            clusterId: baseline.id,
            revision: baseline.revision,
          })
        : await privateNetworksApi.create({ ...value, requestId: requestId.current });
      const verification = await privateNetworksApi.verify(saved);
      onSaved({ ...saved, verification });
    } catch (err) {
      if (saved) {
        toast("error", `${c.savedCheckFailed} ${getApiErrorMessage(err)}`);
        onSaved(saved);
      } else setError(validationMessage(err));
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
        <UiIcon name="arrow-left" className="size-4 shrink-0 rtl:rotate-180" />
        <span className="truncate">{baseline?.name || c.backToClusters}</span>
      </Button>
      <h1 id="cluster-wizard-title" className="text-2xl font-semibold tracking-tight">
        {baseline ? c.editCluster : c.createCluster}
      </h1>
      <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted-foreground">
        {mode === "wireguard" ? m.description : c.wizardDescription}
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
            </div>
          )}

          {step === 0 && !baseline && capabilities.modes.includes("wireguard") && (
            <fieldset disabled={saving || inspecting !== null} className="mt-6 min-w-0">
              <legend className="mb-3 text-sm font-medium">{m.mode}</legend>
              <div className="grid gap-3 @md/cluster-form:grid-cols-2">
                {(["wireguard", "native"] as const).map((choice) => (
                  <label
                    key={choice}
                    className={`flex cursor-pointer items-start gap-3 rounded-xl p-4 transition-colors ${mode === choice ? "bg-primary/8" : "bg-muted/40 hover:bg-muted/60"}`}
                  >
                    <input
                      type="radio"
                      name="network-mode"
                      value={choice}
                      checked={mode === choice}
                      onChange={() => {
                        setMode(choice);
                        setError(null);
                      }}
                      className="mt-0.5 size-4 shrink-0 appearance-none rounded-full border-2 border-muted-foreground/40 bg-transparent outline-none checked:border-[5px] checked:border-primary focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:ring-offset-2 focus-visible:ring-offset-card"
                    />
                    <span className="min-w-0 text-sm">
                      <span className="font-medium">
                        {choice === "wireguard" ? m.title : c.nativeNetwork}
                      </span>
                      <span className="mt-1 block text-xs leading-relaxed text-muted-foreground">
                        {choice === "wireguard" ? m.description : m.existingHint}
                      </span>
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>
          )}

          {step === 0 && mode === "native" && (
            <div className="mt-6 space-y-4">
              <div className="grid gap-4 @md/cluster-form:grid-cols-2">
                <InfrastructureProviderSelect
                  providers={capabilities.providers}
                  value={source.providerId}
                  onChange={(providerId) => {
                    setDraft((old) => ({
                      ...old,
                      network: { ...old.network, source: { providerId } },
                    }));
                    setError(null);
                  }}
                />
                <Label className="min-w-0 text-muted-foreground">
                  {c.networkReference}
                  <Input
                    variant="filled"
                    className="mt-1.5"
                    value={source.networkRef ?? ""}
                    placeholder={sourceProvider?.network}
                    maxLength={200}
                    onChange={(e) =>
                      setDraft((old) => ({
                        ...old,
                        network: {
                          ...old.network,
                          source: { ...source, networkRef: e.target.value },
                        },
                      }))
                    }
                  />
                </Label>
              </div>
              <p className="text-sm leading-relaxed text-muted-foreground">
                {source.providerId === "custom"
                  ? c.networkSetup.customHint
                  : c.networkSetup.providerHint}
              </p>
              {sourceProvider?.docs && (
                <a
                  className="inline-flex text-xs text-primary hover:underline"
                  href={sourceProvider.docs}
                  target="_blank"
                  rel="noreferrer"
                >
                  {c.providerGuide} ↗
                </a>
              )}
            </div>
          )}

          {step === 1 && (
            <fieldset disabled={saving || inspecting !== null} className="mb-6 min-w-0 space-y-4">
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
                  <UiIcon name="plus" className="size-3.5" />
                  {t.servers.list.addServer}
                </Button>
              </div>
              {loading ? (
                <UiIcon name="spinner" className="mx-auto my-8 size-5 animate-spin" />
              ) : (
                <div className="grid gap-3 @md/cluster-form:grid-cols-2">
                  {servers.map((server) => {
                    const selected = draft.members.some((m) => m.serverId === server.id);
                    const unavailable =
                      protectedServerIds.includes(server.id) ||
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
                        <UiIcon name="server" className="size-4 shrink-0 text-muted-foreground" />
                        <span className="min-w-0 flex-1 text-sm">
                          {memberLabel(server.id)}
                          {protectedServerIds.includes(server.id) && (
                            <span className="block text-xs text-muted-foreground">{c.inUseBy}</span>
                          )}
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
            </fieldset>
          )}

          {step === 1 && mode === "wireguard" && draft.members.length >= 2 && (
            <div className="mb-6">
              <ClusterNetworkDiagnostics
                compact
                showFirewallRules={false}
                network={{ mode: "wireguard", access: connectionAccess }}
                onAccessChange={setManagedAccess}
                accessDisabled={saving}
                members={draft.members.map((member) => ({
                  ...member,
                  name: memberName(member.serverId),
                  providerId: "custom",
                  privateIp:
                    baseline?.members.find((old) => old.serverId === member.serverId)?.privateIp ??
                    "",
                  endpoint:
                    managedPeers[member.serverId]?.endpoint ||
                    servers.find((server) => server.id === member.serverId)?.sshHost,
                  listenPort: managedPeers[member.serverId]?.listenPort ?? 51820,
                }))}
              />
            </div>
          )}

          {step === 1 && mode === "wireguard" && (
            <fieldset disabled={saving} className="min-w-0 space-y-5">
              <div className="space-y-2 rounded-xl bg-muted/40 p-4 text-sm leading-relaxed text-muted-foreground">
                <p>{m.rangeHint}</p>
                <p className="text-xs">{m.requirements}</p>
              </div>
              {draft.members.map((member) => (
                <div key={member.serverId} className="space-y-4 rounded-xl bg-muted/30 p-4">
                  <div className="text-sm">{memberLabel(member.serverId)}</div>
                  <div className="grid grid-cols-1 gap-3 @md/cluster-form:grid-cols-[minmax(0,1fr)_150px]">
                    <Label className="min-w-0">
                      {m.endpoint}
                      <BlurIp>
                        <Input
                          variant="filled"
                          className="mt-1.5"
                          placeholder={m.useServerAddress}
                          value={managedPeers[member.serverId]?.endpoint ?? ""}
                          onChange={(e) =>
                            setManagedPeers((old) => ({
                              ...old,
                              [member.serverId]: {
                                ...old[member.serverId],
                                endpoint: e.target.value,
                              },
                            }))
                          }
                        />
                      </BlurIp>
                    </Label>
                    <Label className="min-w-0">
                      {m.port}
                      <Input
                        variant="filled"
                        className="mt-1.5"
                        type="number"
                        min={1024}
                        max={65535}
                        value={managedPeers[member.serverId]?.listenPort ?? 51820}
                        onChange={(e) =>
                          setManagedPeers((old) => ({
                            ...old,
                            [member.serverId]: {
                              ...old[member.serverId],
                              listenPort: Number(e.target.value),
                            },
                          }))
                        }
                      />
                    </Label>
                  </div>
                </div>
              ))}
              <p className="text-xs leading-relaxed text-muted-foreground">{m.endpointHint}</p>
              <details className="rounded-xl bg-muted/30 p-4">
                <summary className="cursor-pointer text-sm font-medium">{c.advancedChecks}</summary>
                <div className="mt-4 space-y-4">
                  <Label className="block">
                    {c.addressRanges}
                    <Input
                      variant="filled"
                      className="mt-1.5"
                      placeholder={m.automaticRange}
                      value={ranges}
                      disabled={!!baseline}
                      onChange={(e) => setRanges(e.target.value)}
                    />
                  </Label>
                  <div className="grid grid-cols-1 gap-4 @md/cluster-form:grid-cols-2">
                    <Label>
                      {c.mtu}
                      <Input
                        variant="filled"
                        className="mt-1.5"
                        type="number"
                        min={1280}
                        max={1420}
                        placeholder={c.autoDetect}
                        value={managedMtu}
                        onChange={(e) => setManagedMtu(e.target.value)}
                      />
                    </Label>
                    <Label>
                      {c.probePort}
                      <Input
                        variant="filled"
                        className="mt-1.5"
                        type="number"
                        min={1024}
                        max={65535}
                        value={managedProbePort}
                        onChange={(e) => setManagedProbePort(Number(e.target.value))}
                      />
                    </Label>
                  </div>
                  {baseline && (
                    <label className="flex cursor-pointer items-start gap-3">
                      <Checkbox
                        checked={rotateKeys}
                        onCheckedChange={(value) => setRotateKeys(!!value)}
                      />
                      <span className="text-sm font-medium">
                        {m.rotateKeys}
                        <span className="mt-1 block text-xs font-normal text-muted-foreground">
                          {m.rotateHint}
                        </span>
                      </span>
                    </label>
                  )}
                </div>
              </details>
            </fieldset>
          )}

          {step === 1 && mode === "native" && (
            <fieldset disabled={saving || inspecting !== null} className="min-w-0 space-y-5">
              <div className="flex items-start gap-3 rounded-xl bg-muted/50 p-4">
                <UiIcon name="network" className="mt-0.5 size-5 shrink-0 text-primary" />
                <div className="min-w-0 flex-1">
                  <NetworkSource cluster={draft} />
                  <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
                    {c.prepareNetwork}
                  </p>
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    className="mt-3 h-auto max-w-full whitespace-normal py-2 text-start"
                    onClick={() => void inspect(draft.members.map((member) => member.serverId))}
                    disabled={saving || inspecting !== null || !draft.members.length}
                  >
                    {inspecting ? (
                      <UiIcon name="spinner" className="size-3.5 animate-spin" />
                    ) : (
                      <UiIcon name="search" className="size-3.5" />
                    )}
                    {inspecting
                      ? interpolate(c.detectingNetworks, {
                          count: String(inspectionProgress),
                          total: String(inspecting.length),
                        })
                      : c.detectNetworkSettings}
                  </Button>
                  {detectionSummary && (
                    <p role="status" className="mt-2 text-xs leading-relaxed text-muted-foreground">
                      {interpolate(c.detectedSettingsCount, {
                        count: String(detectionSummary.count),
                        total: String(detectionSummary.total),
                      })}
                    </p>
                  )}
                </div>
              </div>
              <Label className="block">
                {c.addressRanges}
                <Input
                  variant="filled"
                  className="mt-1.5"
                  placeholder="10.20.0.0/24, 10.30.0.0/24"
                  value={ranges}
                  onChange={(e) => {
                    setRanges(e.target.value);
                    setError(null);
                    setDetectionSummary(null);
                  }}
                />
                <span className="mt-1 block text-xs font-normal text-muted-foreground">
                  {c.addressRangesHint}
                </span>
              </Label>
              <div className="space-y-3">
                {draft.members.map((member) => {
                  const observed = inspections[member.serverId];
                  const choices = privateInterfaceChoices(observed?.interfaces ?? []);
                  const selectedChoice = choices.find(
                    (choice) =>
                      choice.privateIp === member.privateIp &&
                      choice.interfaceName === member.interfaceName,
                  );
                  return (
                    <div key={member.serverId} className="rounded-xl bg-muted/40 p-4">
                      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
                        <p className="flex min-w-0 items-center gap-2 text-sm font-medium">
                          <UiIcon name="server" className="size-4 shrink-0 text-muted-foreground" />
                          {memberLabel(member.serverId)}
                        </p>
                        <Button
                          type="button"
                          onClick={() => void inspect([member.serverId])}
                          disabled={saving || inspecting !== null}
                          variant="outline"
                          size="sm"
                        >
                          {inspecting?.includes(member.serverId) ? (
                            <UiIcon name="spinner" className="size-3.5 animate-spin" />
                          ) : (
                            <UiIcon name="search" className="size-3.5" />
                          )}
                          {c.inspect}
                        </Button>
                      </div>
                      {inspectionErrors[member.serverId] && (
                        <p role="alert" className="mb-3 text-sm leading-relaxed text-danger">
                          {inspectionErrors[member.serverId]}
                        </p>
                      )}
                      {observed && !choices.length && (
                        <p role="status" className="mb-3 text-sm leading-relaxed text-warning">
                          {c.noPrivateInterface}
                        </p>
                      )}
                      <div className="grid gap-3 @lg/cluster-form:grid-cols-2">
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
                        <div className="mt-3 space-y-2">
                          <p className="text-xs leading-relaxed text-muted-foreground">
                            {choices.length > 1 && !selectedChoice
                              ? c.chooseDetectedInterface
                              : c.detectedAddresses}
                          </p>
                          <div className="flex flex-wrap items-center gap-2">
                            {choices.map((choice) => (
                              <Button
                                type="button"
                                key={`${choice.interfaceName}:${choice.privateIp}`}
                                variant="secondary"
                                size="sm"
                                className="h-auto max-w-full flex-wrap whitespace-normal py-2 font-mono"
                                aria-pressed={choice === selectedChoice}
                                onClick={() => applyDetectedChoice(member.serverId, choice)}
                              >
                                {choice === selectedChoice && <UiIcon name="check" className="size-3.5" />}
                                <span dir="ltr">
                                  <BlurIp>
                                    {choice.privateIp}/{choice.prefixLength}
                                  </BlurIp>
                                </span>
                                <span className="text-muted-foreground">
                                  · {choice.interfaceName}
                                </span>
                              </Button>
                            ))}
                          </div>
                          {selectedChoice && !selectedChoice.cidr && (
                            <p className="text-xs leading-relaxed text-muted-foreground">
                              {c.manualRangeRequired}
                            </p>
                          )}
                        </div>
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
            </fieldset>
          )}

          {step === 2 && mode === "native" && (
            <div className="space-y-4">
              <NetworkFirewallRules
                embedded
                network={{ mode: "native", probePort: draft.network.probePort }}
                servers={draft.members.map((member) => ({
                  ...member,
                  providerId: networkMemberProvider(draft.network, member),
                  name: memberName(member.serverId),
                }))}
              >
                <NetworkFirewallConfirmation mode="native" {...firewall} disabled={saving} />
              </NetworkFirewallRules>
              <div className="rounded-xl bg-muted/40 p-4">
                <p className="font-semibold">{draft.name}</p>
                <p className="mt-1 text-sm text-muted-foreground">
                  {draft.location || c.noLocation} ·{" "}
                  {interpolate(c.memberCount, { count: String(draft.members.length) })}
                </p>
              </div>
              <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
                <dt className="text-muted-foreground">{c.provider}</dt>
                <dd>{source.providerId === "custom" ? c.customProvider : sourceProvider?.name}</dd>
                {source.networkRef && (
                  <>
                    <dt className="text-muted-foreground">{c.stepNetwork}</dt>
                    <dd className="break-words">{source.networkRef}</dd>
                  </>
                )}
                <dt className="text-muted-foreground">{c.nativeNetwork}</dt>
                <dd className="break-words font-mono text-xs">
                  <BlurIp>{config().network.cidrs.join(", ")}</BlurIp>
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
                      <BlurIp>{m.privateIp}</BlurIp> · {m.interfaceName || c.autoDetect}
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
                    {index < step ? <UiIcon name="check" className="size-3.5" /> : index + 1}
                  </span>
                  <span className="min-w-0 break-words">{label}</span>
                </button>
              </li>
            ))}
          </ol>
          <div className="space-y-3 p-5">
            <Button
              type="button"
              disabled={
                saving ||
                loading ||
                inspecting !== null ||
                !capabilities.canManage ||
                (mode === "native" && step === 2 && !firewall.checked)
              }
              onClick={() => (step < 2 ? void next() : void save())}
              aria-busy={saving}
              className="w-full"
            >
              {saving && <UiIcon name="spinner" className="size-4 shrink-0 animate-spin" />}
              {mode === "wireguard" && step === 1
                ? saving
                  ? m.inspecting
                  : m.inspect
                : step < 2
                  ? c.continue
                  : mode === "wireguard"
                    ? m.apply
                    : baseline
                      ? c.saveAndVerify
                      : c.createAndVerify}
              {step < 2 && <UiIcon name="arrow-right" className="size-4 shrink-0 rtl:rotate-180" />}
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
                <UiIcon name="arrow-left" className="size-4 shrink-0 rtl:rotate-180" />
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
