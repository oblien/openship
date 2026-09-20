"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  CircleAlert,
  Loader2,
  PauseCircle,
  RotateCcw,
} from "lucide-react";
import type { ClusterCapabilities } from "@repo/contracts";
import { PageContainer } from "@/components/ui/PageContainer";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/components/i18n-provider";
import { usePlatform } from "@/context/PlatformContext";
import { getApiErrorMessage } from "@/lib/api";
import { privateNetworksApi } from "@/lib/api/private-networks";
import { NetworkSetupProgress } from "./NetworkSetupProgress";
import { NetworkSetupTopology } from "./NetworkSetupTopology";
import {
  MANAGED_NETWORK_PORT,
  fullNetworkAccess,
  normalizeNetworkAccess,
  type NetworkAccessPolicy,
} from "@repo/core";
import { randomUUID } from "@/lib/random-uuid";
import { useNetworkSetup } from "@/hooks/useNetworkSetup";
import { NetworkStreamNotice } from "./NetworkStreamNotice";
import { NetworkPreparationActions } from "./NetworkPreparationActions";
import { RemoveSetupServerButton } from "./RemoveSetupServerButton";
import { NetworkSetupCleanup } from "./NetworkSetupCleanup";

export function ManagedNetworkPreparationPage({ id }: { id: string }) {
  const { t } = useI18n();
  const c = t.servers.networks;
  const m = c.managed;
  const router = useRouter();
  const { selfHosted, deployMode } = usePlatform();
  const eligible = selfHosted && deployMode !== "cloud";
  const {
    progress: preparation,
    update: setPreparation,
    stream,
  } = useNetworkSetup("preparation", id, eligible);
  const [capabilities, setCapabilities] = useState<ClusterCapabilities | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const actionPending = useRef(false);
  const [connectionDraft, setConnectionDraft] = useState<{
    preparationId: string;
    access: NetworkAccessPolicy;
  } | null>(null);
  const connectionRequest = useRef<{ fingerprint: string; requestId: string } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [openHost, setOpenHost] = useState<{ serverId: string } | null>(null);
  useEffect(() => {
    actionPending.current = false;
    setBusy(false);
    setConnectionDraft(null);
    connectionRequest.current = null;
  }, [id]);
  const running = preparation?.status === "preparing";
  const waiting = preparation?.status === "pending";
  const paused = waiting && !preparation?.cleanupOperationId;
  const connectionAccess =
    connectionDraft?.preparationId === id ? connectionDraft.access : preparation?.input.access;
  const connectionChanges =
    !!preparation &&
    connectionDraft?.preparationId === id &&
    JSON.stringify(connectionAccess) !==
      JSON.stringify(
        normalizeNetworkAccess(
          preparation.input.access ??
            fullNetworkAccess(preparation.input.members.map((member) => member.serverId)),
          preparation.input.members.map((member) => member.serverId),
        ),
      );
  const canDesignConnections =
    !!capabilities?.canManage &&
    !!preparation &&
    preparation.input.intent !== "remove" &&
    preparation.status !== "cancelled" &&
    !preparation.replacementPreparationId &&
    !preparation.cleanupOperationId;
  const members =
    preparation?.input.members.map((member) => {
      const host = preparation.hosts.find((item) => item.serverId === member.serverId);
      return {
        ...member,
        name: host?.name ?? member.serverId,
        privateIp: "",
        // Existing clusters may inherit a different endpoint/port from their saved config.
        // Let the planner resolve those values instead of guessing from SSH/defaults.
        endpoint:
          host?.transport?.endpoint ??
          member.endpoint ??
          (!preparation.input.clusterId ? host?.address : undefined),
        listenPort:
          host?.transport?.listenPort ??
          member.listenPort ??
          (!preparation.input.clusterId ? MANAGED_NETWORK_PORT : undefined),
      };
    }) ?? [];
  const canRemoveMember =
    capabilities?.canManage &&
    preparation &&
    !preparation.input.clusterId &&
    !preparation.replacementPreparationId &&
    (paused || preparation.status === "failed" || preparation.status === "interrupted");
  useEffect(() => {
    if (!eligible) return;
    let active = true;
    void privateNetworksApi
      .capabilities()
      .then((caps) => {
        if (active) {
          setCapabilities(caps);
          setError(null);
        }
      })
      .catch((err) => {
        if (active) setError(getApiErrorMessage(err));
      });
    return () => {
      active = false;
    };
  }, [id, eligible, attempt]);
  const saveConnections = async () => {
    if (
      !preparation ||
      !connectionChanges ||
      !connectionAccess ||
      !canDesignConnections ||
      running ||
      actionPending.current
    )
      return;
    actionPending.current = true;
    setBusy(true);
    setError(null);
    const fingerprint = JSON.stringify({ id, access: connectionAccess });
    if (connectionRequest.current?.fingerprint !== fingerprint)
      connectionRequest.current = { fingerprint, requestId: randomUUID() };
    const requestId = connectionRequest.current.requestId;
    let navigating = false;
    try {
      const next = await privateNetworksApi.reviseConnections({
        preparationId: id,
        sequence: preparation.sequence,
        requestId,
        access: connectionAccess,
      });
      router.push(`/servers/networks/preparations/${next.id}`);
      navigating = true;
    } catch (err) {
      const saved = await privateNetworksApi.managedPreparation(requestId).catch(() => null);
      if (saved?.id === requestId) {
        router.push(`/servers/networks/preparations/${saved.id}`);
        navigating = true;
      } else setError(getApiErrorMessage(err));
    } finally {
      if (!navigating) {
        actionPending.current = false;
        setBusy(false);
      }
    }
  };
  const retry = useCallback(async () => {
    if (!preparation || actionPending.current || !capabilities?.canManage) return;
    actionPending.current = true;
    setBusy(true);
    setError(null);
    try {
      setPreparation(await privateNetworksApi.prepareManaged(preparation.input));
    } catch (err) {
      setError(getApiErrorMessage(err));
    } finally {
      stream.reconnect();
      actionPending.current = false;
      setBusy(false);
    }
  }, [preparation, busy, capabilities, setPreparation, stream.reconnect]);
  const edit = preparation?.input.clusterId
    ? `/servers/networks/${encodeURIComponent(preparation.input.clusterId)}/edit`
    : "/servers/networks/new";
  return (
    <PageContainer>
      <section
        className="@container/network-preparation"
        aria-labelledby="network-preparation-title"
      >
        <Link
          href="/servers?tab=networking"
          className="mb-5 inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="size-4 rtl:rotate-180" />
          {c.backToClusters}
        </Link>
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h1 id="network-preparation-title" className="text-2xl font-semibold tracking-tight">
              {m.preparationTitle}
            </h1>
            <p className="mt-2 break-words text-sm text-muted-foreground">
              {preparation?.input.name || m.preparationDescription}
            </p>
          </div>
          {eligible && preparation && (
            <NetworkPreparationActions
              preparation={preparation}
              name={preparation.input.name}
              canManage={!!capabilities?.canManage}
              disabled={busy || connectionChanges}
              onBusyChange={(pending) => {
                actionPending.current = pending;
                setBusy(pending);
              }}
              onDiscarded={(next) => {
                setPreparation(next);
                router.replace("/servers?tab=networking");
              }}
              onRefresh={stream.reconnect}
            />
          )}
        </div>
        {!eligible ? (
          <p className="mt-6 rounded-xl bg-muted/50 p-5 text-sm text-muted-foreground">
            {c.selfHostedOnly}
          </p>
        ) : (
          <>
            <NetworkStreamNotice stream={stream} />
            {error && (
              <div
                role="alert"
                className="mt-5 flex items-center justify-between gap-3 rounded-xl bg-danger/10 p-4 text-sm text-danger"
              >
                <span>{error}</span>
                <button
                  type="button"
                  onClick={() => setAttempt((value) => value + 1)}
                  className="shrink-0 underline"
                >
                  {c.retry}
                </button>
              </div>
            )}
            {!preparation && !error && !stream.error && (
              <Loader2 className="mx-auto my-16 size-5 animate-spin text-muted-foreground" />
            )}
            {preparation && (
              <div className="mt-6 grid items-start gap-6 @4xl/network-preparation:grid-cols-[minmax(0,1fr)_340px]">
                {waiting && preparation.cleanupOperationId ? (
                  <NetworkSetupCleanup
                    operationId={preparation.cleanupOperationId}
                    memberCount={preparation.input.members.length}
                    canManage={!!capabilities?.canManage}
                    disabled={busy}
                    onContinue={() => void retry()}
                  />
                ) : (
                  <div className="min-w-0 space-y-5">
                    <NetworkSetupTopology
                      preparation
                      network={{ mode: "wireguard", access: connectionAccess }}
                      onAccessChange={
                        canDesignConnections
                          ? (access) => setConnectionDraft({ preparationId: id, access })
                          : undefined
                      }
                      accessDisabled={busy}
                      members={members}
                      hosts={preparation.hosts}
                      running={running}
                      statusLabel={m.preparationStatus[preparation.status]}
                      completeLabel={m.preparationStatus.ready}
                      onHostSelect={(serverId) => setOpenHost({ serverId })}
                    />
                    <NetworkSetupProgress
                      initiallyCollapsed
                      openHost={openHost}
                      hosts={preparation.hosts}
                      running={running}
                      renderHostActions={
                        canRemoveMember
                          ? (host) => (
                              <RemoveSetupServerButton
                                source={{ preparationId: id, sequence: preparation.sequence }}
                                serverId={host.serverId}
                                name={host.name}
                                memberCount={preparation.input.members.length}
                                disabled={busy || connectionChanges}
                                onRefresh={stream.reconnect}
                              />
                            )
                          : undefined
                      }
                    />
                  </div>
                )}
                <aside className="order-first space-y-5 rounded-2xl bg-card p-5 @4xl/network-preparation:sticky @4xl/network-preparation:top-6 @4xl/network-preparation:order-last">
                  <div role="status" className="flex items-center gap-2 text-sm font-semibold">
                    {running ? (
                      <Loader2 className="size-4 shrink-0 animate-spin text-primary" />
                    ) : waiting || preparation.status === "interrupted" ? (
                      <PauseCircle className="size-4 shrink-0 text-muted-foreground" />
                    ) : preparation.status === "cancelled" ? (
                      <CheckCircle2 className="size-4 shrink-0 text-muted-foreground" />
                    ) : preparation.status === "ready" ? (
                      <CheckCircle2 className="size-4 shrink-0 text-success" />
                    ) : (
                      <CircleAlert className="size-4 shrink-0 text-danger" />
                    )}
                    {m.preparationStatus[preparation.status]}
                  </div>
                  {connectionChanges && canDesignConnections && (
                    <div className="space-y-3 rounded-xl bg-primary/5 p-4">
                      <p className="text-sm font-medium">{c.access.unsaved}</p>
                      <p className="text-xs leading-relaxed text-muted-foreground">
                        {running ? c.access.preparingHint : c.access.saveHint}
                      </p>
                      <Button
                        className="h-auto min-h-10 w-full whitespace-normal py-2"
                        disabled={busy || running}
                        aria-busy={busy}
                        onClick={() => void saveConnections()}
                      >
                        {busy && <Loader2 className="size-4 animate-spin" />}
                        {busy ? c.access.saving : c.access.save}
                      </Button>
                      <Button
                        variant="ghost"
                        className="w-full"
                        disabled={busy}
                        onClick={() => {
                          setConnectionDraft(null);
                          setError(null);
                        }}
                      >
                        {c.access.discard}
                      </Button>
                    </div>
                  )}
                  <ol className="space-y-3 text-sm" aria-label={c.setupSteps}>
                    {[m.preparationTitle, c.stepReview, m.apply, m.status.verifying].map(
                      (label, index) => (
                        <li
                          key={index}
                          className={`flex items-center gap-3 ${index ? "text-muted-foreground" : "font-medium"}`}
                          aria-current={index === 0 ? "step" : undefined}
                        >
                          <span
                            className={`grid size-6 shrink-0 place-items-center rounded-full text-xs ${index === 0 ? "bg-primary/10 text-primary" : "bg-muted"}`}
                          >
                            {index === 0 && preparation.status === "ready" ? (
                              <CheckCircle2 className="size-3.5" />
                            ) : (
                              index + 1
                            )}
                          </span>
                          {label}
                        </li>
                      ),
                    )}
                  </ol>
                  {preparation.error && (
                    <p role="alert" className="break-words text-sm leading-relaxed text-danger">
                      {preparation.error}
                    </p>
                  )}
                  <p className="text-xs leading-relaxed text-muted-foreground">
                    {waiting ? m.selectionSavedHint : m.preparationHint}
                  </p>
                  <p className="text-xs leading-relaxed text-muted-foreground">
                    {preparation.replacementPreparationId
                      ? m.selectionReplacedHint
                      : preparation.status === "cancelled"
                        ? m.setupDiscardedHint
                        : m.progressSaved}
                  </p>
                  {preparation.replacementPreparationId && (
                    <Button asChild className="h-auto min-h-10 w-full whitespace-normal py-2">
                      <Link
                        href={`/servers/networks/preparations/${preparation.replacementPreparationId}`}
                      >
                        {m.viewUpdatedSetup}
                        <ArrowRight className="size-4 rtl:rotate-180" />
                      </Link>
                    </Button>
                  )}
                  {waiting && !preparation.cleanupOperationId && capabilities?.canManage && (
                    <Button
                      onClick={() => void retry()}
                      disabled={busy || connectionChanges}
                      className="h-auto min-h-10 w-full whitespace-normal py-2"
                    >
                      {busy ? (
                        <Loader2 className="size-4 animate-spin" />
                      ) : (
                        <RotateCcw className="size-4" />
                      )}
                      {m.retryPreparation}
                    </Button>
                  )}
                  {preparation.status === "ready" &&
                    preparation.operationId &&
                    !connectionChanges && (
                      <Button asChild className="h-auto min-h-10 w-full whitespace-normal py-2">
                        <Link href={`/servers/networks/operations/${preparation.operationId}`}>
                          {m.reviewNetwork}
                          <ArrowRight className="size-4 rtl:rotate-180" />
                        </Link>
                      </Button>
                    )}
                  {capabilities?.canManage &&
                    (preparation.status === "failed" || preparation.status === "interrupted") && (
                      <div className="space-y-2">
                        <Button
                          onClick={() => void retry()}
                          disabled={busy || connectionChanges}
                          className="h-auto min-h-10 w-full whitespace-normal py-2"
                        >
                          {busy ? (
                            <Loader2 className="size-4 animate-spin" />
                          ) : (
                            <RotateCcw className="size-4" />
                          )}
                          {m.retryPreparation}
                        </Button>
                        <p className="text-xs leading-relaxed text-muted-foreground">
                          {m.retryPreparationHint}
                        </p>
                      </div>
                    )}
                  {capabilities?.canManage &&
                    !running &&
                    (!waiting || paused) &&
                    preparation.status !== "cancelled" && (
                      <Button
                        asChild
                        variant="ghost"
                        className="h-auto min-h-10 w-full whitespace-normal py-2"
                      >
                        <Link href={`${edit}?preparation=${encodeURIComponent(id)}`}>
                          {m.editSettings}
                        </Link>
                      </Button>
                    )}
                  {preparation.status === "cancelled" && (
                    <Button
                      asChild
                      className="w-full"
                      variant={preparation.replacementPreparationId ? "ghost" : "default"}
                    >
                      <Link href="/servers?tab=networking">{m.closeSetup}</Link>
                    </Button>
                  )}
                </aside>
              </div>
            )}
          </>
        )}
      </section>
    </PageContainer>
  );
}
