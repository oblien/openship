"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ArrowLeft, Boxes, Eye, Loader2, RefreshCw, ScrollText, ShieldCheck, TriangleAlert, X } from "lucide-react";
import { getApiErrorMessage, swarmApi, type SwarmLogEntry, type SwarmNode, type SwarmObservation, type SwarmStackDetail, type SwarmTask } from "@/lib/api";
import { useToast } from "@/context/ToastContext";
import { PageContainer } from "@/components/ui/PageContainer";
import { HealthBadge, formatObservedAt, shortId, SwarmNodesTable, SwarmTasksTable } from "@/components/swarm/SwarmReadOnlyViews";

type StackData = {
  observation: SwarmObservation;
  detail: SwarmStackDetail | null;
  nodes: SwarmNode[];
};

type View = "services" | "tasks" | "nodes";

/**
 * An observed stack intentionally does not reuse the normal project shell:
 * that shell carries deploy, source, routing, logs, and service mutations
 * designed for standalone containers. The only state here comes from the
 * manager's read-only discovery endpoints.
 */
export function SwarmObservedProject({ projectId, projectName }: { projectId: string; projectName: string }) {
  const { showToast } = useToast();
  const [data, setData] = useState<StackData | null>(null);
  const [view, setView] = useState<View>("services");
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [scalingService, setScalingService] = useState<string | null>(null);
  const [restartingService, setRestartingService] = useState<string | null>(null);
  const [removing, setRemoving] = useState(false);
  const [inspectedService, setInspectedService] = useState<SwarmStackDetail["services"][number] | null>(null);
  const [logs, setLogs] = useState<{ serviceName: string; taskId?: string; loggingDriver: string | null; entries: SwarmLogEntry[]; following: boolean } | null>(null);
  const [loadingLogs, setLoadingLogs] = useState(false);
  const logEventSource = useRef<EventSource | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const observation = await swarmApi.observation(projectId);
      if (!observation.managerServerId) {
        setData({ observation, detail: null, nodes: [] });
        setError("This observed stack no longer has a Swarm manager target.");
        return;
      }
      const [detail, nodes] = await Promise.all([
        swarmApi.stack(observation.managerServerId, observation.stackName),
        swarmApi.nodes(observation.managerServerId),
      ]);
      setData({ observation, detail, nodes: nodes.nodes });
    } catch (cause) {
      setData(null);
      setError(getApiErrorMessage(cause, "Unable to read this observed Swarm stack."));
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => () => logEventSource.current?.close(), []);

  const stopFollowingLogs = useCallback(() => {
    logEventSource.current?.close();
    logEventSource.current = null;
    setLogs((current) => current ? { ...current, following: false } : current);
  }, []);

  const openLogs = useCallback(async (serviceName: string, taskId?: string) => {
    stopFollowingLogs();
    setLoadingLogs(true);
    try {
      const result = await swarmApi.serviceLogs(projectId, serviceName, { taskId, tail: 200, timestamps: true });
      setLogs({ ...result, following: false });
    } catch (cause) {
      showToast(getApiErrorMessage(cause, "Unable to read Swarm service logs."), "error", "Docker Swarm");
    } finally {
      setLoadingLogs(false);
    }
  }, [projectId, showToast, stopFollowingLogs]);

  const followLogs = useCallback(() => {
    if (!logs || logs.following) return;
    const eventSource = new EventSource(
      swarmApi.serviceLogStreamUrl(projectId, logs.serviceName, { taskId: logs.taskId, tail: 200, timestamps: true }),
      { withCredentials: true },
    );
    logEventSource.current = eventSource;
    setLogs((current) => current ? { ...current, following: true } : current);
    eventSource.addEventListener("log", (event) => {
      try {
        const entry = JSON.parse((event as MessageEvent).data) as SwarmLogEntry;
        setLogs((current) => current && current.serviceName === logs.serviceName && current.taskId === logs.taskId
          ? { ...current, entries: [...current.entries, entry].slice(-1_000) }
          : current);
      } catch {
        // A malformed manager line is never rendered as executable markup.
      }
    });
    eventSource.addEventListener("error", (event) => {
      const detail = event as MessageEvent<string>;
      if (typeof detail.data === "string" && detail.data) {
        try {
          const payload = JSON.parse(detail.data) as { error?: string };
          if (payload.error) showToast(payload.error, "error", "Docker Swarm");
        } catch {
          // Browser transport errors carry no application payload.
        }
      }
      stopFollowingLogs();
    });
  }, [logs, projectId, showToast, stopFollowingLogs]);

  const openTaskLogs = useCallback((task: SwarmTask) => {
    const service = data?.detail?.services.find((candidate) => candidate.id === task.serviceId);
    if (service) void openLogs(service.sourceServiceName, task.id);
  }, [data?.detail?.services, openLogs]);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      const result = await swarmApi.refreshObservation(projectId);
      showToast(
        result.changed ? "Live stack drift was detected." : "Observed stack state is current.",
        result.changed ? "info" : "success",
        "Docker Swarm",
      );
      await load();
    } catch (cause) {
      showToast(getApiErrorMessage(cause, "Unable to refresh this observed stack."), "error", "Docker Swarm");
    } finally {
      setRefreshing(false);
    }
  }, [load, projectId, showToast]);

  const removeStack = useCallback(async () => {
    const stackName = data?.observation.stackName;
    if (!stackName) return;
    const confirmed = window.prompt(`This removes all managed services in ${stackName}. Persistent volumes, networks, configs, and secrets are preserved.\n\nType the exact stack name to continue.`);
    if (confirmed === null) return;
    setRemoving(true);
    try {
      const result = await swarmApi.removeStack(projectId, confirmed);
      showToast(
        result.state === "removed" ? `Removed ${result.stackName}. Persistent resources were preserved.` : `Removal was accepted for ${result.stackName}; manager confirmation is still pending.`,
        result.state === "removed" ? "success" : "info",
        "Docker Swarm",
      );
      await load();
    } catch (cause) {
      showToast(getApiErrorMessage(cause, "Unable to remove this managed stack."), "error", "Docker Swarm");
    } finally {
      setRemoving(false);
    }
  }, [data?.observation.stackName, load, projectId, showToast]);

  const restart = useCallback(async (service: NonNullable<StackData["detail"]>["services"][number]) => {
    if (!window.confirm(`Rolling restart ${service.sourceServiceName}? Swarm will recreate its tasks using the existing update policy.`)) return;
    setRestartingService(service.sourceServiceName);
    try {
      const result = await swarmApi.restartService(projectId, service.sourceServiceName);
      showToast(
        result.state === "ready" ? `Restarted ${service.sourceServiceName}; replacement task state is current.` : `Restart for ${service.sourceServiceName} was accepted and is still reconciling.`,
        result.state === "failed" ? "error" : result.state === "reconciling" ? "info" : "success",
        "Docker Swarm",
      );
      await load();
    } catch (cause) {
      showToast(getApiErrorMessage(cause, "Unable to restart this Swarm service."), "error", "Docker Swarm");
    } finally {
      setRestartingService(null);
    }
  }, [load, projectId, showToast]);

  const scale = useCallback(async (service: NonNullable<StackData["detail"]>["services"][number]) => {
    const submitted = window.prompt(`Desired replicas for ${service.sourceServiceName}`, String(service.desiredReplicas ?? 1));
    if (submitted === null) return;
    if (!/^\d+$/.test(submitted) || Number(submitted) > 10_000) {
      showToast("Enter a replica count from 0 to 10,000.", "error", "Docker Swarm");
      return;
    }
    const persistence = window.confirm("Keep this replica target in the authoritative inline stack source?\n\nCancel keeps it as a temporary operational override that the next source deploy can restore.")
      ? "inline-source" as const
      : "temporary" as const;
    setScalingService(service.sourceServiceName);
    try {
      const result = await swarmApi.scaleService(projectId, service.sourceServiceName, {
        replicas: Number(submitted),
        persistence,
      });
      showToast(
        result.sourcePersisted
          ? `Scaled ${service.sourceServiceName} and updated inline source. Redeploy source to make the revision authoritative.`
          : `Scaled ${service.sourceServiceName}. It is recorded as operational drift until source is reapplied.`,
        result.state === "failed" ? "error" : result.state === "reconciling" ? "info" : "success",
        "Docker Swarm",
      );
      await load();
    } catch (cause) {
      showToast(getApiErrorMessage(cause, "Unable to scale this Swarm service."), "error", "Docker Swarm");
    } finally {
      setScalingService(null);
    }
  }, [load, projectId, showToast]);

  return (
    <PageContainer>
      <div className="mb-6 flex items-center gap-3">
        <Link href="/projects" className="inline-flex size-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground" aria-label="Back to projects"><ArrowLeft className="size-4" /></Link>
        <div className="min-w-0 flex-1"><div className="mb-1 flex items-center gap-2 text-sm text-muted-foreground"><span>Projects</span><span>/</span><span className="truncate">{projectName}</span></div><h1 className="truncate text-2xl font-semibold text-foreground">{projectName}</h1></div>
      </div>

          <section className="mb-6 rounded-2xl border border-primary/25 bg-primary/[0.04] p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex items-start gap-3"><div className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary"><Eye className="size-4" /></div><div><div className="flex flex-wrap items-center gap-2"><h2 className="font-semibold text-foreground">{data?.observation.managementMode === "managed" ? "Managed Docker Swarm stack" : "Observed Docker Swarm stack"}</h2><span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${data?.observation.managementMode === "managed" ? "bg-success/10 text-success" : "bg-warning/10 text-warning"}`}>{data?.observation.managementMode === "managed" ? "Managed" : "Read-only"}</span></div><p className="mt-1 max-w-3xl text-sm leading-relaxed text-muted-foreground">{data?.observation.managementMode === "managed" ? "OpenShip owns this labeled stack. Refresh is read-only; routine service operations are guarded by its authoritative source and current manager state." : "This stack remains externally controlled. OpenShip reads manager state and records drift; it will not scale, restart, redeploy, remove, route, or edit services, tasks, networks, configs, secrets, or volumes."}</p></div></div>
          <div className="flex items-center gap-2"><button type="button" disabled={refreshing || loading || removing} onClick={() => void refresh()} className="inline-flex items-center gap-2 rounded-xl border border-border bg-card px-3 py-2 text-sm font-medium text-foreground hover:bg-muted disabled:opacity-60">{refreshing ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}{data?.observation.managementMode === "managed" ? "Refresh manager state" : "Refresh safely"}</button>{data?.observation.managementMode === "managed" && <button type="button" disabled={removing || loading} onClick={() => void removeStack()} className="inline-flex items-center gap-2 rounded-xl border border-danger/30 bg-danger-bg px-3 py-2 text-sm font-medium text-danger hover:bg-danger/10 disabled:opacity-60">{removing ? <Loader2 className="size-3.5 animate-spin" /> : <TriangleAlert className="size-3.5" />}Remove stack</button>}</div>
        </div>
      </section>

      {loading && <div className="flex min-h-72 items-center justify-center rounded-2xl border border-border/50 bg-card"><Loader2 className="size-5 animate-spin text-muted-foreground" /></div>}

      {!loading && error && !data && (
        <section className="rounded-2xl border border-danger/20 bg-card p-6"><div className="flex items-start gap-3"><div className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-danger-bg text-danger"><TriangleAlert className="size-4" /></div><div><h2 className="font-semibold text-foreground">Manager state is unavailable</h2><p className="mt-1 text-sm text-muted-foreground">{error}</p><button type="button" onClick={() => void load()} className="mt-4 rounded-xl border border-border px-3 py-2 text-sm font-medium text-foreground hover:bg-muted">Try again</button></div></div></section>
      )}

      {data && (
        <div className="space-y-6">
          {error && <p className="rounded-xl border border-warning/25 bg-warning/5 px-4 py-3 text-sm text-warning">{error}</p>}
          <section className="rounded-2xl border border-border/50 bg-card p-5"><div className="flex flex-wrap items-center justify-between gap-4"><div><div className="flex items-center gap-2"><Boxes className="size-4 text-muted-foreground" /><h2 className="font-semibold text-foreground">{data.observation.stackName}</h2><HealthBadge state={data.observation.managementMode === "observe" ? "observed" : data.observation.managementMode} /></div><p className="mt-1 text-sm text-muted-foreground">Cluster {shortId(data.observation.clusterId)} · {data.observation.revisionId ? `Applied revision ${shortId(data.observation.revisionId)} · ` : "No applied OpenShip revision · "}Last observed {formatObservedAt(data.observation.drift.lastObservedAt)}</p></div><HealthBadge state={data.observation.drift.status} /></div><div className="mt-5 grid grid-cols-1 gap-4 sm:grid-cols-3"><StatusCard label="Source" value={data.observation.source.status} description={sourceDescription(data.observation.source.status)} /><StatusCard label="Live drift" value={data.observation.drift.status} description={driftDescription(data.observation.drift.status)} /><StatusCard label="Workload controls" value={data.observation.managementMode === "managed" ? "Managed" : "Unavailable"} description={data.observation.managementMode === "managed" ? "Scale is available for owned replicated services. It remains operational drift until a reviewed source deploy." : "Observe mode has no workload mutation actions."} /></div></section>

          {data.detail && <section className="rounded-2xl border border-border/50 bg-card"><div className="flex flex-wrap items-center justify-between gap-3 border-b border-border/50 px-5 py-4"><div><h2 className="font-semibold text-foreground">Live stack state</h2><p className="mt-0.5 text-sm text-muted-foreground">Manager read at {formatObservedAt(data.detail.observedAt)}.</p></div><HealthBadge state={data.detail.health.state} /></div><div className="flex border-b border-border/50 px-3">{(["services", "tasks", "nodes"] as View[]).map((candidate) => <button key={candidate} type="button" onClick={() => setView(candidate)} className={`relative px-4 py-3 text-sm font-medium capitalize transition-colors ${view === candidate ? "text-foreground" : "text-muted-foreground hover:text-foreground"}`}>{candidate}{view === candidate && <span className="absolute inset-x-4 bottom-0 h-0.5 rounded-full bg-primary" />}</button>)}</div><div className="p-5">{view === "services" && <Services detail={data.detail} managed={data.observation.managementMode === "managed"} scalingService={scalingService} restartingService={restartingService} onScale={scale} onRestart={restart} onLogs={(service) => void openLogs(service.sourceServiceName)} onInspect={setInspectedService} loadingLogs={loadingLogs} />}{view === "tasks" && <SwarmTasksTable tasks={data.detail.tasks} onLogs={openTaskLogs} />}{view === "nodes" && <SwarmNodesTable nodes={data.nodes} />}</div></section>}

          {inspectedService && <ServiceInspectPanel service={inspectedService} onClose={() => setInspectedService(null)} />}

          {logs && <ServiceLogsPanel logs={logs} loading={loadingLogs} onFollow={followLogs} onStop={stopFollowingLogs} onClose={() => { stopFollowingLogs(); setLogs(null); }} />}

          {data.observation.managementMode === "observe" && <section className="rounded-2xl border border-border/50 bg-card p-5"><div className="flex items-start gap-3"><div className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-muted text-muted-foreground"><ShieldCheck className="size-4" /></div><div><h2 className="font-semibold text-foreground">Why actions are disabled</h2><p className="mt-1 max-w-3xl text-sm leading-relaxed text-muted-foreground">The stack may be managed through Portainer, Docker CLI, GitOps, or another controller. Leaving those actions unavailable prevents OpenShip from becoming a competing writer while you evaluate the integration.</p></div></div></section>}
        </div>
      )}
    </PageContainer>
  );
}

function StatusCard({ label, value, description }: { label: string; value: string; description: string }) {
  return <div className="rounded-xl border border-border/50 bg-muted/[0.18] p-4"><p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{label}</p><div className="mt-2"><HealthBadge state={value} /></div><p className="mt-3 text-sm leading-relaxed text-muted-foreground">{description}</p></div>;
}

function Services({ detail, managed, scalingService, restartingService, onScale, onRestart, onLogs, onInspect, loadingLogs }: {
  detail: SwarmStackDetail;
  managed: boolean;
  scalingService: string | null;
  restartingService: string | null;
  onScale: (service: SwarmStackDetail["services"][number]) => void;
  onRestart: (service: SwarmStackDetail["services"][number]) => void;
  onLogs: (service: SwarmStackDetail["services"][number]) => void;
  onInspect: (service: SwarmStackDetail["services"][number]) => void;
  loadingLogs: boolean;
}) {
  if (detail.services.length === 0) return <p className="py-6 text-center text-sm text-muted-foreground">No services were returned for this stack.</p>;
  return <div className="space-y-2">{detail.services.map((service) => <div key={service.id} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border/50 px-4 py-3"><div className="min-w-0"><p className="font-medium text-foreground">{service.sourceServiceName}</p><p className="mt-0.5 truncate font-mono text-xs text-muted-foreground">{service.image || "No image reported"}</p>{service.updateState && <p className="mt-1 text-xs text-muted-foreground">Update: {service.updateState}</p>}</div><div className="flex items-center gap-3 text-sm text-muted-foreground"><span className="capitalize">{service.mode}</span><span>{service.desiredReplicas === null ? "No replica target" : `${service.desiredReplicas} desired`}</span><button type="button" onClick={() => onInspect(service)} className="rounded-lg border border-border px-2.5 py-1 text-xs font-medium text-foreground hover:bg-muted">Inspect</button><button type="button" disabled={loadingLogs} onClick={() => onLogs(service)} className="inline-flex items-center gap-1 rounded-lg border border-border px-2.5 py-1 text-xs font-medium text-foreground hover:bg-muted disabled:opacity-60"><ScrollText className="size-3" />{loadingLogs ? "Loading…" : "Logs"}</button>{managed && service.mode === "replicated" && <button type="button" disabled={scalingService !== null || restartingService !== null} onClick={() => onScale(service)} className="rounded-lg border border-border px-2.5 py-1 text-xs font-medium text-foreground hover:bg-muted disabled:opacity-60">{scalingService === service.sourceServiceName ? "Scaling…" : "Scale"}</button>}{managed && !service.mode.endsWith("-job") && <button type="button" disabled={scalingService !== null || restartingService !== null} onClick={() => onRestart(service)} className="rounded-lg border border-border px-2.5 py-1 text-xs font-medium text-foreground hover:bg-muted disabled:opacity-60">{restartingService === service.sourceServiceName ? "Restarting…" : "Restart"}</button>}</div></div>)}</div>;
}

function ServiceInspectPanel({ service, onClose }: { service: SwarmStackDetail["services"][number]; onClose: () => void }) {
  const resources = [
    ["Networks", service.networks.join(", ") || "None reported"],
    ["Published ports", service.publishedPorts.map((port) => `${port.published ?? "—"} → ${port.target}/${port.protocol} (${port.mode})`).join(", ") || "None"],
    ["Configs", service.configs.join(", ") || "None"],
    ["Secrets", service.secrets.join(", ") || "None"],
    ["Volumes", service.volumes?.join(", ") || "None"],
  ];
  return <section className="rounded-2xl border border-border/50 bg-card p-5"><div className="flex items-start justify-between gap-4"><div><h2 className="font-semibold text-foreground">{service.sourceServiceName} inspection</h2><p className="mt-1 font-mono text-xs text-muted-foreground">Service {shortId(service.id)} · spec v{service.specVersion ?? "—"} · {service.endpointMode || "default"} endpoint</p></div><button type="button" onClick={onClose} className="inline-flex size-7 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground" aria-label="Close inspection"><X className="size-4" /></button></div><div className="mt-4 grid gap-3 sm:grid-cols-2">{resources.map(([label, value]) => <div key={label} className="rounded-xl border border-border/50 bg-muted/[0.18] p-3"><p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{label}</p><p className="mt-1 break-words text-sm text-foreground">{value}</p></div>)}</div>{service.volumes?.length ? <p className="mt-4 rounded-xl border border-warning/25 bg-warning/5 px-3 py-2 text-sm text-warning">Named volumes can be node-local in Swarm. Verify placement and backup coverage before moving or removing this service.</p> : null}</section>;
}

function ServiceLogsPanel({ logs, loading, onFollow, onStop, onClose }: {
  logs: { serviceName: string; taskId?: string; loggingDriver: string | null; entries: SwarmLogEntry[]; following: boolean };
  loading: boolean;
  onFollow: () => void;
  onStop: () => void;
  onClose: () => void;
}) {
  return <section className="rounded-2xl border border-border/50 bg-card"><div className="flex flex-wrap items-center justify-between gap-3 border-b border-border/50 px-5 py-4"><div><div className="flex items-center gap-2"><ScrollText className="size-4 text-muted-foreground" /><h2 className="font-semibold text-foreground">{logs.serviceName} logs{logs.taskId ? ` · ${shortId(logs.taskId)}` : ""}</h2></div><p className="mt-0.5 text-sm text-muted-foreground">{logs.loggingDriver ? `${logs.loggingDriver} driver` : "Docker default driver"} · sensitive values are redacted before display.</p></div><div className="flex items-center gap-2"><button type="button" disabled={loading || logs.following} onClick={onFollow} className="rounded-lg border border-border px-2.5 py-1.5 text-xs font-medium text-foreground hover:bg-muted disabled:opacity-60">{logs.following ? "Following" : "Follow"}</button>{logs.following && <button type="button" onClick={onStop} className="rounded-lg border border-border px-2.5 py-1.5 text-xs font-medium text-foreground hover:bg-muted">Stop</button>}<button type="button" onClick={onClose} className="inline-flex size-7 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground" aria-label="Close logs"><X className="size-4" /></button></div></div><pre className="max-h-[32rem] overflow-auto whitespace-pre-wrap break-words bg-muted/[0.2] p-5 font-mono text-xs leading-5 text-foreground">{logs.entries.length ? logs.entries.map((entry, index) => <span key={`${entry.timestamp ?? "none"}-${index}`} className={entry.level === "error" ? "text-danger" : entry.level === "warn" ? "text-warning" : undefined}>{entry.timestamp ? `${entry.timestamp} ` : ""}{entry.message}{"\n"}</span>) : "No log entries were returned."}</pre></section>;
}

function sourceDescription(status: SwarmObservation["source"]["status"]): string {
  if (status === "missing") return "Live inspection cannot reconstruct the original stack source.";
  if (status === "valid") return "A linked source was rendered successfully without changing the stack.";
  if (status === "invalid") return "The linked source needs correction before it can be compared.";
  return "Source is linked but has not been rendered against the manager yet.";
}

function driftDescription(status: SwarmObservation["drift"]["status"]): string {
  if (status === "clean") return "The most recent safe observation matches the prior live state.";
  if (status === "drifted") return "The live stack changed outside OpenShip since the prior observation.";
  if (status === "unreachable") return "The manager could not be reached for the latest refresh.";
  return "Refresh safely to establish the current observed state.";
}
