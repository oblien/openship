"use client";

import { Icon as UiIcon } from "@repo/ui/icons";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import type { ComputeCluster } from "@repo/contracts";
import { clusterRuntimeConnections, clusterRuntimeRunning, type ClusterRuntime } from "@repo/core";
import { useI18n } from "@/components/i18n-provider";
import { Button } from "@/components/ui/button";
import { BlurIp } from "@/components/BlurIp";
import { useRunEvents } from "@/hooks/useRunEvents";
import { computeClustersApi } from "@/lib/api/compute-clusters";
import { getApiErrorMessage } from "@/lib/api";
import { randomUUID } from "@/lib/random-uuid";
import { NetworkDiagnosticText, NetworkSetupProgress } from "./NetworkSetupProgress";
import { NetworkSetupConfirmation } from "./NetworkSetupConfirmation";
import { NetworkStreamNotice } from "./NetworkStreamNotice";

/** Inline, durable setup; reconnecting only reads progress and never restarts installation. */
export function ClusterRuntimePanel({
  cluster,
  canManage,
}: {
  cluster: ComputeCluster;
  canManage: boolean;
}) {
  const { t } = useI18n();
  const c = t.servers.runtime;
  const [runtime, setRuntime] = useState<ClusterRuntime | null>();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [removal, setRemoval] = useState<ClusterRuntime | null>(null);
  const [rulesOpen, setRulesOpen] = useState<boolean | null>(null);
  const pending = useRef(false);
  const request = useRef<string | null>(null);
  const receive = useCallback(
    (next: ClusterRuntime | null) => {
      if (next && next.clusterId !== cluster.id)
        throw new Error("Invalid cluster runtime snapshot");
      setRuntime((previous) => {
        if (
          previous &&
          next &&
          (previous.id === next.id
            ? previous.sequence > next.sequence
            : previous.createdAt > next.createdAt)
        )
          return previous;
        return next;
      });
      if (next?.status === "removed") request.current = null;
    },
    [cluster.id],
  );
  useEffect(() => {
    let active = true;
    setRuntime(undefined);
    setError(null);
    void computeClustersApi
      .runtime(cluster.id)
      .then((next) => {
        if (active) receive(next);
      })
      .catch((err) => {
        if (active) setError(getApiErrorMessage(err));
      });
    return () => {
      active = false;
    };
  }, [cluster.id, attempt, receive]);
  const stream = useRunEvents<ClusterRuntime>(
    runtime ? `system/compute-clusters/${encodeURIComponent(cluster.id)}/runtime/stream` : null,
    receive,
  );
  const running = !!runtime && clusterRuntimeRunning(runtime.status);
  const available = runtime === null || runtime?.status === "removed";
  const showRules =
    rulesOpen ?? (cluster.network.network.mode === "native" && runtime?.status !== "ready");
  const change = async (action: "setup" | "retry" | "remove") => {
    if (!canManage || pending.current || running) return;
    pending.current = true;
    setBusy(true);
    setError(null);
    try {
      request.current ??= randomUUID();
      const next =
        action === "setup"
          ? await computeClustersApi.setupRuntime(cluster.id, cluster.revision, request.current)
          : action === "retry"
            ? await computeClustersApi.retryRuntime(cluster.id, runtime!.sequence)
            : await computeClustersApi.removeRuntime(cluster.id, removal!.sequence);
      receive(next);
      setRemoval(null);
    } catch (err) {
      setError(getApiErrorMessage(err));
      // A lost POST response may already have started work. Read its durable state once.
      try {
        receive(await computeClustersApi.runtime(cluster.id));
      } catch {
        /* Preserve the action's original error. */
      }
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };
  const hosts =
    runtime?.plan.hosts ??
    [...cluster.serverIds].sort().map((serverId, index) => ({
      serverId,
      privateIp: cluster.network.members.find((member) => member.serverId === serverId)!.privateIp,
      role:
        index < (cluster.serverIds.length >= 3 ? 3 : 1) ? ("server" as const) : ("agent" as const),
    }));
  const rules = new Map<
    string,
    { target: string; protocol: string; port: number; sources: string[] }
  >();
  for (const connection of clusterRuntimeConnections(hosts)) {
    const key = `${connection.targetServerId}:${connection.protocol}:${connection.port}`;
    const rule = rules.get(key) ?? {
      target: connection.targetServerId,
      protocol: connection.protocol.toUpperCase(),
      port: connection.port,
      sources: [],
    };
    rule.sources.push(connection.sourceIp);
    rules.set(key, rule);
  }
  return (
    <section className="mb-6 min-w-0 space-y-5" aria-labelledby="cluster-runtime-title">
      <div className="rounded-2xl bg-card p-5 sm:p-7">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex items-start gap-3">
            <span
              className={`grid size-10 shrink-0 place-items-center rounded-xl ${runtime?.status === "ready" ? "bg-success/10 text-success" : "bg-primary/10 text-primary"}`}
            >
              {running || busy ? (
                <UiIcon name="spinner" className="size-5 animate-spin" />
              ) : runtime?.status === "ready" ? (
                <UiIcon name="check-circle" className="size-5" />
              ) : (
                <UiIcon name="server-settings" className="size-5" />
              )}
            </span>
            <div>
              <h2 id="cluster-runtime-title" className="text-base font-semibold">
                {c.title}
              </h2>
              <p className="mt-1 text-sm text-muted-foreground">
                {runtime && runtime.status !== "removed" ? c.status[runtime.status] : c.description}
              </p>
            </div>
          </div>
          {canManage && (
            <div className="flex items-center gap-2">
              {available && (
                <Button onClick={() => void change("setup")} disabled={busy}>
                  <UiIcon name="play" className="size-4" />
                  {c.setup}
                </Button>
              )}
              {runtime && ["failed", "interrupted"].includes(runtime.status) && (
                <Button onClick={() => void change("retry")} disabled={busy}>
                  <UiIcon name="rotate-left" className="size-4" />
                  {t.servers.clusters.retry}
                </Button>
              )}
              {runtime && !available && !running && (
                <Button
                  variant="ghost"
                  disabled={busy}
                  onClick={() => {
                    setError(null);
                    setRemoval(runtime);
                  }}
                  aria-label={c.remove}
                >
                  <UiIcon name="trash" className="size-4" />
                </Button>
              )}
            </div>
          )}
        </div>
        {runtime === undefined && !error && (
          <UiIcon name="spinner" className="mt-5 size-4 animate-spin text-muted-foreground" />
        )}
        {error && !removal && (
          <div role="alert" className="mt-4 rounded-xl bg-danger/10 p-4 text-sm text-danger">
            <NetworkDiagnosticText value={error} />
            {runtime === undefined && (
              <Button variant="ghost" onClick={() => setAttempt((value) => value + 1)}>
                {t.servers.clusters.retry}
              </Button>
            )}
          </div>
        )}
        {runtime?.error && (
          <p role="alert" className="mt-4 rounded-xl bg-danger/10 p-4 text-sm text-danger">
            <NetworkDiagnosticText value={runtime.error} />
          </p>
        )}
        <NetworkStreamNotice stream={stream} />
        {(available || runtime) && (
          <>
            {available && <p className="mt-4 text-sm text-muted-foreground">{c.requirements}</p>}
            {runtime?.status === "ready" && (
              <div className="mt-4 space-y-3">
                <p className="text-sm text-muted-foreground">{c.readyHint}</p>
                <Link
                  href="/projects"
                  className="inline-flex items-center gap-1.5 text-sm font-medium text-primary hover:underline"
                >
                  {c.scaleProject}
                  <UiIcon name="arrow-right" className="size-4 rtl:rotate-180" />
                </Link>
                {runtime.verifiedAt && (
                  <p className="text-xs text-muted-foreground">
                    {c.lastChecked}{" "}
                    <time dateTime={runtime.verifiedAt}>
                      {new Date(runtime.verifiedAt).toLocaleString()}
                    </time>
                  </p>
                )}
              </div>
            )}
            {rules.size > 0 && (
              <details open={showRules} className="mt-5 rounded-xl bg-muted/30 p-4">
                <summary
                  className="flex cursor-pointer list-none items-center gap-2 text-sm font-medium"
                  onClick={(event) => {
                    event.preventDefault();
                    setRulesOpen(!showRules);
                  }}
                >
                  <UiIcon name="network" className="size-4 text-info" />
                  {c.privateConnections}
                  <UiIcon name="chevron-down" className="ms-auto size-4 text-muted-foreground" />
                </summary>
                <p className="mt-3 text-sm text-muted-foreground">{c.privateHint}</p>
                <div className="mt-3 divide-y divide-border/50">
                  {[...rules.entries()].map(([key, rule]) => {
                    const target = cluster.network.members.find(
                      (member) => member.serverId === rule.target,
                    )!;
                    return (
                      <div
                        key={key}
                        className="flex flex-wrap items-center justify-between gap-3 py-3 text-sm"
                      >
                        <div className="min-w-0">
                          <NetworkDiagnosticText value={`${target.name} · ${target.privateIp}`} />
                          <p className="mt-1 break-words text-xs text-muted-foreground">
                            <BlurIp>{rule.sources.join(", ")}</BlurIp>
                          </p>
                        </div>
                        <span className="shrink-0 rounded-lg bg-info/10 px-2 py-1 font-mono text-xs text-info">
                          {rule.port}/{rule.protocol}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </details>
            )}
            <details className="group mt-5 text-sm">
              <summary className="flex cursor-pointer list-none items-center gap-2 text-muted-foreground">
                {c.technicalDetails}
                <UiIcon name="chevron-down" className="size-4 transition-transform group-open:rotate-180" />
              </summary>
              <div className="mt-3 space-y-3 text-muted-foreground">
                <p>{cluster.serverIds.length >= 3 ? c.threeControls : c.oneControl}</p>
                <p>{c.requirementsDetails}</p>
                <dl className="space-y-2 text-xs">
                  <div className="flex flex-wrap justify-between gap-2">
                    <dt>{c.technology}</dt>
                    <dd>
                      K3s{runtime?.plan.version ? ` ${runtime.plan.version}` : " (Kubernetes)"}
                    </dd>
                  </div>
                  {runtime?.plan.podCidr && (
                    <div className="flex flex-wrap justify-between gap-2">
                      <dt>{c.applicationNetwork}</dt>
                      <dd className="font-mono">
                        <BlurIp>{runtime.plan.podCidr}</BlurIp>
                      </dd>
                    </div>
                  )}
                  {runtime?.plan.serviceCidr && (
                    <div className="flex flex-wrap justify-between gap-2">
                      <dt>{c.serviceNetwork}</dt>
                      <dd className="font-mono">
                        <BlurIp>{runtime.plan.serviceCidr}</BlurIp>
                      </dd>
                    </div>
                  )}
                </dl>
              </div>
            </details>
          </>
        )}
      </div>
      {runtime &&
        !available &&
        (runtime.status === "ready" ? (
          <details className="rounded-2xl bg-card p-5">
            <summary className="cursor-pointer text-sm font-medium">{c.details}</summary>
            <div className="mt-4">
              <NetworkSetupProgress
                hosts={runtime.plan.hosts}
                running={false}
                initiallyCollapsed
                logsInitiallyCollapsed
                stepLabels={c.steps}
              />
            </div>
          </details>
        ) : (
          <NetworkSetupProgress
            hosts={runtime.plan.hosts}
            running={running}
            initiallyCollapsed
            logsInitiallyCollapsed
            stepLabels={c.steps}
          />
        ))}
      {removal && (
        <NetworkSetupConfirmation
          title={c.remove}
          description={c.removeDescription}
          confirmLabel={c.remove}
          busy={busy}
          error={error}
          onClose={() => {
            if (!busy) setRemoval(null);
          }}
          onConfirm={() => void change("remove")}
        />
      )}
    </section>
  );
}
