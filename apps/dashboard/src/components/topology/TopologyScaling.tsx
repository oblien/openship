"use client";

import { Icon as UiIcon } from "@repo/ui/icons";

import { useEffect, useRef, useState } from "react";
import {
  MIN_CPU_CORES,
  MIN_MEMORY_MB,
  UNKNOWN_CAPACITY,
  formatCpuCores,
  formatMemoryMb,
  resolveWorkload,
  validateAgainstCapacity,
  type ProjectResources,
} from "@repo/core";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/Switch";
import { getApiErrorMessage, projectsApi } from "@/lib/api";
import type { Service } from "@/lib/api/services";
import type { TopologyProject } from "./model";
import { TopologyClusterScaling } from "./TopologyClusterScaling";
import type { ProjectCluster } from "@repo/contracts";

export function TopologyScaling({
  project,
  service,
  onStage,
  onPlacement,
  disabled,
  placementDisabled,
  onDeploy,
  onClusterState,
}: {
  project: TopologyProject;
  service?: Service;
  disabled: boolean;
  placementDisabled: boolean;
  onDeploy: () => void;
  onClusterState?: (state: ProjectCluster) => void;
  onStage: (
    values: { cpuCores: number; memoryMb: number; swapDisabled?: boolean },
    before: ProjectResources,
    service?: Service,
  ) => void;
  onPlacement: (intent: "copy" | "move", service?: Service) => void;
}) {
  const [view, setView] = useState<ProjectResources | null>(null);
  const [cpu, setCpu] = useState("");
  const [memory, setMemory] = useState("");
  const [swapDisabled, setSwapDisabled] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [staged, setStaged] = useState(false);
  const baseline = useRef(service);
  useEffect(() => {
    let cancelled = false;
    setError(null);
    setView(null);
    void projectsApi
      .getResources(project.id)
      .then(({ data }) => {
        if (cancelled) return;
        setView(data);
        baseline.current = service;
        setCpu(String(service?.advanced?.resources?.cpuCores ?? data.production.cpuCores));
        setMemory(String(service?.advanced?.resources?.memoryMb ?? data.production.memoryMb));
        setSwapDisabled(service?.advanced?.resources?.swapDisabled === true);
      })
      .catch((reason) => {
        if (!cancelled)
          setError(getApiErrorMessage(reason, "Resource settings could not be loaded."));
      });
    return () => {
      cancelled = true;
    };
  }, [project.id, service?.id, revision]);

  const canPlace =
    project.deployTarget === "server" &&
    !!project.serverId &&
    project.appTemplateId !== "openship" &&
    !!project.activeDeploymentId;
  const staticApplication =
    !service &&
    resolveWorkload(project.options?.workloadType, project.options?.hasServer) === "static";
  return (
    <div className="space-y-5">
      {!service && !staticApplication && project.appTemplateId !== "openship" && (
        <TopologyClusterScaling
          project={project}
          resources={view?.production}
          disabled={disabled || placementDisabled}
          onDeploy={onDeploy}
          onClusterState={onClusterState}
        />
      )}
      {project.deployTarget !== "cluster" && (
        <section className="space-y-3" aria-label="Clone">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <UiIcon name="server" className="size-4 shrink-0" />
            <span className="truncate">
              {project.serverName ||
                (project.deployTarget === "cloud"
                  ? "OpenShip Cloud"
                  : project.deployTarget === "local"
                    ? "Local machine"
                    : "Current server")}
            </span>
          </div>
          {canPlace ? (
            <>
              <Button
                variant="secondary"
                className="w-full justify-between"
                disabled={disabled || placementDisabled}
                onClick={() => onPlacement("copy", service)}
              >
                <span className="flex items-center gap-2">
                  <UiIcon name="copy" />
                  {service ? "Clone service" : "Clone environment"}
                </span>
                <UiIcon name="arrow-right" className="size-4 rtl:rotate-180" />
              </Button>
              <p className="text-xs leading-relaxed text-muted-foreground">
                Independent copy on another server. Data does not stay in sync.
              </p>
              {placementDisabled && (
                <p className="text-xs text-warning">Apply or discard pending changes first.</p>
              )}
            </>
          ) : (
            <p className="text-xs leading-relaxed text-muted-foreground">
              Cloning requires a deployed project on a connected Docker server.
            </p>
          )}
        </section>
      )}
      <details className="group rounded-xl bg-muted/30">
        <summary className="flex cursor-pointer list-none items-center gap-3 rounded-xl p-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 [&::-webkit-details-marker]:hidden">
          <UiIcon name="sliders" className="size-4 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-medium">Advanced</span>
            <span className="block text-xs text-muted-foreground">
              {service ? "CPU, memory & swap" : "Resource limits"}
              {canPlace ? " · Move environment" : ""}
            </span>
          </span>
          <UiIcon
            name="chevron-down"
            className="size-4 shrink-0 text-muted-foreground group-open:rotate-180"
          />
        </summary>
        <div className="space-y-5 px-3 pb-3">
          <section className="space-y-3">
            <p className="text-xs text-muted-foreground">
              {project.deployTarget === "cluster"
                ? "Limits per instance."
                : service
                  ? "Limits for this service."
                  : "Environment defaults. Service overrides are preserved."}
            </p>
            {staticApplication ? (
              <p className="rounded-xl bg-muted/40 p-3 text-xs text-muted-foreground">
                Static files have no running container to resize.
              </p>
            ) : (
              <>
                {!view && !error && (
                  <div
                    role="status"
                    className="flex items-center gap-2 text-xs text-muted-foreground"
                  >
                    <UiIcon name="spinner" className="size-3.5 animate-spin" />
                    Loading resource settings…
                  </div>
                )}
                {view && (
                  <form
                    onSubmit={(event) => {
                      event.preventDefault();
                      const values = {
                        cpuCores: Number(cpu),
                        memoryMb: Number(memory),
                        ...(swapDisabled && { swapDisabled: true }),
                      };
                      const invalid =
                        !cpu.trim() ||
                        !memory.trim() ||
                        !Number.isFinite(values.cpuCores) ||
                        !Number.isFinite(values.memoryMb) ||
                        values.cpuCores < 0 ||
                        values.memoryMb < 0 ||
                        !Number.isInteger(values.memoryMb);
                      const problem = invalid
                        ? "Enter a valid CPU limit and whole-number memory limit."
                        : swapDisabled && !(values.memoryMb > 0)
                          ? "Disabling swap requires a positive memory limit."
                          : view.requiresLimit && (!values.cpuCores || !values.memoryMb)
                            ? "This target requires explicit CPU and memory limits."
                            : validateAgainstCapacity(
                                { ...values, diskMb: view.production.diskMb },
                                view.capacity ?? UNKNOWN_CAPACITY,
                              );
                      if (problem) {
                        setError(problem);
                        return;
                      }
                      setError(null);
                      onStage(values, view, baseline.current);
                      setStaged(true);
                    }}
                    className="space-y-3"
                  >
                    <div className="grid grid-cols-2 gap-3">
                      <label className="space-y-1.5 text-xs text-muted-foreground">
                        CPU cores
                        <input
                          className="topology-input"
                          type="number"
                          min={view.requiresLimit ? MIN_CPU_CORES : 0}
                          step="any"
                          value={cpu}
                          onChange={(event) => {
                            setCpu(event.target.value);
                            setStaged(false);
                          }}
                          required
                        />
                      </label>
                      <label className="space-y-1.5 text-xs text-muted-foreground">
                        Memory (MB)
                        <input
                          className="topology-input"
                          type="number"
                          min={view.requiresLimit ? MIN_MEMORY_MB : 0}
                          step="1"
                          value={memory}
                          onChange={(event) => {
                            setMemory(event.target.value);
                            setStaged(false);
                          }}
                          required
                        />
                      </label>
                    </div>
                    {!view.requiresLimit && (
                      <p className="text-[11px] text-muted-foreground">Use 0 for no limit.</p>
                    )}
                    {service && (
                      <div className="flex items-center justify-between gap-3">
                        <div className="space-y-1">
                          <p className="text-xs">Disable swap</p>
                          <p className="text-[11px] text-muted-foreground">
                            Requires a memory limit and host swap support.
                          </p>
                        </div>
                        <Switch
                          ariaLabel="Disable swap"
                          checked={swapDisabled}
                          disabled={disabled}
                          onChange={(checked) => {
                            setSwapDisabled(checked);
                            setStaged(false);
                          }}
                        />
                      </div>
                    )}
                    {view.capacity && view.capacity.source !== "unknown" && (
                      <p className="text-[11px] text-muted-foreground">
                        Server capacity: {formatCpuCores(view.capacity.cpuCores)} ·{" "}
                        {formatMemoryMb(view.capacity.memoryMb)}
                      </p>
                    )}
                    <Button
                      type="submit"
                      className="w-full"
                      variant="outline"
                      disabled={disabled || staged}
                    >
                      {staged ? "Added to pending changes" : "Stage changes"}
                    </Button>
                  </form>
                )}
              </>
            )}
            {error && (
              <div role="alert" className="space-y-2 text-xs text-danger">
                <p>{error}</p>
                {!view && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setRevision((value) => value + 1)}
                  >
                    Retry
                  </Button>
                )}
              </div>
            )}
          </section>
          {canPlace && (
            <section className="space-y-3 border-t border-border/50 pt-4">
              <p className="text-xs text-muted-foreground">
                Move every service in this environment to another server.
              </p>
              <Button
                variant="outline"
                className="w-full justify-start gap-2"
                disabled={disabled || placementDisabled}
                onClick={() => onPlacement("move")}
              >
                <UiIcon name="arrows-left-right" />
                Move environment
              </Button>
            </section>
          )}
        </div>
      </details>
    </div>
  );
}
