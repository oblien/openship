"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { ArrowLeft, Boxes, Eye, Loader2, RefreshCw, ShieldCheck, TriangleAlert } from "lucide-react";
import { getApiErrorMessage, swarmApi, type SwarmNode, type SwarmObservation, type SwarmStackDetail } from "@/lib/api";
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

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      const result = await swarmApi.refreshObservation(projectId);
      showToast(
        result.changed ? "Live stack drift was detected." : "Observed stack state is current.",
        result.changed ? "warning" : "success",
        "Docker Swarm",
      );
      await load();
    } catch (cause) {
      showToast(getApiErrorMessage(cause, "Unable to refresh this observed stack."), "error", "Docker Swarm");
    } finally {
      setRefreshing(false);
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
          <div className="flex items-start gap-3"><div className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary"><Eye className="size-4" /></div><div><div className="flex flex-wrap items-center gap-2"><h2 className="font-semibold text-foreground">Observed Docker Swarm stack</h2><span className="rounded-full bg-warning/10 px-2 py-0.5 text-[11px] font-semibold text-warning">Read-only</span></div><p className="mt-1 max-w-3xl text-sm leading-relaxed text-muted-foreground">This stack remains externally controlled. OpenShip reads manager state and records drift; it will not scale, restart, redeploy, remove, route, or edit services, tasks, networks, configs, secrets, or volumes.</p></div></div>
          <button type="button" disabled={refreshing || loading} onClick={() => void refresh()} className="inline-flex items-center gap-2 rounded-xl border border-border bg-card px-3 py-2 text-sm font-medium text-foreground hover:bg-muted disabled:opacity-60">{refreshing ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}Refresh safely</button>
        </div>
      </section>

      {loading && <div className="flex min-h-72 items-center justify-center rounded-2xl border border-border/50 bg-card"><Loader2 className="size-5 animate-spin text-muted-foreground" /></div>}

      {!loading && error && !data && (
        <section className="rounded-2xl border border-danger/20 bg-card p-6"><div className="flex items-start gap-3"><div className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-danger-bg text-danger"><TriangleAlert className="size-4" /></div><div><h2 className="font-semibold text-foreground">Manager state is unavailable</h2><p className="mt-1 text-sm text-muted-foreground">{error}</p><button type="button" onClick={() => void load()} className="mt-4 rounded-xl border border-border px-3 py-2 text-sm font-medium text-foreground hover:bg-muted">Try again</button></div></div></section>
      )}

      {data && (
        <div className="space-y-6">
          {error && <p className="rounded-xl border border-warning/25 bg-warning/5 px-4 py-3 text-sm text-warning">{error}</p>}
          <section className="rounded-2xl border border-border/50 bg-card p-5"><div className="flex flex-wrap items-center justify-between gap-4"><div><div className="flex items-center gap-2"><Boxes className="size-4 text-muted-foreground" /><h2 className="font-semibold text-foreground">{data.observation.stackName}</h2><HealthBadge state={data.observation.managementMode === "observe" ? "observed" : data.observation.managementMode} /></div><p className="mt-1 text-sm text-muted-foreground">Cluster {shortId(data.observation.clusterId)} · Last observed {formatObservedAt(data.observation.drift.lastObservedAt)}</p></div><HealthBadge state={data.observation.drift.status} /></div><div className="mt-5 grid grid-cols-1 gap-4 sm:grid-cols-3"><StatusCard label="Source" value={data.observation.source.status} description={sourceDescription(data.observation.source.status)} /><StatusCard label="Live drift" value={data.observation.drift.status} description={driftDescription(data.observation.drift.status)} /><StatusCard label="Workload controls" value="Unavailable" description="Observe mode has no workload mutation actions." /></div></section>

          {data.detail && <section className="rounded-2xl border border-border/50 bg-card"><div className="flex flex-wrap items-center justify-between gap-3 border-b border-border/50 px-5 py-4"><div><h2 className="font-semibold text-foreground">Live stack state</h2><p className="mt-0.5 text-sm text-muted-foreground">Manager read at {formatObservedAt(data.detail.observedAt)}.</p></div><HealthBadge state={data.detail.health.state} /></div><div className="flex border-b border-border/50 px-3">{(["services", "tasks", "nodes"] as View[]).map((candidate) => <button key={candidate} type="button" onClick={() => setView(candidate)} className={`relative px-4 py-3 text-sm font-medium capitalize transition-colors ${view === candidate ? "text-foreground" : "text-muted-foreground hover:text-foreground"}`}>{candidate}{view === candidate && <span className="absolute inset-x-4 bottom-0 h-0.5 rounded-full bg-primary" />}</button>)}</div><div className="p-5">{view === "services" && <Services detail={data.detail} />}{view === "tasks" && <SwarmTasksTable tasks={data.detail.tasks} />}{view === "nodes" && <SwarmNodesTable nodes={data.nodes} />}</div></section>}

          <section className="rounded-2xl border border-border/50 bg-card p-5"><div className="flex items-start gap-3"><div className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-muted text-muted-foreground"><ShieldCheck className="size-4" /></div><div><h2 className="font-semibold text-foreground">Why actions are disabled</h2><p className="mt-1 max-w-3xl text-sm leading-relaxed text-muted-foreground">The stack may be managed through Portainer, Docker CLI, GitOps, or another controller. Leaving those actions unavailable prevents OpenShip from becoming a competing writer while you evaluate the integration.</p></div></div></section>
        </div>
      )}
    </PageContainer>
  );
}

function StatusCard({ label, value, description }: { label: string; value: string; description: string }) {
  return <div className="rounded-xl border border-border/50 bg-muted/[0.18] p-4"><p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{label}</p><div className="mt-2"><HealthBadge state={value} /></div><p className="mt-3 text-sm leading-relaxed text-muted-foreground">{description}</p></div>;
}

function Services({ detail }: { detail: SwarmStackDetail }) {
  if (detail.services.length === 0) return <p className="py-6 text-center text-sm text-muted-foreground">No services were returned for this stack.</p>;
  return <div className="space-y-2">{detail.services.map((service) => <div key={service.id} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border/50 px-4 py-3"><div className="min-w-0"><p className="font-medium text-foreground">{service.sourceServiceName}</p><p className="mt-0.5 truncate font-mono text-xs text-muted-foreground">{service.image || "No image reported"}</p></div><div className="flex items-center gap-3 text-sm text-muted-foreground"><span className="capitalize">{service.mode}</span><span>{service.desiredReplicas === null ? "No replica target" : `${service.desiredReplicas} desired`}</span></div></div>)}</div>;
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
