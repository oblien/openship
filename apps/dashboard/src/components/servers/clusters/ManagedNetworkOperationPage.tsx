"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  Circle,
  CircleAlert,
  Loader2,
  RotateCcw,
  Trash2,
} from "lucide-react";
import type { ClusterCapabilities } from "@repo/contracts";
import { managedNetworkInProgress } from "@repo/core";
import { BlurIp } from "@/components/BlurIp";
import { useI18n } from "@/components/i18n-provider";
import { PageContainer } from "@/components/ui/PageContainer";
import { Button } from "@/components/ui/button";
import { usePlatform } from "@/context/PlatformContext";
import { getApiErrorMessage } from "@/lib/api";
import { privateNetworksApi } from "@/lib/api/private-networks";
import { ManagedNetworkReview } from "./ManagedNetworkReview";
import { NetworkSetupProgress } from "./NetworkSetupProgress";
import { useNetworkSetup } from "@/hooks/useNetworkSetup";
import { NetworkStreamNotice } from "./NetworkStreamNotice";
import { NetworkSetupConfirmation } from "./NetworkSetupConfirmation";
import { RemoveSetupServerButton } from "./RemoveSetupServerButton";
import { NetworkSetupTopology } from "./NetworkSetupTopology";
import {
  NetworkFirewallConfirmation,
  useNetworkFirewallConfirmation,
} from "./NetworkFirewallConfirmation";
import { ManagedNetworkTransportNotice } from "./ManagedNetworkTransportNotice";

export function ManagedNetworkOperationPage({ id }: { id: string }) {
  const { t } = useI18n();
  const c = t.servers.networks;
  const m = c.managed;
  const router = useRouter();
  const { selfHosted, deployMode } = usePlatform();
  const eligible = selfHosted && deployMode !== "cloud";
  const {
    progress: operation,
    update: setOperation,
    stream,
  } = useNetworkSetup("operation", id, eligible);
  const [capabilities, setCapabilities] = useState<ClusterCapabilities | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const actionPending = useRef(false);
  const [confirmation, setConfirmation] = useState<"discard" | "rollback" | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [now, setNow] = useState(Date.now);
  const [openHost, setOpenHost] = useState<{ serverId: string } | null>(null);
  const running = !!operation && managedNetworkInProgress(operation.status);
  const requiresFirewallConfirmation =
    operation?.plan.intent === "configure" &&
    operation.plan.config.network.access?.rules.length !== 0;
  const firewall = useNetworkFirewallConfirmation(
    `${operation?.id}:${operation?.planHash}:${operation?.generation}:${operation?.status}`,
  );
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
  useEffect(() => {
    if (operation?.status !== "planned") return;
    const timer = setInterval(() => setNow(Date.now()), 5_000);
    return () => clearInterval(timer);
  }, [operation?.status]);
  const apply = useCallback(
    async (action: "apply" | "resume" | "rollback") => {
      if (!operation || actionPending.current || !capabilities?.canManage) return;
      if (action !== "rollback" && requiresFirewallConfirmation && !firewall.checked) {
        setError(m.firewallRules.confirmRequired);
        return;
      }
      actionPending.current = true;
      setBusy(true);
      setError(null);
      try {
        setOperation(
          await privateNetworksApi.applyManaged({
            operationId: id,
            planHash: operation.planHash,
            action,
          }),
        );
        setConfirmation(null);
      } catch (err) {
        setError(getApiErrorMessage(err));
      } finally {
        stream.reconnect();
        actionPending.current = false;
        setBusy(false);
      }
    },
    [
      operation,
      busy,
      capabilities,
      id,
      setOperation,
      stream.reconnect,
      firewall.checked,
      requiresFirewallConfirmation,
      m.firewallRules.confirmRequired,
    ],
  );
  const discard = async () => {
    if (!operation || actionPending.current || !capabilities?.canManage) return;
    actionPending.current = true;
    setBusy(true);
    setError(null);
    try {
      setOperation(
        await privateNetworksApi.discardPlan({ operationId: id, planHash: operation.planHash }),
      );
      setConfirmation(null);
      router.replace("/servers?tab=networking");
    } catch (err) {
      setError(getApiErrorMessage(err));
    } finally {
      stream.reconnect();
      actionPending.current = false;
      setBusy(false);
    }
  };
  useEffect(() => {
    if (operation?.status !== "planned" && confirmation === "discard") setConfirmation(null);
    if (
      operation &&
      operation.status !== "interrupted" &&
      operation.status !== "needs_attention" &&
      confirmation === "rollback"
    )
      setConfirmation(null);
  }, [operation?.status, confirmation]);
  const recoverable =
    operation?.status === "interrupted" || operation?.status === "needs_attention";
  const showFirewallReview =
    operation?.plan.intent === "configure" &&
    !operation.replacementPreparationId &&
    (operation.status === "planned" || recoverable);
  const clusterExists =
    operation &&
    ((operation.status === "succeeded" && operation.plan.intent === "configure") ||
      (operation.status === "rolled_back" && operation.plan.baseRevision !== null));
  const expired =
    operation?.status === "planned" && new Date(operation.plan.expiresAt).getTime() <= now;
  const canRemoveMember =
    !!capabilities?.canManage &&
    operation &&
    operation.plan.baseRevision === null &&
    operation.plan.intent === "configure" &&
    !operation.replacementPreparationId &&
    (recoverable || operation.status === "rolled_back");
  const progressHosts =
    operation?.hosts.map((host) => {
      const planned = operation.plan.hosts.find((item) => item.serverId === host.serverId)!;
      return {
        serverId: host.serverId,
        name: planned.name,
        address: planned.privateIp,
        stage: host.stage,
        steps: host.steps ?? [],
        logs: host.logs ?? [],
      };
    }) ?? [];
  const removeMemberAction = (host: { serverId: string; name: string }) =>
    operation && (
      <RemoveSetupServerButton
        source={{ operationId: id, sequence: operation.sequence, planHash: operation.planHash }}
        serverId={host.serverId}
        name={host.name}
        memberCount={operation.plan.config.members.length}
        disabled={busy}
        onRefresh={stream.reconnect}
      />
    );
  return (
    <PageContainer>
      <section className="@container/network-operation" aria-labelledby="network-operation-title">
        <Link
          href="/servers?tab=networking"
          className="mb-5 inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="size-4 rtl:rotate-180" />
          {c.backToClusters}
        </Link>
        <h1 id="network-operation-title" className="text-2xl font-semibold tracking-tight">
          {m.operationTitle}
        </h1>
        {operation && (
          <p className="mt-2 text-sm text-muted-foreground">{operation.plan.config.name}</p>
        )}
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
                  onClick={() => setAttempt((old) => old + 1)}
                  className="shrink-0 underline"
                >
                  {c.retry}
                </button>
              </div>
            )}
            {!operation && !error && !stream.error && (
              <Loader2 className="mx-auto my-16 size-5 animate-spin text-muted-foreground" />
            )}
            {operation && (
              <div className="mt-6 grid items-start gap-6 @4xl/network-operation:grid-cols-[minmax(0,1fr)_340px]">
                <div className="min-w-0 space-y-5">
                  {showFirewallReview && (
                    <ManagedNetworkTransportNotice
                      access={operation.plan.config.network.access}
                      failed={operation.report?.handshakes?.some((peer) => !peer.ok)}
                      endpoints={operation.plan.hosts
                        .filter((host) => host.action === "configure")
                        .map((host) => ({
                          ...host,
                          providerId: operation.plan.config.members.find(
                            (member) => member.serverId === host.serverId,
                          )?.providerId,
                        }))}
                    >
                      {capabilities?.canManage && requiresFirewallConfirmation && (
                        <NetworkFirewallConfirmation
                          mode="wireguard"
                          {...firewall}
                          disabled={busy || !!expired}
                        />
                      )}
                    </ManagedNetworkTransportNotice>
                  )}
                  {operation.status === "planned" ? (
                    <ManagedNetworkReview plan={operation.plan} />
                  ) : (
                    <>
                      <NetworkSetupTopology
                        network={operation.plan.config.network}
                        showFirewallRules={!showFirewallReview}
                        members={operation.plan.config.members.map((member) => ({
                          ...member,
                          name:
                            operation.plan.hosts.find((host) => host.serverId === member.serverId)
                              ?.name ?? member.serverId,
                        }))}
                        hosts={progressHosts}
                        running={running}
                        statusLabel={m.status[operation.status]}
                        completeLabel={m.status.succeeded}
                        report={operation.report}
                        observedAt={operation.updatedAt}
                        restored={operation.status === "rolled_back"}
                        onHostSelect={(serverId) => setOpenHost({ serverId })}
                      />
                      {operation.hosts.some((host) => host.steps?.length) ? (
                        <NetworkSetupProgress
                          running={running}
                          renderHostActions={canRemoveMember ? removeMemberAction : undefined}
                          hosts={progressHosts}
                          initiallyCollapsed
                          openHost={openHost}
                        />
                      ) : (
                        <div className="rounded-2xl bg-card p-5 sm:p-7">
                          <h2 className="mb-5 text-lg font-semibold">{m.progress}</h2>
                          <div
                            className="divide-y divide-border/50"
                            aria-live="polite"
                            aria-atomic="false"
                          >
                            {operation.hosts.map((host) => {
                              const planned = operation.plan.hosts.find(
                                (item) => item.serverId === host.serverId,
                              )!;
                              const Icon =
                                host.stage === "failed"
                                  ? CircleAlert
                                  : host.stage === "pending"
                                    ? Circle
                                    : Check;
                              const problem =
                                host.error ||
                                operation.report?.hosts.find(
                                  (item) => item.serverId === host.serverId,
                                )?.message;
                              return (
                                <div
                                  key={host.serverId}
                                  className="flex items-start gap-3 py-4 first:pt-0 last:pb-0"
                                >
                                  <span
                                    className={`mt-0.5 grid size-7 shrink-0 place-items-center rounded-full ${host.stage === "failed" ? "bg-warning/10 text-warning" : host.stage === "committed" ? "bg-success/10 text-success" : "bg-muted text-muted-foreground"}`}
                                  >
                                    <Icon className="size-3.5" />
                                  </span>
                                  <div className="min-w-0 flex-1">
                                    <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                                      <p className="text-sm font-medium">{planned.name}</p>
                                      <span className="text-xs text-muted-foreground">
                                        {m.stages[host.stage]}
                                      </span>
                                    </div>
                                    <p className="mt-1 font-mono text-xs text-muted-foreground">
                                      <BlurIp>{planned.privateIp}</BlurIp>
                                    </p>
                                    {problem && (
                                      <p className="mt-2 text-xs leading-relaxed text-warning">
                                        {problem}
                                      </p>
                                    )}
                                  </div>
                                  {canRemoveMember && removeMemberAction(planned)}
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      )}
                    </>
                  )}
                </div>
                <aside
                  className={`${showFirewallReview ? "order-last" : "order-first"} space-y-4 rounded-2xl bg-card p-5 @4xl/network-operation:sticky @4xl/network-operation:top-6 @4xl/network-operation:order-last`}
                >
                  <div role="status" className="flex items-center gap-2 text-sm font-semibold">
                    {running ? (
                      <Loader2 className="size-4 animate-spin text-primary" />
                    ) : recoverable ? (
                      <CircleAlert className="size-4 text-warning" />
                    ) : operation.status === "rolled_back" || operation.status === "cancelled" ? (
                      <CircleAlert className="size-4 text-warning" />
                    ) : operation.status !== "planned" ? (
                      <Check className="size-4 text-success" />
                    ) : null}
                    {m.status[operation.status]}
                  </div>
                  {operation.error && (
                    <p className="text-sm leading-relaxed text-warning">{operation.error}</p>
                  )}
                  {running && (
                    <p className="text-xs leading-relaxed text-muted-foreground">
                      {m.rollbackHint}
                    </p>
                  )}
                  {recoverable && (
                    <p className="text-xs leading-relaxed text-muted-foreground">
                      {m.recoveryHint}
                    </p>
                  )}
                  {operation.status === "rolled_back" && operation.plan.baseRevision === null && (
                    <p className="text-sm leading-relaxed text-muted-foreground">
                      {m.setupCleanedHint}
                    </p>
                  )}
                  {operation.status === "cancelled" && (
                    <p className="text-sm leading-relaxed text-muted-foreground">
                      {m.setupDiscardedHint}
                    </p>
                  )}
                  {expired && <p className="text-sm text-warning">{m.expired}</p>}
                  {operation.replacementPreparationId && (
                    <div className="space-y-3">
                      <p className="text-sm leading-relaxed text-muted-foreground">
                        {m.selectionReplacedHint}
                      </p>
                      <Button asChild className="h-auto min-h-10 w-full whitespace-normal py-2">
                        <Link
                          href={`/servers/networks/preparations/${operation.replacementPreparationId}`}
                        >
                          {m.viewUpdatedSetup}
                          <ArrowRight className="size-4 rtl:rotate-180" />
                        </Link>
                      </Button>
                    </div>
                  )}
                  {operation.plan.preparationId && (
                    <Link
                      href={`/servers/networks/preparations/${operation.plan.preparationId}`}
                      className="block text-sm font-medium text-primary hover:underline"
                    >
                      {m.viewPreparation}
                    </Link>
                  )}
                  {expired && capabilities?.canManage && operation.plan.preparationId && (
                    <Button asChild variant="outline" className="w-full">
                      <Link
                        href={`${operation.plan.baseRevision ? `/servers/networks/${operation.clusterId}/edit` : "/servers/networks/new"}?preparation=${encodeURIComponent(operation.plan.preparationId)}`}
                      >
                        {m.editSettings}
                      </Link>
                    </Button>
                  )}
                  {capabilities?.canManage && operation.status === "planned" && (
                    <Button
                      className="h-auto min-h-10 w-full whitespace-normal py-2"
                      disabled={
                        busy || !!expired || (requiresFirewallConfirmation && !firewall.checked)
                      }
                      onClick={() => void apply("apply")}
                    >
                      {busy && <Loader2 className="size-4 animate-spin" />}
                      {operation.plan.intent === "remove" ? m.removalApply : m.apply}
                    </Button>
                  )}
                  {capabilities?.canManage && recoverable && (
                    <>
                      {!operation.replacementPreparationId && (
                        <Button
                          className="h-auto min-h-10 w-full whitespace-normal py-2"
                          disabled={busy || (requiresFirewallConfirmation && !firewall.checked)}
                          onClick={() => void apply("resume")}
                        >
                          {busy && <Loader2 className="size-4 animate-spin" />}
                          {operation.plan.intent === "remove" ? m.retryCleanup : m.resume}
                        </Button>
                      )}
                      <Button
                        className="h-auto min-h-10 w-full whitespace-normal py-2"
                        variant="ghost"
                        disabled={busy}
                        onClick={() => {
                          setError(null);
                          setConfirmation("rollback");
                        }}
                      >
                        {operation.plan.baseRevision === null ? (
                          <Trash2 className="size-4" />
                        ) : (
                          <RotateCcw className="size-4" />
                        )}
                        {operation.plan.baseRevision === null ? m.cleanupSetup : m.restore}
                      </Button>
                    </>
                  )}
                  {clusterExists && (
                    <Button className="h-auto min-h-10 w-full whitespace-normal py-2" asChild>
                      <Link href={`/servers/networks/${operation.clusterId}`}>
                        {m.viewCluster}
                        <ArrowRight className="size-4 rtl:rotate-180" />
                      </Link>
                    </Button>
                  )}
                  {operation.status === "rolled_back" &&
                    operation.plan.baseRevision === null &&
                    !operation.replacementPreparationId && (
                      <Button
                        className="h-auto min-h-10 w-full whitespace-normal py-2"
                        variant="outline"
                        asChild
                      >
                        <Link href="/servers/networks/new">{c.createCluster}</Link>
                      </Button>
                    )}
                  {operation.status === "planned" && capabilities?.canManage && (
                    <Button
                      className="h-auto min-h-10 w-full whitespace-normal py-2 hover:bg-danger/10 hover:text-danger"
                      variant="ghost"
                      disabled={busy}
                      onClick={() => {
                        setError(null);
                        setConfirmation("discard");
                      }}
                    >
                      <Trash2 className="size-4" />
                      {m.discardPlan}
                    </Button>
                  )}
                  {(operation.status === "cancelled" ||
                    operation.status === "rolled_back" ||
                    (operation.status === "succeeded" && operation.plan.intent === "remove")) && (
                    <Button
                      asChild
                      className="h-auto min-h-10 w-full whitespace-normal py-2"
                      variant={
                        clusterExists || operation.replacementPreparationId ? "ghost" : "default"
                      }
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
      {confirmation && operation && (
        <NetworkSetupConfirmation
          title={
            confirmation === "discard"
              ? m.discardPlan
              : operation.plan.baseRevision === null
                ? m.cleanupSetup
                : m.restore
          }
          description={
            confirmation === "discard"
              ? m.discardDescription
              : operation.plan.baseRevision === null
                ? m.cleanupDescription
                : m.restoreDescription
          }
          confirmLabel={
            confirmation === "discard"
              ? m.discardPlan
              : operation.plan.baseRevision === null
                ? m.cleanupSetup
                : m.restore
          }
          busy={busy}
          error={error}
          onClose={() => setConfirmation(null)}
          onConfirm={() => (confirmation === "discard" ? void discard() : void apply("rollback"))}
        />
      )}
    </PageContainer>
  );
}
