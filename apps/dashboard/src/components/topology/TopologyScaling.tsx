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
    values: { cpuCores: number; memoryMb: number },
    before: ProjectResources,
    service?: Service,
  ) => void;
  onPlacement: (intent: "copy" | "move", service?: Service) => void;
}) {
  const [view, setView] = useState<ProjectResources | null>(null);
  const [cpu, setCpu] = useState("");
  const [memory, setMemory] = useState("");
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
    <div className="space-y-6">
      {!service && !staticApplication && project.appTemplateId !== "openship" && (
        <TopologyClusterScaling
          project={project}
          resources={view?.production}
          disabled={disabled || placementDisabled}
          onDeploy={onDeploy}
          onClusterState={onClusterState}
        />
      )}
      <section className="space-y-3">
        <div className="flex items-center gap-2 text-sm font-medium">
          <UiIcon name="cpu" className="size-4 text-muted-foreground" />
          {project.deployTarget === "cluster" ? "Resources per instance" : "CPU & memory"}
        </div>
        <p className="text-xs leading-relaxed text-muted-foreground">
          {project.deployTarget === "cluster"
            ? "CPU and memory limits for each application instance. Review and apply to update all instances."
            : service
              ? "Limits for this service. Review and apply to update its resources."
              : "Default runtime limits for this environment. Services with their own limits keep those overrides."}
        </p>
        {staticApplication ? (
          <p className="rounded-xl bg-muted/40 p-3 text-xs text-muted-foreground">
            This application serves static files and has no application container to resize.
          </p>
        ) : (
          <>
            {!view && !error && (
              <div role="status" className="flex items-center gap-2 text-xs text-muted-foreground">
                <UiIcon name="spinner" className="size-3.5 animate-spin" />
                Loading resource settings…
              </div>
            )}
            {view && (
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  const values = { cpuCores: Number(cpu), memoryMb: Number(memory) };
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
                  {staged ? "Added to pending changes" : "Stage resource change"}
                </Button>
              </form>
            )}
          </>
        )}
        {error && (
          <div role="alert" className="space-y-2 text-xs text-danger">
            <p>{error}</p>
            {!view && (
              <Button variant="outline" size="sm" onClick={() => setRevision((value) => value + 1)}>
                Retry
              </Button>
            )}
          </div>
        )}
      </section>
      {project.deployTarget !== "cluster" && (
        <section className="space-y-3 border-t border-border/50 pt-5">
          <p className="text-sm font-medium">Server placement</p>
          <p className="text-xs leading-relaxed text-muted-foreground">
            {project.serverName ||
              (project.deployTarget === "cloud"
                ? "OpenShip Cloud"
                : project.deployTarget === "local"
                  ? "Local machine"
                  : "Current server")}
          </p>
          {canPlace ? (
            <>
              <Button
                variant="outline"
                className="w-full justify-start gap-2"
                disabled={disabled || placementDisabled}
                onClick={() => onPlacement("copy", service)}
              >
                <UiIcon name="copy" />
                {service ? "Clone service to another server" : "Clone to another server"}
              </Button>
              <p className="text-[11px] leading-relaxed text-muted-foreground">
                Creates an independent copy with its own data and deployment history.
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
              {placementDisabled && (
                <p className="text-[11px] text-muted-foreground">
                  Apply or discard pending changes before cloning or moving.
                </p>
              )}
              {service && (
                <p className="text-[11px] leading-relaxed text-muted-foreground">
                  Moving relocates all services in this environment together.
                </p>
              )}
            </>
          ) : (
            <p className="rounded-xl bg-muted/40 p-3 text-xs leading-relaxed text-muted-foreground">
              Clone and move are available for deployed projects on connected Docker servers.
            </p>
          )}
        </section>
      )}
    </div>
  );
}
