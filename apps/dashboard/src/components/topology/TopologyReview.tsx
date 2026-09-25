"use client";

import { Icon as UiIcon } from "@repo/ui/icons";

import { formatCpuCores, formatMemoryMb } from "@repo/core";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/button";
import {
  canRefreshChanges,
  canStartAddedServices,
  type DeploymentIntent,
  type TopologyChange,
} from "./changes";
import type { TopologyProject } from "./model";

function ChangeDescription({ change }: { change: TopologyChange }) {
  if (change.kind === "connections-saved")
    return <>The connection is saved. Redeploy to apply its variables to this environment.</>;
  if (change.kind === "resources")
    return (
      <>
        {formatCpuCores(change.before.cpuCores)} / {formatMemoryMb(change.before.memoryMb)} →{" "}
        {formatCpuCores(change.values.cpuCores)} / {formatMemoryMb(change.values.memoryMb)}
      </>
    );
  if (change.kind === "create-service") {
    const resources = change.input.advanced?.resources;
    return (
      <>
        {change.input.image || "Build from source"}
        {Object.keys(change.input.environment ?? {}).length
          ? ` · ${Object.keys(change.input.environment ?? {}).length} environment variables`
          : ""}
        {resources
          ? ` · ${resources.cpuCores !== undefined ? formatCpuCores(resources.cpuCores) : "Inherited CPU"} / ${resources.memoryMb !== undefined ? formatMemoryMb(resources.memoryMb) : "Inherited memory"}`
          : ""}
      </>
    );
  }
  if (change.kind === "update-service") {
    const resources = change.patch.advanced?.resources;
    const fields = Object.keys(change.patch)
      .filter((key) => key !== "kind")
      .map((key) => {
        if (key === "dependsOn")
          return change.patch.dependsOn?.length
            ? `Starts after ${change.patch.dependsOn.join(", ")}`
            : "Remove startup dependencies";
        if (key === "image") return change.patch.image || "Build from source";
        if (key === "enabled")
          return change.patch.enabled ? "Enabled for deployment" : "Disable on deployment";
        if (key === "advanced" && resources)
          return `${resources.cpuCores !== undefined ? formatCpuCores(resources.cpuCores) : "Inherited CPU"} / ${resources.memoryMb !== undefined ? formatMemoryMb(resources.memoryMb) : "Inherited memory"}${Object.keys(change.patch.advanced ?? {}).length > 1 ? " and runtime options" : ""}`;
        return key === "advanced" ? "Runtime options" : key;
      });
    return <>{fields.join(" · ")}</>;
  }
  return (
    <>
      Removes the binding and its injected variable. The linked service stays in its owning project.
    </>
  );
}

export function TopologyReview({
  project,
  changes,
  intent,
  serviceName,
  canRefresh,
  open,
  applying,
  error,
  blocked,
  onIntent,
  onApply,
  onClose,
}: {
  project: TopologyProject;
  changes: TopologyChange[];
  intent: DeploymentIntent;
  serviceName?: string;
  canRefresh: boolean;
  open: boolean;
  applying: boolean;
  error: string | null;
  blocked?: string;
  onIntent: (intent: DeploymentIntent) => void;
  onApply: () => void;
  onClose: () => void;
}) {
  const saved = changes.filter((change) => change.saved).length;
  const deployed = !!project.activeDeploymentId;
  const directStart = deployed && canStartAddedServices(changes);
  const refreshAllowed = deployed && canRefresh && canRefreshChanges(changes);
  const scopeName = !deployed
    ? "Whole environment"
    : directStart
      ? changes
          .flatMap((change) => (change.kind === "create-service" ? [change.input.name] : []))
          .join(", ")
      : serviceName || "Whole environment";
  return (
    <Modal
      isOpen={open}
      onClose={onClose}
      closable={!applying}
      showCloseButton={!applying}
      maxWidth="560px"
      width="100%"
    >
      <div className="space-y-5 p-6">
        <div className="space-y-1.5 pe-8">
          <div className="mb-4 flex size-10 items-center justify-center rounded-xl bg-primary/10 text-primary">
            <UiIcon name="rocket" className="size-5" />
          </div>
          <h2 className="text-lg font-semibold">
            {changes.length ? "Review topology changes" : "Review deployment"}
          </h2>
          <p className="text-sm text-muted-foreground">
            {project.name} · {project.environmentName || project.environmentType || "Production"}
          </p>
        </div>
        <div className="flex flex-wrap justify-between gap-3 rounded-xl border border-border/50 bg-muted/25 p-3 text-xs">
          <div className="min-w-0 space-y-1">
            <p className="text-muted-foreground">
              {directStart ? "Services to start" : "Deployment scope"}
            </p>
            <p className="break-words font-medium">{scopeName}</p>
          </div>
          <div className="space-y-1 text-end">
            <p className="text-muted-foreground">Current release</p>
            <p className="font-medium">
              {project.activeVersion != null
                ? `v${project.activeVersion}`
                : deployed
                  ? "Active deployment"
                  : "Not deployed"}
            </p>
          </div>
        </div>
        {changes.length > 0 && (
          <ul className="max-h-64 divide-y divide-border/50 overflow-y-auto rounded-xl border border-border/50">
            {changes.map((change) => (
              <li key={change.id} className="flex items-start gap-3 p-3">
                <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-muted/60 text-muted-foreground">
                  {change.saved ? (
                    <UiIcon name="check" className="size-3 text-success" />
                  ) : (
                    <span className="size-1.5 rounded-full bg-warning" />
                  )}
                </span>
                <div className="min-w-0">
                  <p className="text-xs font-medium">
                    {change.title}
                    {change.kind === "create-service" && change.started
                      ? " · Started"
                      : change.saved
                        ? " · Saved"
                        : ""}
                  </p>
                  <p className="mt-1 break-words text-[11px] leading-relaxed text-muted-foreground">
                    <ChangeDescription change={change} />
                  </p>
                </div>
              </li>
            ))}
          </ul>
        )}
        {directStart ? (
          <p className="rounded-xl bg-muted/30 p-3 text-xs leading-relaxed text-muted-foreground">
            Start the new services from their configured images on this environment’s server.
            Existing services keep running.
          </p>
        ) : deployed ? (
          <fieldset disabled={applying} className="space-y-2">
            <legend className="mb-2 text-xs font-medium">Apply with</legend>
            {refreshAllowed && (
              <label
                className={`flex cursor-pointer items-start gap-3 rounded-xl border p-3 ${intent === "refresh" ? "border-primary/40 bg-primary/5" : "border-border/50"}`}
              >
                <input
                  type="radio"
                  name="topology-deployment-intent"
                  value="refresh"
                  checked={intent === "refresh"}
                  onChange={() => onIntent("refresh")}
                  className="mt-0.5 accent-primary"
                />
                <span>
                  <span className="block text-xs font-medium">Current release</span>
                  <span className="mt-1 block text-[11px] leading-relaxed text-muted-foreground">
                    Recreate the selected workloads using their retained images and current
                    configuration.
                  </span>
                </span>
              </label>
            )}
            <label
              className={`flex cursor-pointer items-start gap-3 rounded-xl border p-3 ${intent === "update" ? "border-primary/40 bg-primary/5" : "border-border/50"}`}
            >
              <input
                type="radio"
                name="topology-deployment-intent"
                value="update"
                checked={intent === "update"}
                onChange={() => onIntent("update")}
                className="mt-0.5 accent-primary"
              />
              <span>
                <span className="block text-xs font-medium">Latest source & configuration</span>
                <span className="mt-1 block text-[11px] leading-relaxed text-muted-foreground">
                  Build and deploy using the project’s saved source settings.
                </span>
              </span>
            </label>
          </fieldset>
        ) : (
          <p className="rounded-xl bg-muted/30 p-3 text-xs leading-relaxed text-muted-foreground">
            Save the configuration, then continue in the existing deployment setup to choose a
            target and deploy.
          </p>
        )}
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          {directStart
            ? "Runtime status and logs are available on each service after launch."
            : deployed
              ? "Affected services may restart. Deployment progress, logs, and rollback remain in the project’s deployment history."
              : "No resources are provisioned before you deploy."}
        </p>
        {error && (
          <div
            role="alert"
            className="space-y-2 rounded-xl border border-danger/20 bg-danger/5 p-3 text-xs text-danger"
          >
            {saved > 0 && (
              <p className="font-medium">
                {saved} configuration change(s) were saved.{" "}
                {directStart
                  ? "Check service status before retrying."
                  : "Deployment could not be confirmed."}
              </p>
            )}
            <p className="leading-relaxed">{error}</p>
          </div>
        )}
        {blocked && !applying && (
          <p role="status" className="text-xs text-muted-foreground">
            {blocked}
          </p>
        )}
        <div className="flex justify-end gap-2 border-t border-border/50 pt-4">
          <Button variant="ghost" disabled={applying} onClick={onClose}>
            Back
          </Button>
          <Button
            disabled={applying || !!blocked || (intent === "refresh" && !refreshAllowed)}
            onClick={onApply}
          >
            {applying ? (
              <>
                <UiIcon name="spinner" className="size-4 animate-spin" />
                Applying…
              </>
            ) : directStart ? (
              "Apply & start services"
            ) : deployed ? (
              "Apply & deploy"
            ) : (
              "Save & continue"
            )}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
