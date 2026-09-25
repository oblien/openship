"use client";

import { Icon as UiIcon } from "@repo/ui/icons";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import type { ComputeCluster, ProjectCluster } from "@repo/contracts";
import {
  clusterWorkloadNeedsOperator,
  formatCpuCores,
  formatMemoryMb,
  resolveWorkload,
  type ProjectResources,
} from "@repo/core";
import { useProjectSettings } from "@/context/ProjectSettingsContext";
import { usePlatform } from "@/context/PlatformContext";
import { useI18n } from "@/components/i18n-provider";
import { Button } from "@/components/ui/button";
import { CustomSelect } from "@/components/ui/CustomSelect";
import { Checkbox } from "@/components/ui/Checkbox";
import {
  ClusterScalingStatus,
  clusterScalingState,
} from "@/components/servers/clusters/ClusterScalingStatus";
import { computeClustersApi } from "@/lib/api/compute-clusters";
import { projectClusterApi } from "@/lib/api/project-cluster";
import { getApiErrorMessage } from "@/lib/api";
import { clusterInstances, type TopologyProject } from "./model";

type Props = {
  project: TopologyProject;
  disabled: boolean;
  resources?: ProjectResources["production"];
  onDeploy: () => void;
  onClusterState?: (state: ProjectCluster) => void;
};

export function TopologyClusterScaling(props: Props) {
  const { selfHosted } = usePlatform();
  if (!selfHosted || props.project.deployTarget === "cloud") return null;
  if (
    clusterWorkloadNeedsOperator(props.project.framework) ||
    clusterWorkloadNeedsOperator(props.project.appTemplateId)
  ) {
    return (
      <section className="space-y-2 rounded-xl bg-muted/40 p-3">
        <h3 className="flex items-center gap-2 text-sm font-medium">
          <UiIcon name="database" className="size-4 text-info" /> Database scaling
        </h3>
        <p className="text-xs leading-relaxed text-muted-foreground">
          To use a replicated database, add PostgreSQL or Redis from an application's cluster
          topology, then migrate the data. This existing database stays on its current server;
          its CPU and memory can be adjusted below.
        </p>
      </section>
    );
  }
  return <ClusterScaling key={props.project.id} {...props} />;
}

function ClusterScaling({ project, disabled, resources, onDeploy, onClusterState }: Props) {
  const router = useRouter();
  const { t } = useI18n();
  const { updateProjectData } = useProjectSettings();
  const [view, setView] = useState<ProjectCluster | null>(null);
  const [clusters, setClusters] = useState<ComputeCluster[]>([]);
  const [clusterId, setClusterId] = useState("");
  const [instances, setInstances] = useState("1");
  const [repository, setRepository] = useState("");
  const [acknowledged, setAcknowledged] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  const pending = useRef(false);
  useEffect(() => {
    let current = true;
    setLoading(true);
    setError(null);
    setCatalogError(null);
    void Promise.allSettled([projectClusterApi.get(project.id), computeClustersApi.list()]).then(
      (results) => {
        if (!current) return;
        const state = results[0];
        if (state.status === "fulfilled") {
          onClusterState?.(state.value);
          setView(state.value);
          setClusterId(state.value.clusterId ?? "");
          setInstances(String(state.value.config?.replicas ?? 1));
          setRepository(state.value.config?.imageRepository ?? "");
          setAcknowledged(!!state.value.clusterId);
        } else {
          setView(null);
          setError(getApiErrorMessage(state.reason, "Scaling settings could not be loaded."));
        }
        if (results[1].status === "fulfilled") setClusters(results[1].value);
        else
          setCatalogError(
            getApiErrorMessage(results[1].reason, "Available clusters could not be loaded."),
          );
        setLoading(false);
      },
    );
    return () => {
      current = false;
    };
  }, [project.id, project.activeDeploymentId, revision, onClusterState]);

  const count = Number(instances);
  const validCount = Number.isInteger(count) && count >= 1 && count <= 100;
  const selected = clusters.find((cluster) => cluster.id === clusterId);
  const selectedState = clusterScalingState(selected);
  // Project operators may scale an existing release without access to the fleet catalog.
  // A successful workload observation already passed the backend's runtime readiness check.
  const observedCurrentTarget =
    !!view?.status &&
    !view.error &&
    !!clusterId &&
    clusterId === view.clusterId &&
    clusterId === view.activeClusterId;
  const ready = selectedState === "ready" || (selectedState === "unknown" && observedCurrentTarget);
  const imageRequired = view?.requiresImageRepository !== false;
  const settingsChanged =
    !!view &&
    (clusterId !== (view.clusterId ?? "") ||
      (!!clusterId &&
        (count !== view.config?.replicas ||
          repository.trim() !== (view.config?.imageRepository ?? ""))));
  const onlyInstancesChanged =
    !!view?.clusterId &&
    clusterId === view.clusterId &&
    repository.trim() === (view.config?.imageRepository ?? "") &&
    view.activeClusterId === view.clusterId;
  // A failed admission may have saved the desired count without starting a release.
  const needsInstanceRelease =
    onlyInstancesChanged &&
    (count !== view?.config?.replicas ||
      (!!view?.status && view.status.desired > 0 && view.status.desired !== count));
  const blocked =
    busy ||
    disabled ||
    loading ||
    !view ||
    (!!clusterId &&
      (!ready ||
        !validCount ||
        !acknowledged ||
        (!!catalogError && !onlyInstancesChanged) ||
        (imageRequired && !repository.trim())));
  const activeCluster = clusters.find((cluster) => cluster.id === view?.activeClusterId);
  const destinationPending = !!view?.activeClusterId && view.activeClusterId !== view.clusterId;
  const currentServerId = view?.serverId !== undefined ? view.serverId : project.serverId;
  const observed = view?.status ? clusterInstances(view.status) : [];
  const allReady =
    !!view?.status && view.status.desired > 0 && view.status.ready >= view.status.desired;
  const HealthIcon = allReady ? "check-circle" : view?.status?.desired ? "alert-circle" : "circle";
  const updateTarget = (next: ProjectCluster) => {
    setView(next);
    onClusterState?.(next);
    const serverId = next.serverId !== undefined ? next.serverId : (project.serverId ?? null);
    updateProjectData({
      clusterId: next.clusterId,
      clusterConfig: next.config,
      deployTarget: next.clusterId ? "cluster" : serverId ? "server" : "local",
      serverId: next.clusterId ? null : serverId,
    });
  };
  const apply = async () => {
    if (!view || pending.current || blocked) return;
    pending.current = true;
    setBusy(true);
    setError(null);
    let navigating = false;
    try {
      if (needsInstanceRelease) {
        const result = await projectClusterApi.scale(project.id, {
          replicas: count,
          expectedDeploymentId: view.activeDeploymentId!,
          expectedUpdatedAt: view.updatedAt,
        });
        router.push(`/build/${result.deploymentId}`);
        navigating = true;
        return;
      }
      if (settingsChanged) {
        const next = await projectClusterApi.set(project.id, {
          clusterId: clusterId || null,
          ...(clusterId
            ? {
                config: {
                  replicas: count,
                  ...(repository.trim() ? { imageRepository: repository.trim() } : {}),
                },
              }
            : {}),
          expectedUpdatedAt: view.updatedAt,
          stateless: true,
        });
        updateTarget(next);
      }
      if (clusterId || (!settingsChanged && destinationPending)) onDeploy();
    } catch (reason) {
      setError(getApiErrorMessage(reason, "Scaling settings could not be applied."));
      // A lost response can have saved the target. Read once; never replay or deploy implicitly.
      try {
        updateTarget(await projectClusterApi.get(project.id));
      } catch {}
    } finally {
      if (!navigating) {
        pending.current = false;
        setBusy(false);
      }
    }
  };
  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between gap-2">
        <h3 className="flex items-center gap-2 text-sm font-medium">
          <UiIcon name="layers" className="size-4 text-info" /> Run across servers
        </h3>
        <Button
          size="icon"
          className="size-7"
          variant="ghost"
          aria-label="Refresh scaling status"
          disabled={busy || loading}
          onClick={() => {
            setLoading(true);
            setRevision((value) => value + 1);
          }}
        >
          <UiIcon name="refresh" className={`size-3.5 ${loading ? "animate-spin" : ""}`} />
        </Button>
      </div>
      <p className="text-xs leading-relaxed text-muted-foreground">
        {resolveWorkload(project.options?.workloadType, project.options?.hasServer) === "web"
          ? "Run multiple instances of this application. Traffic goes to healthy instances automatically."
          : "Run multiple instances of this worker. Each instance processes work independently."}
      </p>
      {!view && loading && (
        <div role="status" className="flex items-center gap-2 text-xs text-muted-foreground">
          <UiIcon name="spinner" className="size-4 animate-spin" /> Loading scaling settings…
        </div>
      )}
      {view && (
        <>
          {view.status && (
            <div className="space-y-3 rounded-xl bg-muted/40 p-3">
              <div className="flex items-center justify-between gap-2 text-sm">
                <span className="flex items-center gap-2">
                  <UiIcon name={HealthIcon}
                    className={`size-4 ${allReady ? "text-success" : view.status.desired ? "text-warning" : "text-muted-foreground"}`}
                  />
                  Ready instances
                </span>
                <span className="font-medium tabular-nums">
                  {view.status.ready} / {view.status.desired}
                </span>
              </div>
              {activeCluster && (
                <p className="text-xs text-muted-foreground">Running on {activeCluster.name}</p>
              )}
              <ul className="space-y-2">
                {observed.map(({ pod, name, server, state }) => (
                  <li key={pod.name} className="flex items-start gap-2 text-xs">
                    <UiIcon name="server" className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate">
                        {name} · {server}
                      </span>
                      <span
                        className={state === "failed" ? "text-danger" : "text-muted-foreground"}
                      >
                        {pod.ready
                          ? "Ready"
                          : state === "failed"
                            ? "Needs attention"
                            : state === "stopped"
                              ? "Stopped"
                              : state === "unknown"
                                ? "Status unavailable"
                                : "Starting"}
                        {pod.restarts ? ` · ${pod.restarts} restarts` : ""}
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
              {!observed.length && (
                <p className="text-xs text-muted-foreground">
                  {view.status.desired
                    ? "Waiting for instances to start."
                    : "No instances running."}
                </p>
              )}
              {view.status.message && <p className="text-xs text-warning">{view.status.message}</p>}
              {view.observedAt && (
                <p className="text-xs text-muted-foreground">
                  Checked {new Date(view.observedAt).toLocaleTimeString()}
                </p>
              )}
            </div>
          )}
          {view.error && (
            <p role="status" className="text-xs text-warning">
              {view.error}
            </p>
          )}
          {destinationPending && (
            <p role="status" className="text-xs leading-relaxed text-muted-foreground">
              Your destination is saved. The running instances stay on{" "}
              {activeCluster?.name ?? "the previous cluster"} until the next deployment succeeds.
            </p>
          )}
          <label className="block space-y-1.5 text-xs text-muted-foreground">
            <span>Run on</span>
            <CustomSelect
              value={clusterId}
              variant="filled"
              aria-label="Project cluster"
              disabled={busy || disabled || loading || !!catalogError}
              options={[
                {
                  value: "",
                  label: currentServerId ? "Current server" : "This installation's server",
                  icon: <UiIcon name="server" className="size-4" />,
                },
                ...clusters.map((cluster) => ({
                  value: cluster.id,
                  label: cluster.name,
                  icon: <UiIcon name="layers" className="size-4 text-info" />,
                  description: `${cluster.serverIds.length} ${cluster.serverIds.length === 1 ? "server" : "servers"} · ${t.servers.runtime.status[clusterScalingState(cluster)]}`,
                })),
                ...(view.clusterId && !clusters.some((cluster) => cluster.id === view.clusterId)
                  ? [
                      {
                        value: view.clusterId,
                        label: "Current server cluster",
                        icon: <UiIcon name="layers" className="size-4 text-info" />,
                      },
                    ]
                  : []),
              ]}
              footerAction={{
                label: "Create server cluster",
                icon: <UiIcon name="plus" className="size-4" />,
                onClick: () => router.push("/servers/clusters/new"),
              }}
              onChange={(value) => {
                setClusterId(value);
                setAcknowledged(value === view.clusterId);
              }}
            />
          </label>
          {!!clusterId && !ready && !catalogError && (
            <div className="space-y-2 rounded-xl bg-muted/40 p-3">
              {selected ? (
                <ClusterScalingStatus cluster={selected} />
              ) : (
                <p className="text-xs text-warning">
                  This cluster is unavailable. Refresh or choose another cluster.
                </p>
              )}
              {selected && (
                <>
                  <p className="text-xs leading-relaxed text-muted-foreground">
                    Finish enabling scaling on this cluster before deploying applications to it.
                  </p>
                  <Link
                    href={`/servers/clusters/${selected.id}`}
                    className="inline-flex items-center gap-1.5 text-xs font-medium text-primary hover:underline"
                  >
                    Open cluster setup <UiIcon name="arrow-right" className="size-3.5" />
                  </Link>
                </>
              )}
            </div>
          )}
          {!!clusterId && ready && (
            <>
              <label className="block space-y-1.5 text-xs text-muted-foreground">
                <span>Instances</span>
                <input
                  className="topology-input"
                  type="number"
                  min={1}
                  max={100}
                  step={1}
                  value={instances}
                  disabled={busy || disabled || loading}
                  onChange={(event) => setInstances(event.target.value)}
                />
              </label>
              {!validCount && (
                <p role="alert" className="text-xs text-danger">
                  Choose between 1 and 100 instances.
                </p>
              )}
              {validCount && (
                <div className="space-y-1 text-xs leading-relaxed text-muted-foreground">
                  {needsInstanceRelease && (
                    <p>
                      {view.status?.desired ?? view.config?.replicas} → {count} instances
                    </p>
                  )}
                  <p>Instances are placed automatically on available servers.</p>
                  {resources && resources.cpuCores > 0 && resources.memoryMb > 0 && (
                    <p>
                      Per instance: {formatCpuCores(resources.cpuCores)} ·{" "}
                      {formatMemoryMb(resources.memoryMb)}.
                      {count > 1 && (
                        <>
                          {" "}
                          Total limits: {formatCpuCores(resources.cpuCores * count)} ·{" "}
                          {formatMemoryMb(resources.memoryMb * count)}.
                        </>
                      )}
                    </p>
                  )}
                </div>
              )}
              {imageRequired && (
                <details className="text-xs" open={!view.config?.imageRepository || undefined}>
                  <summary className="cursor-pointer text-muted-foreground">
                    Build delivery{!repository.trim() ? " · Required" : ""}
                  </summary>
                  <div className="mt-3 space-y-2">
                    <label className="block space-y-1.5 text-muted-foreground">
                      <span>Image repository</span>
                      <input
                        className="topology-input"
                        placeholder="ghcr.io/team/api"
                        value={repository}
                        disabled={busy || disabled || loading}
                        onChange={(event) => setRepository(event.target.value)}
                      />
                    </label>
                    <p className="leading-relaxed text-muted-foreground">
                      OpenShip builds your application once and publishes it here so every server
                      can run the same release. Private repositories use your saved registry
                      credentials.
                    </p>
                  </div>
                </details>
              )}
              {clusterId !== view.clusterId && (
                <label className="flex items-start gap-2 text-xs leading-relaxed">
                  <Checkbox
                    checked={acknowledged}
                    onCheckedChange={setAcknowledged}
                    aria-label="Instances can run independently"
                    disabled={busy || disabled || loading}
                  />
                  <span>
                    Each instance can run independently. Important data is stored outside the
                    application instance.
                  </span>
                </label>
              )}
            </>
          )}
          {(!!clusterId || settingsChanged || destinationPending) && (
            <div className="space-y-2">
              <Button className="w-full" size="sm" disabled={blocked} onClick={() => void apply()}>
                {busy && <UiIcon name="spinner" className="size-4 animate-spin" />}
                {needsInstanceRelease
                  ? "Apply scaling"
                  : clusterId || !settingsChanged
                    ? "Review deployment"
                    : "Save destination"}
              </Button>
              {settingsChanged && !needsInstanceRelease && (
                <p className="text-xs leading-relaxed text-muted-foreground">
                  {clusterId
                    ? "Saves these settings, then opens deployment review. Your running application stays in place until deployment succeeds."
                    : "Changes the next deployment destination. Existing cluster instances stay active until you deploy."}
                </p>
              )}
              {needsInstanceRelease && (
                <p className="text-xs leading-relaxed text-muted-foreground">
                  Uses the current release. Progress opens when scaling starts.
                </p>
              )}
            </div>
          )}
          {!!clusterId && ready && (
            <p className="text-xs leading-relaxed text-muted-foreground">
              Keep capacity for the current and new instances during deployment.
            </p>
          )}
          {(view.activeClusterId || view.internalHost) && (
            <details className="text-xs">
              <summary className="cursor-pointer text-muted-foreground">Technical details</summary>
              <div className="mt-3 space-y-3 text-muted-foreground">
                <p>
                  Kubernetes (K3s) manages instance placement and recovery. OpenShip Edge currently
                  sends incoming traffic through one cluster server.
                </p>
                {view.internalHost && (
                  <p className="break-all">
                    Internal DNS: <span className="font-mono">{view.internalHost}</span>
                  </p>
                )}
                {observed.length > 0 && (
                  <dl className="space-y-2">
                    {observed.map(({ pod, name }) => (
                      <div key={pod.name}>
                        <dt className="text-foreground">{name}</dt>
                        <dd className="break-all font-mono">{pod.name}</dd>
                        <dd className="break-all">
                          {pod.nodeName ?? "Unassigned"} · {pod.phase}
                        </dd>
                      </div>
                    ))}
                  </dl>
                )}
              </div>
            </details>
          )}
        </>
      )}
      {error && (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      )}
      {catalogError && (
        <p role="alert" className="text-xs text-danger">
          {catalogError}
        </p>
      )}
      {!clusters.length && view && !catalogError && !loading && (
        <Link
          href="/servers/clusters/new"
          className="inline-flex items-center gap-1.5 text-xs font-medium text-primary hover:underline"
        >
          <UiIcon name="plus" className="size-3.5" /> Create server cluster
        </Link>
      )}
    </section>
  );
}
