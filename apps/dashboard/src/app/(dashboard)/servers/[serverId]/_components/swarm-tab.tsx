"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Boxes, ChevronDown, ChevronUp, Eye, Loader2, RefreshCw, Server, ShieldCheck, TriangleAlert } from "lucide-react";
import { getApiErrorMessage, swarmApi, type SwarmDiscoveryView, type SwarmNode, type SwarmStackDetail, type SwarmSummary } from "@/lib/api";
import { useToast } from "@/context/ToastContext";
import { HealthBadge, formatObservedAt, shortId, SwarmNodesTable, SwarmTasksTable } from "@/components/swarm/SwarmReadOnlyViews";

type SwarmSnapshot = {
  summary: SwarmSummary;
  discovery: SwarmDiscoveryView;
  nodes: SwarmNode[];
};

export function SwarmTab({ serverId }: { serverId: string }) {
  const router = useRouter();
  const { showToast } = useToast();
  const [snapshot, setSnapshot] = useState<SwarmSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedStack, setSelectedStack] = useState<string | null>(null);
  const [detail, setDetail] = useState<SwarmStackDetail | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [confirmStack, setConfirmStack] = useState<string | null>(null);
  const [importingStack, setImportingStack] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [summary, discovery, nodes] = await Promise.all([
        swarmApi.summary(serverId),
        swarmApi.stacks(serverId),
        swarmApi.nodes(serverId),
      ]);
      setSnapshot({ summary, discovery, nodes: nodes.nodes });
    } catch (cause) {
      setSnapshot(null);
      setError(getApiErrorMessage(cause, "Unable to inspect Docker Swarm on this server."));
    } finally {
      setLoading(false);
    }
  }, [serverId]);

  useEffect(() => {
    void load();
  }, [load]);

  const showStack = useCallback(async (stackName: string) => {
    if (selectedStack === stackName) {
      setSelectedStack(null);
      setDetail(null);
      return;
    }
    setSelectedStack(stackName);
    setLoadingDetail(true);
    try {
      setDetail(await swarmApi.stack(serverId, stackName));
    } catch (cause) {
      setDetail(null);
      showToast(getApiErrorMessage(cause, "Unable to load stack details."), "error", "Docker Swarm");
    } finally {
      setLoadingDetail(false);
    }
  }, [selectedStack, serverId, showToast]);

  const observe = useCallback(async (stackName: string) => {
    setImportingStack(stackName);
    try {
      const imported = await swarmApi.observe(serverId, stackName);
      showToast(
        imported.created ? "Stack is now observed read-only." : "This stack is already observed by this organization.",
        "success",
        "Docker Swarm",
      );
      router.push(`/projects/${imported.projectId}/overview`);
    } catch (cause) {
      showToast(getApiErrorMessage(cause, "Unable to import this stack."), "error", "Docker Swarm");
    } finally {
      setImportingStack(null);
      setConfirmStack(null);
    }
  }, [router, serverId, showToast]);

  if (loading) {
    return <LoadingCard />;
  }

  if (error || !snapshot) {
    const managerRequired = /manager|required|inactive/i.test(error || "");
    return (
      <section className="rounded-2xl border border-border/50 bg-card p-6">
        <div className="flex items-start gap-3">
          <div className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-warning/10 text-warning">
            <TriangleAlert className="size-4" />
          </div>
          <div>
            <h2 className="font-semibold text-foreground">Docker Swarm unavailable</h2>
            <p className="mt-1 max-w-2xl text-sm leading-relaxed text-muted-foreground">
              {managerRequired
                ? "This endpoint is not an active Swarm manager. Connect an active manager to browse cluster stacks."
                : error || "OpenShip could not inspect this Docker Swarm manager."}
            </p>
            <button type="button" onClick={() => void load()} className="mt-4 inline-flex items-center gap-2 rounded-xl border border-border px-3 py-2 text-sm font-medium text-foreground hover:bg-muted">
              <RefreshCw className="size-3.5" /> Retry inspection
            </button>
          </div>
        </div>
      </section>
    );
  }

  const { summary, discovery, nodes } = snapshot;
  return (
    <div className="space-y-6">
      <section className="rounded-2xl border border-primary/25 bg-primary/[0.04] p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex items-start gap-3">
            <div className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary"><Boxes className="size-4" /></div>
            <div>
              <div className="flex items-center gap-2"><h2 className="font-semibold text-foreground">Docker Swarm</h2><span className="rounded-full bg-warning/10 px-2 py-0.5 text-[11px] font-semibold text-warning">Experimental · observe mode</span></div>
              <p className="mt-1 max-w-2xl text-sm leading-relaxed text-muted-foreground">OpenShip is reading manager state only. Importing a stack creates an OpenShip observation record; it does not change services, tasks, networks, secrets, volumes, or Portainer configuration.</p>
            </div>
          </div>
          <button type="button" onClick={() => void load()} className="inline-flex items-center gap-2 rounded-xl border border-border bg-card px-3 py-2 text-sm font-medium text-foreground hover:bg-muted"><RefreshCw className="size-3.5" /> Refresh</button>
        </div>
      </section>

      <section className="rounded-2xl border border-border/50 bg-card p-5">
        <div className="flex items-center gap-2"><ShieldCheck className="size-4 text-success" /><h2 className="text-sm font-semibold text-foreground">Manager health</h2></div>
        <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <Metric label="Cluster" value={shortId(summary.manager.clusterId)} mono />
          <Metric label="Manager" value={summary.manager.managerAddress || summary.manager.nodeAddress || "Connected"} />
          <Metric label="Nodes" value={String(nodes.length)} />
          <Metric label="Stacks" value={String(discovery.stacks.length)} />
        </div>
        <p className="mt-4 text-xs text-muted-foreground">Engine {summary.manager.engineVersion || "unknown"} · Last observed {formatObservedAt(discovery.observedAt)}</p>
        {discovery.diagnostics.length > 0 && <p className="mt-3 text-sm text-warning">Some metadata could not be read: {discovery.diagnostics.map((item) => item.resource).join(", ")}.</p>}
      </section>

      <section className="rounded-2xl border border-border/50 bg-card">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border/50 px-5 py-4">
          <div><h2 className="font-semibold text-foreground">Discovered stacks</h2><p className="mt-0.5 text-sm text-muted-foreground">Grouped from Docker’s stack namespace labels.</p></div>
          <span className="text-sm text-muted-foreground">{discovery.stacks.length} stacks · {discovery.standaloneServices.length} standalone services</span>
        </div>
        {discovery.stacks.length === 0 ? (
          <p className="px-5 py-10 text-center text-sm text-muted-foreground">No stack namespaces were found on this manager. Standalone Swarm services remain separate below.</p>
        ) : (
          <div className="divide-y divide-border/40">
            {discovery.stacks.map((stack) => {
              const expanded = selectedStack === stack.name;
              return (
                <div key={stack.name} className="px-5 py-4">
                  <div className="flex flex-wrap items-center gap-3">
                    <button type="button" onClick={() => void showStack(stack.name)} className="flex min-w-0 flex-1 items-center gap-3 text-left">
                      <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground"><Boxes className="size-4" /></span>
                      <span className="min-w-0"><span className="block truncate font-medium text-foreground">{stack.name}</span><span className="mt-0.5 block text-xs text-muted-foreground">{stack.services.length} services · {stack.services.reduce((sum, service) => sum + service.taskCount, 0)} current tasks</span></span>
                      {expanded ? <ChevronUp className="size-4 text-muted-foreground" /> : <ChevronDown className="size-4 text-muted-foreground" />}
                    </button>
                    {stack.portainerManaged && <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">Portainer metadata detected</span>}
                    <HealthBadge state={stack.health.state} />
                    <button type="button" onClick={() => setConfirmStack(stack.name)} className="inline-flex items-center gap-1.5 rounded-xl border border-primary/30 bg-primary/5 px-3 py-2 text-sm font-medium text-primary hover:bg-primary/10"><Eye className="size-3.5" /> Observe</button>
                  </div>
                  {expanded && (
                    <div className="mt-4 rounded-xl border border-border/50 bg-muted/[0.18] p-4">
                      {loadingDetail ? <div className="flex justify-center py-6"><Loader2 className="size-4 animate-spin text-muted-foreground" /></div> : detail ? <StackDetail detail={detail} nodes={nodes} /> : <p className="py-4 text-sm text-muted-foreground">Stack details could not be loaded.</p>}
                    </div>
                  )}
                  {confirmStack === stack.name && (
                    <div role="alertdialog" aria-label={`Observe ${stack.name}`} className="mt-4 rounded-xl border border-warning/25 bg-warning/5 p-4">
                      <div className="flex flex-wrap items-center justify-between gap-3">
                        <div><p className="font-medium text-foreground">Observe {stack.name}?</p><p className="mt-1 max-w-xl text-sm text-muted-foreground">This is read-only. OpenShip will save safe discovery metadata and service projections; no workload changes will be sent to Docker or Portainer.</p></div>
                        <div className="flex items-center gap-2"><button type="button" onClick={() => setConfirmStack(null)} className="rounded-xl px-3 py-2 text-sm font-medium text-muted-foreground hover:bg-muted">Cancel</button><button type="button" disabled={importingStack === stack.name} onClick={() => void observe(stack.name)} className="inline-flex items-center gap-2 rounded-xl bg-primary px-3 py-2 text-sm font-medium text-primary-foreground disabled:opacity-60">{importingStack === stack.name && <Loader2 className="size-3.5 animate-spin" />}Import read-only</button></div>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
        {discovery.standaloneServices.length > 0 && (
          <div className="border-t border-border/50 px-5 py-4"><h3 className="text-sm font-semibold text-foreground">Standalone Swarm services</h3><p className="mt-1 text-sm text-muted-foreground">These services have no stack namespace and cannot be inferred into a stack.</p><div className="mt-3 flex flex-wrap gap-2">{discovery.standaloneServices.map((service) => <span key={service.id} className="rounded-lg border border-border bg-muted/40 px-2.5 py-1.5 text-sm text-foreground">{service.name} <span className="text-muted-foreground">· {service.taskCount} tasks</span></span>)}</div></div>
        )}
      </section>
    </div>
  );
}

function Metric({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return <div className="rounded-xl border border-border/50 bg-muted/[0.18] p-3"><p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{label}</p><p className={`mt-1 truncate text-sm font-semibold text-foreground ${mono ? "font-mono" : ""}`}>{value}</p></div>;
}

function LoadingCard() {
  return <section className="flex min-h-64 items-center justify-center rounded-2xl border border-border/50 bg-card"><Loader2 className="size-5 animate-spin text-muted-foreground" /></section>;
}

function StackDetail({ detail, nodes }: { detail: SwarmStackDetail; nodes: SwarmNode[] }) {
  return <div className="space-y-5"><div className="flex flex-wrap items-center justify-between gap-3"><div><p className="text-sm font-semibold text-foreground">{detail.stack.name}</p><p className="mt-0.5 text-xs text-muted-foreground">Observed {formatObservedAt(detail.observedAt)}</p></div><HealthBadge state={detail.health.state} /></div><div><h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">Services</h3><div className="space-y-2">{detail.services.map((service) => <div key={service.id} className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-card px-3 py-2"><div className="min-w-0"><p className="truncate text-sm font-medium text-foreground">{service.sourceServiceName}</p><p className="truncate font-mono text-xs text-muted-foreground">{service.image || "No image reported"}</p></div><span className="text-sm text-muted-foreground">{service.mode}{service.desiredReplicas !== null ? ` · ${service.desiredReplicas} desired` : ""}</span></div>)}</div></div><div><h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">Tasks</h3><SwarmTasksTable tasks={detail.tasks} /></div><div><h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">Nodes</h3><SwarmNodesTable nodes={nodes.filter((node) => detail.tasks.some((task) => task.nodeId === node.id))} /></div></div>;
}
