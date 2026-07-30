"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  Boxes,
  CheckCircle2,
  ChevronRight,
  CircleAlert,
  Clock,
  Copy,
  Loader2,
  RefreshCw,
  RotateCcw,
  XCircle,
} from "lucide-react";
import {
  ApiError,
  deployApi,
  getApiErrorMessage,
  swarmApi,
  type SwarmBuildPhaseStatus,
  type SwarmBuildStatus,
  type SwarmObservation,
  type SwarmStackDetail,
  type SwarmStackSource,
} from "@/lib/api";
import { useDeployment } from "@/context/DeploymentContext";
import { shortId } from "@/components/swarm/SwarmReadOnlyViews";
import { interpolate, useI18n } from "@/components/i18n-provider";
import { Modal } from "@/components/ui/Modal";

type LiveStackState = {
  observation: SwarmObservation;
  source: SwarmStackSource;
  detail: SwarmStackDetail | null;
};

const PHASES: ReadonlyArray<{
  id: "swarm-source" | "swarm-render" | "swarm-build" | "swarm-push" | "swarm-apply" | "swarm-converge" | "swarm-route" | "swarm-reconcile";
  labelKey: "source" | "validate" | "build" | "push" | "apply" | "converge" | "route" | "reconcile";
  optional?: boolean;
}> = [
  { id: "swarm-source", labelKey: "source" },
  { id: "swarm-render", labelKey: "validate" },
  { id: "swarm-build", labelKey: "build", optional: true },
  { id: "swarm-push", labelKey: "push", optional: true },
  { id: "swarm-apply", labelKey: "apply" },
  { id: "swarm-converge", labelKey: "converge" },
  { id: "swarm-route", labelKey: "route" },
  { id: "swarm-reconcile", labelKey: "reconcile", optional: true },
] as const;

function formatDuration(value?: number): string {
  if (value === undefined) return "";
  const seconds = Math.max(0, Math.round(value / 1000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
}

function phaseLabel(status: SwarmBuildPhaseStatus | undefined, optional?: boolean) {
  if (status === "completed") return "Complete";
  if (status === "failed") return "Failed";
  if (status === "skipped" || optional) return optional ? "Not needed" : "Skipped";
  if (status === "running") return "In progress";
  return "Waiting";
}

function isAbsentStack(error: unknown): boolean {
  return error instanceof ApiError && error.status === 404;
}

function taskPlacement(serviceId: string, tasks: SwarmStackDetail["tasks"]) {
  const serviceTasks = tasks.filter((task) => task.serviceId === serviceId);
  const desired = serviceTasks.filter((task) => task.desiredState.toLowerCase() === "running").length;
  const running = serviceTasks.filter((task) => /^running\b/i.test(task.currentState.trim())).length;
  const failed = serviceTasks.filter((task) => /\b(failed|rejected)\b/i.test(task.currentState)).length;
  const errors = serviceTasks.flatMap((task) => task.error ? [task.error] : []);
  const nodes = [...new Set(serviceTasks.map((task) => task.nodeName || (task.nodeId ? shortId(task.nodeId) : null)).filter((node): node is string => !!node))];
  const failureKind = errors.some((error) => /pull access denied|image.*not found|no such image|manifest unknown|pulling image/i.test(error))
    ? "image pull"
    : errors.some((error) => /no suitable node|placement constraint|constraint.*match/i.test(error))
      ? "placement"
      : "task";
  const state = failed > 0 || errors.length > 0 ? "failed" : desired > 0 && running >= desired ? "ready" : "converging";
  return { desired, running, failed, nodes, errors, failureKind, state };
}

/**
 * Stack-native deployment detail. It deliberately reloads the persisted build
 * projection and manager observations, so it stays useful after SSE loss,
 * browser refresh, or an API restart while Swarm is still converging.
 */
export default function SwarmDeploymentProcessing({
  onRedeploy,
}: {
  onRedeploy: () => void | Promise<string | null>;
}) {
  const router = useRouter();
  const { t } = useI18n();
  const { state } = useDeployment();
  const deploymentId = state.deploymentId;
  const [status, setStatus] = useState<SwarmBuildStatus | null>(null);
  const [live, setLive] = useState<LiveStackState | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [rollingBack, setRollingBack] = useState(false);
  const [confirmingRollback, setConfirmingRollback] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (silent = false) => {
    if (!deploymentId) return;
    if (silent) setRefreshing(true);
    else setLoading(true);
    setError(null);
    try {
      const nextStatus = await deployApi.getSwarmBuildStatus(deploymentId);
      setStatus(nextStatus);
      const projectId = nextStatus.project_id;
      const [observation, source] = await Promise.all([
        swarmApi.observation(projectId),
        swarmApi.source(projectId),
      ]);
      if (!observation.managerServerId) {
        setLive({ observation, source, detail: null });
        setError("This stack no longer has a verified Swarm manager target.");
        return;
      }
      try {
        const detail = await swarmApi.stack(observation.managerServerId, observation.stackName);
        setLive({ observation, source, detail });
      } catch (cause) {
        if (isAbsentStack(cause)) {
          setLive({ observation, source, detail: null });
          return;
        }
        throw cause;
      }
    } catch (cause) {
      setError(getApiErrorMessage(cause, "Unable to load the Swarm deployment detail."));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [deploymentId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const isActive = status?.is_active || status?.deploymentStatus === "reconciling";
    if (!isActive) return;
    const interval = window.setInterval(() => void load(true), 3_000);
    return () => window.clearInterval(interval);
  }, [load, status?.deploymentStatus, status?.is_active]);

  const phaseStates = status?.phaseStatuses ?? {};
  const allPhases = useMemo(
    () => PHASES.map((phase) => ({
      ...phase,
      label: t.swarm.deployment.phases[phase.labelKey],
      status: phaseStates[phase.id],
      duration: status?.phaseDurations[phase.id],
    })),
    [phaseStates, status?.phaseDurations, t.swarm.deployment.phases],
  );
  const deploymentStatus = status?.deploymentStatus ?? (state.isDeploying ? "deploying" : "queued");
  const isTerminalFailure = deploymentStatus === "failed" || deploymentStatus === "cancelled";
  const canRollback = !!status?.swarm?.revision && !status.swarm.isActive && deploymentStatus === "ready";

  const rollback = async () => {
    if (!deploymentId || !status?.swarm?.revision || rollingBack) return;
    setRollingBack(true);
    try {
      const result = await deployApi.rollback(deploymentId);
      const nextId = result?.data?.id as string | undefined;
      if (nextId) router.push(`/build/${nextId}`);
      else await load(true);
      setConfirmingRollback(false);
    } catch (cause) {
      setError(getApiErrorMessage(cause, "Unable to start the Swarm rollback."));
    } finally {
      setRollingBack(false);
    }
  };

  if (loading && !status) {
    return <div className="flex min-h-screen items-center justify-center bg-background"><Loader2 className="size-5 animate-spin text-muted-foreground" /></div>;
  }

  return <main className="mx-auto min-h-screen max-w-[1400px] bg-background px-4 py-6 sm:px-6 lg:px-8">
    <header className="mb-6 flex flex-wrap items-start justify-between gap-4">
      <div className="flex min-w-0 items-start gap-3">
        <div className="flex size-11 shrink-0 items-center justify-center rounded-xl border border-border/50 bg-muted/40">
          {isTerminalFailure ? <XCircle className="size-5 text-danger" /> : deploymentStatus === "ready" ? <CheckCircle2 className="size-5 text-success" /> : <Loader2 className="size-5 animate-spin text-primary" />}
        </div>
        <div className="min-w-0">
          <p className="text-sm text-muted-foreground">Docker Swarm deployment</p>
          <h1 className="truncate text-xl font-semibold text-foreground">{status?.config.projectName || live?.observation.stackName || "Stack deployment"}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{deploymentStatus === "reconciling" ? "Apply outcome is being reconciled from manager state." : deploymentStatus === "ready" ? "Stack is converged on its manager." : isTerminalFailure ? "The stack was not applied successfully." : "OpenShip is recording durable phase state as the stack progresses."}</p>
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        {status?.project_id && <Link href={`/projects/${status.project_id}/overview`} className="rounded-xl border border-border bg-card px-3 py-2 text-sm font-medium text-foreground hover:bg-muted">Project</Link>}
        <button type="button" disabled={refreshing} onClick={() => void load(true)} className="inline-flex items-center gap-2 rounded-xl border border-border bg-card px-3 py-2 text-sm font-medium text-foreground hover:bg-muted disabled:opacity-60">{refreshing ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}Refresh</button>
      </div>
    </header>

    {error && <section role="alert" className="mb-6 rounded-2xl border border-danger/25 bg-danger-bg/35 px-4 py-3 text-sm text-danger">{error}</section>}
    {status?.warningMessage && <section className="mb-6 rounded-2xl border border-warning/25 bg-warning/5 px-4 py-3 text-sm text-warning">{status.warningMessage}</section>}
    {status?.failureMessage && <section className="mb-6 rounded-2xl border border-danger/25 bg-danger-bg/35 px-4 py-3 text-sm text-danger">{status.failureMessage}</section>}

    <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_360px]">
      <div className="space-y-6">
        <section className="rounded-2xl border border-border/50 bg-card p-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div><h2 className="font-semibold text-foreground">Deployment phases</h2><p className="mt-1 text-sm text-muted-foreground">Every phase is persisted, so this timeline remains accurate after refresh.</p></div>
            {deploymentStatus === "reconciling" && <span className="rounded-full bg-warning/10 px-2 py-1 text-xs font-medium text-warning">Reconciling manager state</span>}
          </div>
          <ol className="mt-5 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {allPhases.map((phase, index) => <li key={phase.id} className={`rounded-xl border p-3 ${phase.status === "failed" ? "border-danger/25 bg-danger-bg/35" : phase.status === "running" ? "border-primary/35 bg-primary/[0.035]" : "border-border/50 bg-muted/[0.16]"}`}>
              <div className="flex items-center justify-between gap-2"><span className="text-xs font-medium text-muted-foreground">{index + 1}</span>{phase.status === "running" ? <Loader2 className="size-3.5 animate-spin text-primary" /> : phase.status === "completed" ? <CheckCircle2 className="size-3.5 text-success" /> : phase.status === "failed" ? <XCircle className="size-3.5 text-danger" /> : <Clock className="size-3.5 text-muted-foreground" />}</div>
              <p className="mt-3 text-sm font-medium text-foreground">{phase.label}</p>
              <p className="mt-1 text-xs text-muted-foreground">{phaseLabel(phase.status, phase.optional)}{phase.duration !== undefined ? ` · ${formatDuration(phase.duration)}` : ""}</p>
            </li>)}
          </ol>
        </section>

        <section className="rounded-2xl border border-border/50 bg-card p-5">
          <div className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="font-semibold text-foreground">Revision and effective configuration</h2><p className="mt-1 text-sm text-muted-foreground">Only review-safe identities and digests are shown; source and secret contents are never exposed here.</p></div>{status?.swarm?.revision && <span className="rounded-full bg-muted px-2 py-1 text-xs font-medium text-muted-foreground">Revision {status.swarm.revision.revision}</span>}</div>
          <div className="mt-4 grid gap-3 sm:grid-cols-3">
            <DigestCard label="Source digest" value={status?.swarm?.sourceDigest || status?.swarm?.revision?.sourceDigest || null} />
            <DigestCard label="Rendered digest" value={status?.swarm?.revision?.renderedDigest || null} />
            <DigestCard label="Live digest" value={live?.observation.drift.digest || null} />
          </div>
          {status?.swarm?.revisionDiff && <div className="mt-5 rounded-xl border border-border/50 bg-muted/[0.16] p-4"><div className="flex items-center gap-2"><Copy className="size-4 text-muted-foreground" /><h3 className="text-sm font-semibold text-foreground">Revision diff</h3></div><p className="mt-1 text-xs text-muted-foreground">{status.swarm.revisionDiff.previousRevision ? `Compared with revision ${status.swarm.revisionDiff.previousRevision.revision}.` : "No previous OpenShip-managed revision exists."}</p><ul className="mt-3 space-y-2 text-sm text-foreground">{status.swarm.revisionDiff.changes.length ? status.swarm.revisionDiff.changes.map((change) => <li key={change} className="flex gap-2"><ChevronRight className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />{change}</li>) : <li className="text-muted-foreground">No effective image or resource identity changes were recorded.</li>}</ul></div>}
          {(status?.swarm?.revision?.resourceIdentities.length ?? 0) > 0 && <details className="mt-4"><summary className="cursor-pointer text-sm font-medium text-foreground">Effective resource identities</summary><div className="mt-3 grid gap-2 sm:grid-cols-2">{status!.swarm!.revision!.resourceIdentities.map((resource) => <div key={`${resource.kind}:${resource.logicalName}`} className="rounded-lg border border-border/50 bg-muted/[0.16] p-3"><p className="text-xs text-muted-foreground">{resource.kind} · {resource.logicalName}</p><p className="mt-1 break-all font-mono text-xs text-foreground">{resource.effectiveName}</p><p className="mt-1 text-xs text-muted-foreground">{resource.external ? "External/controller-owned" : "Stack-managed"}</p></div>)}</div></details>}
        </section>

        <section className="rounded-2xl border border-border/50 bg-card p-5">
          <div className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="font-semibold text-foreground">Service convergence and placement</h2><p className="mt-1 text-sm text-muted-foreground">Live manager state, not task-container guesses.</p></div>{live?.detail && <span className="rounded-full bg-muted px-2 py-1 text-xs font-medium text-muted-foreground">{live.detail.services.length} services</span>}</div>
          {!live?.detail ? <div className="mt-4 space-y-2">{(status?.swarm?.services.length ?? 0) > 0 ? status!.swarm!.services.map((service) => <div key={service.serviceId} className="rounded-xl border border-border/50 p-3"><div className="flex items-center justify-between gap-3"><p className="font-medium text-foreground">{service.serviceName || shortId(service.serviceId)}</p><p className={`text-xs ${service.status === "failure" ? "text-danger" : "text-muted-foreground"}`}>{service.status}</p></div>{service.errorMessage && <p className="mt-2 text-xs text-danger">{service.errorMessage}</p>}</div>) : <p className="rounded-xl border border-border/50 bg-muted/[0.16] px-3 py-3 text-sm text-muted-foreground">No live services are currently reported for this namespace. This is expected before the first apply or while the manager is unavailable.</p>}</div> : <div className="mt-4 space-y-2">{live.detail.services.map((service) => {
            const placement = taskPlacement(service.id, live.detail!.tasks);
            const recorded = status?.swarm?.services.find((item) => item.serviceName === service.sourceServiceName);
            const error = recorded?.errorMessage || placement.errors[0];
            return <div key={service.id} className="rounded-xl border border-border/50 p-3"><div className="flex flex-wrap items-center justify-between gap-3"><div className="min-w-0"><p className="font-medium text-foreground">{service.sourceServiceName}</p><p className="mt-0.5 truncate font-mono text-xs text-muted-foreground">{service.image || recorded?.imageDigest || recorded?.imageRef || "No image reported"}</p><p className="mt-1 text-xs text-muted-foreground">Nodes: {placement.nodes.join(", ") || "pending placement"}</p></div><div className="text-right"><p className="text-sm font-medium text-foreground">{placement.running}/{placement.desired || service.desiredReplicas || "?"} running</p><p className={`mt-1 text-xs ${placement.state === "ready" ? "text-success" : placement.state === "failed" ? "text-danger" : "text-warning"}`}>{placement.state === "failed" ? `${placement.failureKind} failure` : placement.state}{placement.failed > 0 ? ` · ${placement.failed} failed` : ""}</p></div></div>{error && <p className="mt-2 text-xs text-danger">{error}</p>}</div>;
          })}</div>}
        </section>
      </div>

      <aside className="space-y-6">
        <section className="rounded-2xl border border-border/50 bg-card p-5"><div className="flex items-center gap-2"><Boxes className="size-4 text-muted-foreground" /><h2 className="font-semibold text-foreground">Stack target</h2></div><dl className="mt-4 space-y-3 text-sm"><DetailRow label="Stack" value={status?.swarm?.stackName || live?.observation.stackName || "—"} mono /><DetailRow label="Ownership" value={status?.swarm?.managementMode === "managed" ? "OpenShip managed" : "Read-only / observed"} /><DetailRow label="Cluster" value={status?.swarm?.clusterId ? shortId(status.swarm.clusterId) : "—"} mono /><DetailRow label="Manager" value={status?.swarm?.managerServerId ? shortId(status.swarm.managerServerId) : "—"} mono /><DetailRow label="Routing" value={status?.swarm?.revision?.routingMode === "openship-edge" ? "OpenShip Edge" : "External"} /></dl></section>
        <section className="rounded-2xl border border-border/50 bg-card p-5"><h2 className="font-semibold text-foreground">Actions</h2><div className="mt-4 space-y-2"><button type="button" onClick={() => void onRedeploy()} className="flex w-full items-center justify-center gap-2 rounded-xl bg-primary px-3 py-2.5 text-sm font-medium text-primary-foreground hover:bg-primary/90"><RefreshCw className="size-3.5" />{t.swarm.deployment.redeploy}</button>{canRollback && <button type="button" disabled={rollingBack} onClick={() => setConfirmingRollback(true)} className="flex w-full items-center justify-center gap-2 rounded-xl border border-border px-3 py-2.5 text-sm font-medium text-foreground hover:bg-muted disabled:opacity-60">{rollingBack ? <Loader2 className="size-3.5 animate-spin" /> : <RotateCcw className="size-3.5" />}{t.swarm.deployment.rollback}</button>}<p className="pt-1 text-xs leading-relaxed text-muted-foreground">Rollback reapplies this immutable rendered revision; it does not load editable source or delete persistent volumes.</p></div></section>
        {deploymentStatus === "reconciling" && <section className="rounded-2xl border border-warning/25 bg-warning/5 p-5"><div className="flex items-start gap-3"><CircleAlert className="mt-0.5 size-4 shrink-0 text-warning" /><div><h2 className="font-semibold text-foreground">Waiting for manager truth</h2><p className="mt-1 text-sm text-muted-foreground">OpenShip will re-read stack services and settle this deployment without issuing speculative rollback or removal commands.</p></div></div></section>}
      </aside>
    </div>
    <Modal isOpen={confirmingRollback} onClose={() => setConfirmingRollback(false)} ariaLabel={t.swarm.deployment.rollback}>
      <div className="p-6">
        <h2 className="text-lg font-semibold text-foreground">{t.swarm.deployment.rollback}</h2>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{status?.swarm?.revision ? interpolate(t.swarm.deployment.rollbackConfirm, { revision: String(status.swarm.revision.revision) }) : ""}</p>
        <div className="mt-5 flex justify-end gap-2"><button type="button" onClick={() => setConfirmingRollback(false)} className="rounded-lg border border-border px-3 py-2 text-sm font-medium text-foreground hover:bg-muted">Cancel</button><button type="button" data-autofocus disabled={rollingBack} onClick={() => void rollback()} className="inline-flex items-center gap-2 rounded-lg bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-60">{rollingBack && <Loader2 className="size-3.5 animate-spin" />}{t.swarm.deployment.rollback}</button></div>
      </div>
    </Modal>
  </main>;
}

function DigestCard({ label, value }: { label: string; value: string | null }) {
  return <div className="rounded-xl border border-border/50 bg-muted/[0.16] p-3"><p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{label}</p><p className="mt-2 break-all font-mono text-xs text-foreground">{value ? shortId(value) : "Not recorded yet"}</p></div>;
}

function DetailRow({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return <div className="flex items-center justify-between gap-3"><dt className="text-muted-foreground">{label}</dt><dd className={`max-w-[65%] truncate text-right text-foreground ${mono ? "font-mono text-xs" : ""}`}>{value}</dd></div>;
}
