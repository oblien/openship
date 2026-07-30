"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, Boxes, Download, Eye, FileText, Loader2, RefreshCw, Rocket, ScrollText, ShieldCheck, TriangleAlert, X } from "lucide-react";
import { deployApi, getApiErrorMessage, projectsApi, registriesApi, swarmApi, type ContainerRegistry, type SwarmLogEntry, type SwarmNode, type SwarmObservation, type SwarmSourcePreview, type SwarmStackDetail, type SwarmStackHandoff, type SwarmStackSource, type SwarmTask } from "@/lib/api";
import { useToast } from "@/context/ToastContext";
import { PageContainer } from "@/components/ui/PageContainer";
import { HealthBadge, formatObservedAt, shortId, SwarmNodesTable, SwarmTasksTable } from "@/components/swarm/SwarmReadOnlyViews";

type StackData = {
  observation: SwarmObservation;
  source: SwarmStackSource;
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
  const router = useRouter();
  const [data, setData] = useState<StackData | null>(null);
  const [view, setView] = useState<View>("services");
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [scalingService, setScalingService] = useState<string | null>(null);
  const [restartingService, setRestartingService] = useState<string | null>(null);
  const [removing, setRemoving] = useState(false);
  const [sourceEditor, setSourceEditor] = useState<"inline" | "repository" | null>(null);
  const [inlineYaml, setInlineYaml] = useState("");
  const [repositoryPaths, setRepositoryPaths] = useState("");
  const [repositoryOwner, setRepositoryOwner] = useState("");
  const [repositoryName, setRepositoryName] = useState("");
  const [repositoryPath, setRepositoryPath] = useState("");
  const [repositoryBranch, setRepositoryBranch] = useState("");
  const [repositoryCommit, setRepositoryCommit] = useState("");
  const [savingSource, setSavingSource] = useState(false);
  const [renderingSource, setRenderingSource] = useState(false);
  const [preview, setPreview] = useState<SwarmSourcePreview | null>(null);
  const [claiming, setClaiming] = useState(false);
  const [releasing, setReleasing] = useState(false);
  const [inspectedService, setInspectedService] = useState<SwarmStackDetail["services"][number] | null>(null);
  const [logs, setLogs] = useState<{ serviceName: string; taskId?: string; loggingDriver: string | null; entries: SwarmLogEntry[]; following: boolean } | null>(null);
  const [loadingLogs, setLoadingLogs] = useState(false);
  const logEventSource = useRef<EventSource | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [observation, source] = await Promise.all([
        swarmApi.observation(projectId),
        swarmApi.source(projectId),
      ]);
      if (!observation.managerServerId) {
        setData({ observation, source, detail: null, nodes: [] });
        setError("This observed stack no longer has a Swarm manager target.");
        return;
      }
      const [detail, nodes] = await Promise.all([
        swarmApi.stack(observation.managerServerId, observation.stackName),
        swarmApi.nodes(observation.managerServerId),
      ]);
      setData({ observation, source, detail, nodes: nodes.nodes });
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

  const beginSourceEdit = useCallback((kind: "inline" | "repository") => {
    if (kind === "repository" && data?.source.kind === "repository") {
      setRepositoryPaths(data.source.composePaths.join(", "));
      setRepositoryPath(data.source.sourcePath ?? "");
      setRepositoryBranch(data.source.branch ?? "");
      setRepositoryCommit(data.source.commitSha ?? "");
    }
    setSourceEditor(kind);
    setPreview(null);
  }, [data?.source]);

  const saveSource = useCallback(async () => {
    if (!data) return;
    setSavingSource(true);
    try {
      let branch = repositoryBranch.trim() || undefined;
      if (sourceEditor === "repository" && (repositoryOwner.trim() || repositoryName.trim())) {
        if (!repositoryOwner.trim() || !repositoryName.trim()) {
          throw new Error("Enter both a GitHub owner and repository, or leave both blank to use the project repository already linked to OpenShip.");
        }
        const linked = await projectsApi.linkRepo(projectId, {
          owner: repositoryOwner.trim(),
          repo: repositoryName.trim(),
          branch,
        });
        if (!linked.success) throw new Error(linked.error || "Unable to link the selected GitHub repository.");
        branch = branch ?? linked.branch;
      }
      const source = sourceEditor === "inline"
        ? await swarmApi.replaceSource(projectId, { kind: "inline", yaml: inlineYaml, expectedVersion: data.source.version })
        : await swarmApi.replaceSource(projectId, {
          kind: "repository",
          composePaths: repositoryPaths.split(",").map((path) => path.trim()).filter(Boolean),
          sourcePath: repositoryPath.trim() || undefined,
          branch,
          commitSha: repositoryCommit.trim() || undefined,
          expectedVersion: data.source.version,
        });
      setData((current) => current ? {
        ...current,
        source,
        observation: { ...current.observation, source: { kind: source.kind, status: source.status, deployable: source.deployable } },
      } : current);
      setSourceEditor(null);
      setPreview(null);
      showToast("Authoritative stack source saved. Render it against the manager before claiming management.", "success", "Docker Swarm");
    } catch (cause) {
      showToast(getApiErrorMessage(cause, "Unable to save the stack source."), "error", "Docker Swarm");
    } finally {
      setSavingSource(false);
    }
  }, [data, inlineYaml, projectId, repositoryBranch, repositoryCommit, repositoryName, repositoryOwner, repositoryPath, repositoryPaths, showToast, sourceEditor]);

  const renderSource = useCallback(async () => {
    setRenderingSource(true);
    try {
      const result = await swarmApi.renderSource(projectId);
      setPreview(result);
      await load();
      showToast(result.changes.length ? "Source comparison is ready for review." : "Source matches the current stack state.", "success", "Docker Swarm");
    } catch (cause) {
      setPreview(null);
      showToast(getApiErrorMessage(cause, "Unable to render this stack source on the manager."), "error", "Docker Swarm");
    } finally {
      setRenderingSource(false);
    }
  }, [load, projectId, showToast]);

  const claimAndApply = useCallback(async () => {
    const stackName = data?.observation.stackName;
    if (!stackName || !preview) return;
    const riskKinds = new Set(["service-remove", "network-port-change", "config-secret-reference-change"]);
    const risky = preview.changes.filter((change) => riskKinds.has(change.kind));
    if (risky.length > 0 && !window.confirm(`This first apply includes ${risky.length} storage, config/secret, network/port, or service-removal change(s). Review the rendered source below. Continue to typed confirmation?`)) return;
    const confirmed = window.prompt(`OpenShip will apply the reviewed source to ${stackName} without pruning unlisted services on this first claim. Existing tasks are not stopped first.\n\nType the exact stack name to claim management.`);
    if (confirmed === null) return;
    setClaiming(true);
    try {
      await swarmApi.claimManagement(projectId, { confirmedStackName: confirmed, previewLiveDigest: preview.liveStateDigest });
      const started = await deployApi.trigger({ projectId, forceAll: true });
      const deploymentId = started?.data?.deployment?.id as string | undefined;
      showToast("Management claim accepted. Swarm is applying the reviewed stack and will verify labels before enabling routine controls.", "success", "Docker Swarm");
      if (deploymentId) router.push(`/build/${deploymentId}`);
      else await load();
    } catch (cause) {
      showToast(getApiErrorMessage(cause, "Unable to claim management for this stack."), "error", "Docker Swarm");
    } finally {
      setClaiming(false);
    }
  }, [data?.observation.stackName, load, preview, projectId, router, showToast]);

  const downloadHandoff = useCallback((handoff: SwarmStackHandoff) => {
    const blob = new Blob([JSON.stringify(handoff, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${handoff.stackName}-openship-handoff.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  }, []);

  const releaseManagement = useCallback(async () => {
    const stackName = data?.observation.stackName;
    if (!stackName) return;
    setReleasing(true);
    try {
      // Export first: release is deliberately reversible, but a handoff must
      // remain available even if the operator immediately changes controllers.
      const handoff = await swarmApi.handoff(projectId);
      downloadHandoff(handoff);
      const confirmed = window.prompt(`The handoff file was downloaded. Releasing ${stackName} stops future OpenShip writes but leaves all workloads and labels in place.\n\nType the exact stack name to release management.`);
      if (confirmed === null) return;
      await swarmApi.releaseManagement(projectId, confirmed);
      setPreview(null);
      showToast("Management released. OpenShip is now observing this stack only; workloads were not changed.", "success", "Docker Swarm");
      await load();
    } catch (cause) {
      showToast(getApiErrorMessage(cause, "Unable to release management for this stack."), "error", "Docker Swarm");
    } finally {
      setReleasing(false);
    }
  }, [data?.observation.stackName, downloadHandoff, load, projectId, showToast]);

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
          <div className="flex flex-wrap items-center justify-end gap-2"><button type="button" disabled={refreshing || loading || removing || releasing} onClick={() => void refresh()} className="inline-flex items-center gap-2 rounded-xl border border-border bg-card px-3 py-2 text-sm font-medium text-foreground hover:bg-muted disabled:opacity-60">{refreshing ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}{data?.observation.managementMode === "managed" ? "Refresh manager state" : "Refresh safely"}</button>{data?.observation.managementMode === "managed" && <button type="button" disabled={releasing || removing || loading} onClick={() => void releaseManagement()} className="inline-flex items-center gap-2 rounded-xl border border-border bg-card px-3 py-2 text-sm font-medium text-foreground hover:bg-muted disabled:opacity-60">{releasing ? <Loader2 className="size-3.5 animate-spin" /> : <Download className="size-3.5" />}Export & release</button>}{data?.observation.managementMode === "managed" && <button type="button" disabled={removing || loading || releasing} onClick={() => void removeStack()} className="inline-flex items-center gap-2 rounded-xl border border-danger/30 bg-danger-bg px-3 py-2 text-sm font-medium text-danger hover:bg-danger/10 disabled:opacity-60">{removing ? <Loader2 className="size-3.5 animate-spin" /> : <TriangleAlert className="size-3.5" />}Remove stack</button>}</div>
        </div>
      </section>

      {loading && <div className="flex min-h-72 items-center justify-center rounded-2xl border border-border/50 bg-card"><Loader2 className="size-5 animate-spin text-muted-foreground" /></div>}

      {!loading && error && !data && (
        <section className="rounded-2xl border border-danger/20 bg-card p-6"><div className="flex items-start gap-3"><div className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-danger-bg text-danger"><TriangleAlert className="size-4" /></div><div><h2 className="font-semibold text-foreground">Manager state is unavailable</h2><p className="mt-1 text-sm text-muted-foreground">{error}</p><button type="button" onClick={() => void load()} className="mt-4 rounded-xl border border-border px-3 py-2 text-sm font-medium text-foreground hover:bg-muted">Try again</button></div></div></section>
      )}

      {data && (
        <div className="space-y-6">
          {error && <p className="rounded-xl border border-warning/25 bg-warning/5 px-4 py-3 text-sm text-warning">{error}</p>}
          <section className="rounded-2xl border border-border/50 bg-card p-5"><div className="flex flex-wrap items-center justify-between gap-4"><div><div className="flex items-center gap-2"><Boxes className="size-4 text-muted-foreground" /><h2 className="font-semibold text-foreground">{data.observation.stackName}</h2><HealthBadge state={data.observation.managementMode === "observe" ? "observed" : data.observation.managementMode} /></div><p className="mt-1 text-sm text-muted-foreground">Cluster {shortId(data.observation.clusterId)} · {data.observation.revisionId ? `Applied revision ${shortId(data.observation.revisionId)} · ` : "No applied OpenShip revision · "}Last observed {formatObservedAt(data.observation.drift.lastObservedAt)}</p></div><HealthBadge state={data.observation.drift.status} /></div><div className="mt-5 grid grid-cols-1 gap-4 sm:grid-cols-4"><StatusCard label="Source" value={data.observation.source.status} description={sourceDescription(data.observation.source.status)} /><StatusCard label="Live drift" value={data.observation.drift.status} description={driftDescription(data.observation.drift.status)} /><StatusCard label="Routing" value={data.source.routingMode === "external" ? "External" : "OpenShip Edge"} description={data.source.routingMode === "external" ? "Domains, TLS, ports 80/443, and router labels remain externally managed." : "OpenShip Edge is configured for this stack."} /><StatusCard label="Workload controls" value={data.observation.managementMode === "managed" ? "Managed" : "Unavailable"} description={data.observation.managementMode === "managed" ? "Scale is available for owned replicated services. It remains operational drift until a reviewed source deploy." : "Observe mode has no workload mutation actions."} /></div></section>

          <SourceManagementPanel
            source={data.source}
            stackName={data.observation.stackName}
            managementMode={data.observation.managementMode}
            editor={sourceEditor}
            inlineYaml={inlineYaml}
            repositoryPaths={repositoryPaths}
            repositoryOwner={repositoryOwner}
            repositoryName={repositoryName}
            repositoryPath={repositoryPath}
            repositoryBranch={repositoryBranch}
            repositoryCommit={repositoryCommit}
            saving={savingSource}
            rendering={renderingSource}
            claiming={claiming}
            preview={preview}
            onEdit={beginSourceEdit}
            onCancelEdit={() => setSourceEditor(null)}
            onInlineYamlChange={setInlineYaml}
            onRepositoryPathsChange={setRepositoryPaths}
            onRepositoryOwnerChange={setRepositoryOwner}
            onRepositoryNameChange={setRepositoryName}
            onRepositoryPathChange={setRepositoryPath}
            onRepositoryBranchChange={setRepositoryBranch}
            onRepositoryCommitChange={setRepositoryCommit}
            onSave={() => void saveSource()}
            onRender={() => void renderSource()}
            onClaim={() => void claimAndApply()}
          />

          <RegistryPanel
            projectId={projectId}
            source={data.source}
            onSourceChange={(source) => setData((current) => current ? {
              ...current,
              source,
              observation: {
                ...current.observation,
                source: { kind: source.kind, status: source.status, deployable: source.deployable },
              },
            } : current)}
          />

          {data.detail && <section className="rounded-2xl border border-border/50 bg-card"><div className="flex flex-wrap items-center justify-between gap-3 border-b border-border/50 px-5 py-4"><div><h2 className="font-semibold text-foreground">Live stack state</h2><p className="mt-0.5 text-sm text-muted-foreground">Manager read at {formatObservedAt(data.detail.observedAt)}.</p></div><HealthBadge state={data.detail.health.state} /></div><div className="flex border-b border-border/50 px-3">{(["services", "tasks", "nodes"] as View[]).map((candidate) => <button key={candidate} type="button" onClick={() => setView(candidate)} className={`relative px-4 py-3 text-sm font-medium capitalize transition-colors ${view === candidate ? "text-foreground" : "text-muted-foreground hover:text-foreground"}`}>{candidate}{view === candidate && <span className="absolute inset-x-4 bottom-0 h-0.5 rounded-full bg-primary" />}</button>)}</div><div className="p-5">{view === "services" && <Services detail={data.detail} managed={data.observation.managementMode === "managed"} scalingService={scalingService} restartingService={restartingService} onScale={scale} onRestart={restart} onLogs={(service) => void openLogs(service.sourceServiceName)} onInspect={setInspectedService} loadingLogs={loadingLogs} />}{view === "tasks" && <SwarmTasksTable tasks={data.detail.tasks} onLogs={openTaskLogs} />}{view === "nodes" && <SwarmNodesTable nodes={data.nodes} />}</div></section>}

          {inspectedService && <ServiceInspectPanel service={inspectedService} onClose={() => setInspectedService(null)} />}

          {logs && <ServiceLogsPanel logs={logs} loading={loadingLogs} onFollow={followLogs} onStop={stopFollowingLogs} onClose={() => { stopFollowingLogs(); setLogs(null); }} />}

          {data.observation.managementMode === "observe" && <section className="rounded-2xl border border-border/50 bg-card p-5"><div className="flex items-start gap-3"><div className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-muted text-muted-foreground"><ShieldCheck className="size-4" /></div><div><h2 className="font-semibold text-foreground">Why actions are disabled</h2><p className="mt-1 max-w-3xl text-sm leading-relaxed text-muted-foreground">The stack may be managed through Portainer, Docker CLI, GitOps, or another controller. Leaving those actions unavailable prevents OpenShip from becoming a competing writer while you evaluate the integration.</p></div></div></section>}
        </div>
      )}
    </PageContainer>
  );
}

type RegistryDraft = {
  name: string;
  registryUrl: string;
  repositoryPrefix: string;
  username: string;
  credentials: string;
  insecure: boolean;
};

const EMPTY_REGISTRY_DRAFT: RegistryDraft = {
  name: "", registryUrl: "", repositoryPrefix: "", username: "", credentials: "", insecure: false,
};

/** Organization registries are edited here only as an input to the current stack. */
function RegistryPanel({ projectId, source, onSourceChange }: {
  projectId: string;
  source: SwarmStackSource;
  onSourceChange: (source: SwarmStackSource) => void;
}) {
  const { showToast } = useToast();
  const [registries, setRegistries] = useState<ContainerRegistry[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | "new" | null>(null);
  const [draft, setDraft] = useState<RegistryDraft>(EMPTY_REGISTRY_DRAFT);

  const loadRegistries = useCallback(async () => {
    setLoading(true);
    try {
      setRegistries(await registriesApi.list());
    } catch (cause) {
      showToast(getApiErrorMessage(cause, "Unable to load container registries."), "error", "Container registry");
    } finally {
      setLoading(false);
    }
  }, [showToast]);

  useEffect(() => { void loadRegistries(); }, [loadRegistries]);

  const selectRegistry = useCallback(async (registryId: string | null) => {
    setSaving(true);
    try {
      onSourceChange(await swarmApi.setRegistry(projectId, registryId));
      showToast(registryId ? "Registry attached to this stack." : "Registry detached from this stack.", "success", "Container registry");
    } catch (cause) {
      showToast(getApiErrorMessage(cause, "Unable to update this stack registry."), "error", "Container registry");
    } finally {
      setSaving(false);
    }
  }, [onSourceChange, projectId, showToast]);

  const beginEdit = (registry?: ContainerRegistry) => {
    if (!registry) {
      setDraft(EMPTY_REGISTRY_DRAFT);
      setEditing("new");
      return;
    }
    setDraft({
      name: registry.name,
      registryUrl: registry.registryUrl,
      repositoryPrefix: registry.repositoryPrefix ?? "",
      username: registry.username ?? "",
      credentials: "",
      insecure: registry.insecure,
    });
    setEditing(registry.id);
  };

  const saveRegistry = async () => {
    if (!draft.name.trim() || !draft.registryUrl.trim()) {
      showToast("Registry name and address are required.", "error", "Container registry");
      return;
    }
    setSaving(true);
    try {
      const input = {
        name: draft.name.trim(),
        registryUrl: draft.registryUrl.trim(),
        repositoryPrefix: draft.repositoryPrefix.trim() || null,
        username: draft.username.trim() || null,
        ...(draft.credentials ? { credentials: draft.credentials } : {}),
        insecure: draft.insecure,
      };
      const registry = editing === "new"
        ? await registriesApi.create({ ...input, ...(draft.credentials ? { credentials: draft.credentials } : {}) })
        : await registriesApi.update(editing!, input);
      await loadRegistries();
      setEditing(null);
      setDraft(EMPTY_REGISTRY_DRAFT);
      if (editing === "new") onSourceChange(await swarmApi.setRegistry(projectId, registry.id));
      showToast(editing === "new" ? "Registry created and attached to this stack." : "Registry updated.", "success", "Container registry");
    } catch (cause) {
      showToast(getApiErrorMessage(cause, "Unable to save this registry."), "error", "Container registry");
    } finally {
      setSaving(false);
    }
  };

  const testRegistry = async (registryId: string) => {
    setTesting(registryId);
    try {
      await registriesApi.test(registryId);
      await loadRegistries();
      showToast("Registry connection succeeded.", "success", "Container registry");
    } catch (cause) {
      showToast(getApiErrorMessage(cause, "Registry connection failed."), "error", "Container registry");
    } finally {
      setTesting(null);
    }
  };

  const removeRegistry = async (registry: ContainerRegistry) => {
    if (!window.confirm(`Delete registry ${registry.name}? Existing digest-pinned deployments remain runnable, but future builds cannot use it.`)) return;
    setSaving(true);
    try {
      await registriesApi.remove(registry.id);
      if (source.registryId === registry.id) onSourceChange(await swarmApi.setRegistry(projectId, null));
      await loadRegistries();
      showToast("Registry deleted.", "success", "Container registry");
    } catch (cause) {
      showToast(getApiErrorMessage(cause, "Unable to delete this registry."), "error", "Container registry");
    } finally {
      setSaving(false);
    }
  };

  const attached = registries.find((registry) => registry.id === source.registryId) ?? null;
  return <section className="rounded-2xl border border-border/50 bg-card p-5">
    <div className="flex flex-wrap items-start justify-between gap-4"><div><h2 className="font-semibold text-foreground">Container registry</h2><p className="mt-1 max-w-3xl text-sm leading-relaxed text-muted-foreground">Required only for source-built services. OpenShip publishes a deterministic tag, records the registry digest, and workers receive credentials only for the stack apply.</p></div><button type="button" disabled={saving} onClick={() => beginEdit()} className="rounded-xl border border-border px-3 py-2 text-sm font-medium text-foreground hover:bg-muted disabled:opacity-60">Add registry</button></div>
    <div className="mt-4 grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto]"><label className="text-sm text-muted-foreground">Registry used by this stack<select value={source.registryId ?? ""} disabled={loading || saving} onChange={(event) => void selectRegistry(event.target.value || null)} className="mt-1.5 w-full rounded-xl border border-border bg-card px-3 py-2 text-sm text-foreground outline-none focus:border-primary"><option value="">No registry selected</option>{registries.map((registry) => <option key={registry.id} value={registry.id}>{registry.name} · {registry.registryUrl}</option>)}</select></label><div className="self-end pb-0.5 text-sm text-muted-foreground">{attached ? `${attached.hasCredentials ? "Authenticated" : "Public"} · ${attached.repositoryPrefix || "no namespace"}` : "Prebuilt-image stacks do not need one."}</div></div>
    {loading ? <div className="mt-4 flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-3.5 animate-spin" />Loading registries…</div> : registries.length === 0 ? <p className="mt-4 rounded-xl border border-border/50 bg-muted/[0.18] px-3 py-2 text-sm text-muted-foreground">No registry is configured yet. Add one before deploying a service with <code>build:</code>.</p> : <div className="mt-4 space-y-2">{registries.map((registry) => <div key={registry.id} className={`flex flex-wrap items-center justify-between gap-3 rounded-xl border px-3 py-3 ${registry.id === source.registryId ? "border-primary/35 bg-primary/[0.035]" : "border-border/50"}`}><div className="min-w-0"><p className="font-medium text-foreground">{registry.name}{registry.id === source.registryId && <span className="ml-2 text-xs font-normal text-primary">Attached</span>}</p><p className="mt-0.5 truncate font-mono text-xs text-muted-foreground">{registry.registryUrl}{registry.repositoryPrefix ? `/${registry.repositoryPrefix}` : ""}</p><p className="mt-1 text-xs text-muted-foreground">{registry.hasCredentials ? `Username ${registry.username || "configured"} · credential stored securely` : "Public registry · no credential stored"}{registry.lastVerifyError ? ` · Last test failed: ${registry.lastVerifyError}` : registry.lastVerifiedAt ? " · Connection verified" : ""}</p></div><div className="flex items-center gap-2"><button type="button" disabled={saving || testing !== null} onClick={() => void testRegistry(registry.id)} className="rounded-lg border border-border px-2.5 py-1 text-xs font-medium text-foreground hover:bg-muted disabled:opacity-60">{testing === registry.id ? "Testing…" : "Test"}</button><button type="button" disabled={saving} onClick={() => beginEdit(registry)} className="rounded-lg border border-border px-2.5 py-1 text-xs font-medium text-foreground hover:bg-muted disabled:opacity-60">Edit</button><button type="button" disabled={saving} onClick={() => void removeRegistry(registry)} className="rounded-lg border border-danger/30 px-2.5 py-1 text-xs font-medium text-danger hover:bg-danger-bg disabled:opacity-60">Delete</button></div></div>)}</div>}
    {editing && <div className="mt-5 rounded-xl border border-border/50 bg-muted/[0.16] p-4"><div className="flex items-center justify-between gap-3"><div><h3 className="font-medium text-foreground">{editing === "new" ? "Add registry" : "Edit registry"}</h3><p className="mt-1 text-sm text-muted-foreground">Credentials are write-only. Leave the credential field empty when editing to keep the saved value.</p></div><button type="button" onClick={() => { setEditing(null); setDraft(EMPTY_REGISTRY_DRAFT); }} className="text-sm text-muted-foreground hover:text-foreground">Cancel</button></div><div className="mt-4 grid gap-3 sm:grid-cols-2"><RegistryInput label="Name" value={draft.name} onChange={(name) => setDraft((current) => ({ ...current, name }))} placeholder="Production registry" /><RegistryInput label="Registry address" value={draft.registryUrl} onChange={(registryUrl) => setDraft((current) => ({ ...current, registryUrl }))} placeholder="registry.example.com:5000" /><RegistryInput label="Namespace (optional)" value={draft.repositoryPrefix} onChange={(repositoryPrefix) => setDraft((current) => ({ ...current, repositoryPrefix }))} placeholder="team" /><RegistryInput label="Username (optional)" value={draft.username} onChange={(username) => setDraft((current) => ({ ...current, username }))} placeholder="robot" /><label className="text-sm text-muted-foreground sm:col-span-2">Credential {editing !== "new" && <span className="text-xs">(leave blank to keep existing)</span>}<input type="password" value={draft.credentials} onChange={(event) => setDraft((current) => ({ ...current, credentials: event.target.value }))} autoComplete="new-password" className="mt-1.5 w-full rounded-xl border border-border bg-card px-3 py-2 text-sm text-foreground outline-none focus:border-primary" /></label><label className="flex items-center gap-2 text-sm text-muted-foreground sm:col-span-2"><input type="checkbox" checked={draft.insecure} onChange={(event) => setDraft((current) => ({ ...current, insecure: event.target.checked }))} />Use HTTP for a private, trusted registry</label></div><div className="mt-4 flex justify-end"><button type="button" disabled={saving} onClick={() => void saveRegistry()} className="inline-flex items-center gap-2 rounded-xl bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-60">{saving && <Loader2 className="size-3.5 animate-spin" />}Save registry</button></div></div>}
  </section>;
}

function RegistryInput({ label, value, onChange, placeholder }: { label: string; value: string; onChange: (value: string) => void; placeholder?: string }) {
  return <label className="text-sm text-muted-foreground">{label}<input value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} className="mt-1.5 w-full rounded-xl border border-border bg-card px-3 py-2 text-sm text-foreground outline-none focus:border-primary" /></label>;
}

function SourceManagementPanel({
  source,
  stackName,
  managementMode,
  editor,
  inlineYaml,
  repositoryPaths,
  repositoryOwner,
  repositoryName,
  repositoryPath,
  repositoryBranch,
  repositoryCommit,
  saving,
  rendering,
  claiming,
  preview,
  onEdit,
  onCancelEdit,
  onInlineYamlChange,
  onRepositoryPathsChange,
  onRepositoryOwnerChange,
  onRepositoryNameChange,
  onRepositoryPathChange,
  onRepositoryBranchChange,
  onRepositoryCommitChange,
  onSave,
  onRender,
  onClaim,
}: {
  source: SwarmStackSource;
  stackName: string;
  managementMode: "observe" | "managed";
  editor: "inline" | "repository" | null;
  inlineYaml: string;
  repositoryPaths: string;
  repositoryOwner: string;
  repositoryName: string;
  repositoryPath: string;
  repositoryBranch: string;
  repositoryCommit: string;
  saving: boolean;
  rendering: boolean;
  claiming: boolean;
  preview: SwarmSourcePreview | null;
  onEdit: (kind: "inline" | "repository") => void;
  onCancelEdit: () => void;
  onInlineYamlChange: (value: string) => void;
  onRepositoryPathsChange: (value: string) => void;
  onRepositoryOwnerChange: (value: string) => void;
  onRepositoryNameChange: (value: string) => void;
  onRepositoryPathChange: (value: string) => void;
  onRepositoryBranchChange: (value: string) => void;
  onRepositoryCommitChange: (value: string) => void;
  onSave: () => void;
  onRender: () => void;
  onClaim: () => void;
}) {
  const hasRisk = preview?.changes.some((change) => ["service-remove", "network-port-change", "config-secret-reference-change"].includes(change.kind)) ?? false;
  return <section className="rounded-2xl border border-border/50 bg-card p-5">
    <div className="flex flex-wrap items-start justify-between gap-4">
      <div className="flex items-start gap-3"><div className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-muted text-muted-foreground"><FileText className="size-4" /></div><div><h2 className="font-semibold text-foreground">Authoritative stack source</h2><p className="mt-1 max-w-3xl text-sm leading-relaxed text-muted-foreground">Docker can show the running service specs but cannot recover the original stack file losslessly. Link the repository metadata or paste the controller-owned YAML, then render it on the manager before any claim.</p></div></div>
      {managementMode === "observe" && !editor && <div className="flex flex-wrap gap-2"><button type="button" onClick={() => onEdit("inline")} className="rounded-xl border border-border px-3 py-2 text-sm font-medium text-foreground hover:bg-muted">Paste YAML</button><button type="button" onClick={() => onEdit("repository")} className="rounded-xl border border-border px-3 py-2 text-sm font-medium text-foreground hover:bg-muted">Link repository</button></div>}
    </div>

    <div className="mt-4 grid gap-3 sm:grid-cols-3"><StatusCard label="Linked source" value={source.kind} description={source.kind === "adopted" ? "No authoritative source is linked yet." : source.kind === "inline" ? (source.hasInlineYaml ? "An encrypted inline document is stored for this stack." : "Paste the complete YAML document to make it deployable.") : "Compose files are read from the project's configured repository only when you render or apply."} /><StatusCard label="Validation" value={source.status} description={sourceDescription(source.status)} /><StatusCard label="Source version" value={`v${source.version}`} description={source.digest ? `Digest ${shortId(source.digest)}` : "No source digest has been recorded."} /></div>

    {managementMode === "observe" && !editor && <div className="mt-4 flex flex-wrap gap-2"><button type="button" disabled={rendering || saving || source.kind === "adopted" || (source.kind === "inline" && !source.hasInlineYaml)} onClick={onRender} className="inline-flex items-center gap-2 rounded-xl bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-60">{rendering ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}Render & compare</button>{source.kind === "inline" && !source.hasInlineYaml && <p className="self-center text-sm text-muted-foreground">Paste the complete YAML document before rendering.</p>}{source.kind === "repository" && <p className="self-center text-sm text-muted-foreground">Rendering reads only the linked compose files and referenced config, secret, or environment files from this project’s configured repository.</p>}</div>}

    {editor === "inline" && <div className="mt-5 rounded-xl border border-border/50 bg-muted/[0.16] p-4"><div className="flex flex-wrap items-center justify-between gap-3"><div><h3 className="font-medium text-foreground">Paste authoritative YAML</h3><p className="mt-1 text-sm text-muted-foreground">{source.hasInlineYaml ? "Replace the existing encrypted document with a complete new document. The current source is never displayed in this editor." : "Store a complete stack document encrypted at rest."}</p></div><button type="button" onClick={onCancelEdit} className="text-sm text-muted-foreground hover:text-foreground">Cancel</button></div><textarea value={inlineYaml} onChange={(event) => onInlineYamlChange(event.target.value)} spellCheck={false} placeholder={'services:\n  web:\n    image: nginx:alpine'} className="mt-4 min-h-64 w-full rounded-xl border border-border bg-card p-3 font-mono text-xs text-foreground outline-none focus:border-primary" /><div className="mt-3 flex justify-end"><button type="button" disabled={saving || !inlineYaml.trim()} onClick={onSave} className="inline-flex items-center gap-2 rounded-xl bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-60">{saving && <Loader2 className="size-3.5 animate-spin" />}Save source</button></div></div>}

    {editor === "repository" && <div className="mt-5 rounded-xl border border-border/50 bg-muted/[0.16] p-4"><div className="flex flex-wrap items-center justify-between gap-3"><div><h3 className="font-medium text-foreground">Link repository stack files</h3><p className="mt-1 text-sm text-muted-foreground">Select a GitHub repository below, or leave owner and repository blank to use one already linked to this project. Linking source does not change the Swarm manager or enable automatic Swarm deploys.</p></div><button type="button" onClick={onCancelEdit} className="text-sm text-muted-foreground hover:text-foreground">Cancel</button></div><div className="mt-4 grid gap-3 sm:grid-cols-2"><label className="text-sm text-muted-foreground">GitHub owner (optional)<input value={repositoryOwner} onChange={(event) => onRepositoryOwnerChange(event.target.value)} placeholder="acme" className="mt-1.5 w-full rounded-xl border border-border bg-card px-3 py-2 text-sm text-foreground outline-none focus:border-primary" /></label><label className="text-sm text-muted-foreground">GitHub repository (optional)<input value={repositoryName} onChange={(event) => onRepositoryNameChange(event.target.value)} placeholder="production-stack" className="mt-1.5 w-full rounded-xl border border-border bg-card px-3 py-2 text-sm text-foreground outline-none focus:border-primary" /></label><label className="text-sm text-muted-foreground sm:col-span-2">Compose paths, in merge order<input value={repositoryPaths} onChange={(event) => onRepositoryPathsChange(event.target.value)} placeholder="compose.yaml, compose.production.yaml" className="mt-1.5 w-full rounded-xl border border-border bg-card px-3 py-2 text-sm text-foreground outline-none focus:border-primary" /></label><label className="text-sm text-muted-foreground">Source subdirectory (optional)<input value={repositoryPath} onChange={(event) => onRepositoryPathChange(event.target.value)} placeholder="deploy" className="mt-1.5 w-full rounded-xl border border-border bg-card px-3 py-2 text-sm text-foreground outline-none focus:border-primary" /></label><label className="text-sm text-muted-foreground">Branch (optional)<input value={repositoryBranch} onChange={(event) => onRepositoryBranchChange(event.target.value)} placeholder="main" className="mt-1.5 w-full rounded-xl border border-border bg-card px-3 py-2 text-sm text-foreground outline-none focus:border-primary" /></label><label className="text-sm text-muted-foreground sm:col-span-2">Commit SHA (optional)<input value={repositoryCommit} onChange={(event) => onRepositoryCommitChange(event.target.value)} placeholder="a1b2c3d" className="mt-1.5 w-full rounded-xl border border-border bg-card px-3 py-2 font-mono text-sm text-foreground outline-none focus:border-primary" /></label></div><div className="mt-3 flex justify-end"><button type="button" disabled={saving || !repositoryPaths.trim()} onClick={onSave} className="inline-flex items-center gap-2 rounded-xl bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-60">{saving && <Loader2 className="size-3.5 animate-spin" />}Link source</button></div></div>}

    {preview && <div className="mt-5 rounded-xl border border-primary/25 bg-primary/[0.035] p-4"><div className="flex flex-wrap items-start justify-between gap-3"><div><h3 className="font-medium text-foreground">Reviewed manager comparison</h3><p className="mt-1 text-sm text-muted-foreground">Rendered digest {shortId(preview.renderedDigest)} · live digest {shortId(preview.liveStateDigest)}</p></div><span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${preview.noOp ? "bg-success/10 text-success" : hasRisk ? "bg-danger-bg text-danger" : "bg-warning/10 text-warning"}`}>{preview.noOp ? "No-op" : hasRisk ? "Review required" : "Changes detected"}</span></div>{preview.changes.length > 0 ? <ul className="mt-4 space-y-2">{preview.changes.map((change, index) => <li key={`${change.kind}-${change.serviceName ?? index}`} className={`rounded-lg border px-3 py-2 text-sm ${["service-remove", "network-port-change", "config-secret-reference-change"].includes(change.kind) ? "border-danger/25 bg-danger-bg/35 text-danger" : "border-border/50 bg-card text-foreground"}`}><span className="mr-2 font-mono text-xs text-muted-foreground">{change.kind}</span>{change.summary}</li>)}</ul> : <p className="mt-4 rounded-lg border border-success/20 bg-success/5 px-3 py-2 text-sm text-success">No semantic service-spec changes were detected.</p>}{preview.cannotCompareExactly.length > 0 && <div className="mt-4 rounded-lg border border-warning/25 bg-warning/5 px-3 py-2 text-sm text-warning"><p className="font-medium">Requires manual review</p><ul className="mt-1 list-disc space-y-1 pl-5">{preview.cannotCompareExactly.map((message) => <li key={message}>{message}</li>)}</ul></div>}{preview.compatibility.blockers.length > 0 && <div className="mt-4 rounded-lg border border-danger/25 bg-danger-bg/35 px-3 py-2 text-sm text-danger"><p className="font-medium">Apply blockers</p><ul className="mt-1 list-disc space-y-1 pl-5">{preview.compatibility.blockers.map((issue) => <li key={`${issue.code}-${issue.serviceName ?? "stack"}`}>{issue.message} {issue.remediation}</li>)}</ul></div>}{preview.compatibility.warnings.length > 0 && <div className="mt-4 rounded-lg border border-warning/25 bg-warning/5 px-3 py-2 text-sm text-warning"><p className="font-medium">Compatibility warnings</p><ul className="mt-1 list-disc space-y-1 pl-5">{preview.compatibility.warnings.map((issue) => <li key={`${issue.code}-${issue.serviceName ?? "stack"}`}>{issue.message} {issue.remediation}</li>)}</ul></div>}<details className="mt-4"><summary className="cursor-pointer text-sm font-medium text-foreground">View redacted rendered stack</summary><pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-border/50 bg-card p-3 font-mono text-xs leading-5 text-foreground">{preview.redactedRenderedYaml}</pre></details>{managementMode === "observe" && <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-border/50 pt-4"><p className="max-w-2xl text-sm text-muted-foreground">Claim applies this exact reviewed source under the same stack name. The first apply does not prune services absent from source, and Swarm uses existing update policies rather than stopping tasks first.</p><button type="button" disabled={claiming || preview.compatibility.blockers.length > 0} onClick={onClaim} className="inline-flex items-center gap-2 rounded-xl bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-60">{claiming ? <Loader2 className="size-3.5 animate-spin" /> : <Rocket className="size-3.5" />}Claim & apply</button></div>}</div>}

    {managementMode === "managed" && <p className="mt-4 rounded-xl border border-success/20 bg-success/5 px-3 py-2 text-sm text-success">OpenShip is the active stack controller. Export and release management before resuming deployments from Portainer or another controller.</p>}
  </section>;
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
  return <section className="rounded-2xl border border-border/50 bg-card p-5"><div className="flex items-start justify-between gap-4"><div><h2 className="font-semibold text-foreground">{service.sourceServiceName} inspection</h2><p className="mt-1 font-mono text-xs text-muted-foreground">Service {shortId(service.id)} · spec v{service.specVersion ?? "—"} · {service.endpointMode || "default"} endpoint</p></div><button type="button" onClick={onClose} className="inline-flex size-7 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground" aria-label="Close inspection"><X className="size-4" /></button></div><div className="mt-4 grid gap-3 sm:grid-cols-2">{resources.map(([label, value]) => <div key={label} className="rounded-xl border border-border/50 bg-muted/[0.18] p-3"><p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{label}</p><p className="mt-1 break-words text-sm text-foreground">{value}</p></div>)}</div>{service.routingLabels.length > 0 && <div className="mt-4 rounded-xl border border-border/50 bg-muted/[0.18] p-3"><p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">External router labels (read-only)</p><dl className="mt-2 space-y-1 font-mono text-xs text-foreground">{service.routingLabels.map((label) => <div key={label.key} className="break-all"><dt className="inline text-muted-foreground">{label.key}</dt><dd className="inline"> = {label.redacted ? "[redacted]" : label.value ?? ""}</dd></div>)}</dl>{service.routingUrls.length > 0 && <p className="mt-3 text-sm text-muted-foreground">Detected URL{service.routingUrls.length === 1 ? "" : "s"}: {service.routingUrls.map((url, index) => <span key={url}>{index > 0 ? ", " : ""}<a className="text-primary underline underline-offset-2" href={url} target="_blank" rel="noreferrer">{url}</a></span>)}</p>}</div>}{service.volumes?.length ? <p className="mt-4 rounded-xl border border-warning/25 bg-warning/5 px-3 py-2 text-sm text-warning">Named volumes can be node-local in Swarm. Verify placement and backup coverage before moving or removing this service.</p> : null}</section>;
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
