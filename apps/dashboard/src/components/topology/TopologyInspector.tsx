"use client";

import { useState } from "react";
import {
  ArrowRight,
  ArrowUpRight,
  ChevronUp,
  FileText,
  KeyRound,
  Play,
  RotateCw,
  Settings2,
  Square,
  Unplug,
  X,
} from "lucide-react";
import { resolveWorkload, type ProjectResources } from "@repo/core";
import { Button } from "@/components/ui/button";
import { ServiceSettingsForm } from "@/app/(dashboard)/projects/[id]/components/services/ServiceSettingsForm";
import { serviceCanStartWithoutBuild, type Service, type ServiceInput } from "@/lib/api/services";
import { TopologyResourceIcon, TopologyStatus } from "./TopologyCanvas";
import { TopologyScaling } from "./TopologyScaling";
import type {
  ProjectTopologyGraph,
  TopologyProject,
  TopologyRelation,
  TopologyResource,
} from "./model";
import type { DeploymentIntent } from "./changes";

export function RelationPreview({
  relation,
  graph,
}: {
  relation: TopologyRelation;
  graph: ProjectTopologyGraph;
}) {
  const source = graph.nodes.find((node) => node.id === relation.source);
  const target = graph.nodes.find((node) => node.id === relation.target);
  return (
    <div className="mx-4 flex items-center gap-2 rounded-xl border border-border/50 bg-muted/30 px-3 py-2.5 text-xs">
      <span className="min-w-0 flex-1 truncate" title={source?.name}>
        {source?.name}
      </span>
      <ArrowRight className="size-3 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1 truncate text-end" title={target?.name}>
        {target?.name}
      </span>
    </div>
  );
}

function Detail({ label, value }: { label: string; value: string | undefined | null }) {
  if (!value) return null;
  return (
    <div className="space-y-1">
      <dt className="text-[11px] text-muted-foreground">{label}</dt>
      <dd className="break-words text-xs text-foreground">{value}</dd>
    </div>
  );
}

function ServiceConfiguration({
  service,
  siblings,
  onSave,
}: {
  service: Service;
  siblings: string[];
  onSave: (service: Service, patch: Partial<ServiceInput>) => Promise<void>;
}) {
  // Runtime polling must not re-seed a form while someone is typing. This
  // snapshot also remains the baseline used by the apply conflict check.
  const [baseline] = useState(service);
  return (
    <ServiceSettingsForm
      service={baseline}
      siblingServiceNames={siblings}
      submitLabel="Stage changes"
      onSubmit={(patch) => onSave(baseline, patch)}
    />
  );
}

export function TopologyInspector({
  project,
  graph,
  resource,
  relation,
  initialTab = "overview",
  disabled,
  busy,
  hasPendingChanges,
  onMinimize,
  onClose,
  onNavigate,
  onSave,
  onResources,
  onPlacement,
  onLifecycle,
  onDeploy,
  onRemoveRelation,
  onSelectRelation,
}: {
  project: TopologyProject;
  graph: ProjectTopologyGraph;
  resource?: TopologyResource;
  relation?: TopologyRelation;
  initialTab?: "overview" | "configuration" | "scaling";
  disabled: boolean;
  busy: boolean;
  hasPendingChanges: boolean;
  onMinimize: () => void;
  onClose: () => void;
  onNavigate: (href: string) => void;
  onSave: (service: Service, patch: Partial<ServiceInput>) => Promise<void>;
  onResources: (
    values: { cpuCores: number; memoryMb: number },
    before: ProjectResources,
    service?: Service,
  ) => void;
  onPlacement: (intent: "copy" | "move", service?: Service) => void;
  onLifecycle: (service: Service, action: "start" | "stop" | "restart") => void;
  onDeploy: (intent: DeploymentIntent, serviceId?: string) => void;
  onRemoveRelation: (relation: TopologyRelation) => void;
  onSelectRelation: (id: string) => void;
}) {
  const [tab, setTab] = useState(initialTab);
  const [savedNotice, setSavedNotice] = useState(false);
  const service = resource?.service;
  const editable = resource && ["application", "service", "instance"].includes(resource.kind);
  const serviceHref =
    service && !resource?.isNew ? `/projects/${project.id}/services/${service.id}` : null;
  const sourceHref =
    resource?.kind === "linked"
      ? `/projects/${resource.projectId}/${resource.serviceId ? `services/${resource.serviceId}` : "topology"}`
      : null;
  const relations = resource
    ? graph.edges.filter((edge) => edge.source === resource.id || edge.target === resource.id)
    : [];
  const canRefresh =
    !!project.activeDeploymentId &&
    (service
      ? true
      : resolveWorkload(project.options?.workloadType, project.options?.hasServer) !== "static" &&
        project.deployTarget !== "cloud");
  const lifecycleDisabled = disabled || busy || hasPendingChanges;
  return (
    <aside className="topology-inspector flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-border/50 px-4 py-3">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-muted/50 text-muted-foreground">
          {resource ? <TopologyResourceIcon resource={resource} /> : <Unplug className="size-4" />}
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-sm font-semibold">{resource?.name || "Connection"}</h2>
          <p className="mt-0.5 truncate text-[11px] text-muted-foreground">
            {resource?.description || relation?.label}
          </p>
        </div>
        <Button variant="ghost" size="icon" aria-label="Minimize settings" onClick={onMinimize}>
          <ChevronUp />
        </Button>
        <Button variant="ghost" size="icon" aria-label="Close settings" onClick={onClose}>
          <X />
        </Button>
      </div>
      {editable && (
        <div
          role="tablist"
          aria-label="Service options"
          className="flex shrink-0 gap-1 border-b border-border/50 px-3 py-2"
        >
          {(["overview", "configuration", "scaling"] as const).map((item) => (
            <button
              key={item}
              type="button"
              role="tab"
              aria-selected={tab === item}
              className={`flex-1 rounded-lg px-2 py-2 text-xs capitalize ${tab === item ? "bg-muted/60 font-medium text-foreground" : "text-muted-foreground hover:bg-muted/30"}`}
              onClick={() => setTab(item)}
            >
              {item}
            </button>
          ))}
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {relation && (
          <div className="space-y-5">
            <div className="-mx-4">
              <RelationPreview relation={relation} graph={graph} />
            </div>
            <p className="text-xs leading-relaxed text-muted-foreground">{relation.description}</p>
            <dl className="grid gap-4 rounded-xl border border-border/50 bg-muted/20 p-3">
              <Detail
                label="Connection type"
                value={
                  relation.kind === "binding"
                    ? "Environment binding"
                    : relation.kind === "route"
                      ? "Public route"
                      : "Startup dependency"
                }
              />
              {relation.connection && (
                <>
                  <Detail label="Environment variable" value={relation.connection.envKey} />
                  <Detail
                    label="Network"
                    value={relation.connection.mode === "internal" ? "Private" : "Public"}
                  />
                  <Detail label="Scope" value="Whole environment" />
                </>
              )}
              {relation.kind === "dependency" && (
                <Detail label="Scope" value="Only the selected service" />
              )}
            </dl>
            {relation.kind === "route" ? (
              <Button
                className="w-full"
                variant="outline"
                onClick={() => onNavigate(`/projects/${project.id}/domains`)}
              >
                <Settings2 />
                Manage route
              </Button>
            ) : (
              <Button
                className="w-full text-danger"
                variant="outline"
                disabled={disabled || relation.pending}
                onClick={() => onRemoveRelation(relation)}
              >
                <Unplug />
                {relation.pending ? "Removal staged" : "Remove connection"}
              </Button>
            )}
            {relation.kind === "dependency" && relation.serviceId && (
              <Button
                className="w-full"
                variant="ghost"
                onClick={() =>
                  onNavigate(`/projects/${project.id}/services/${relation.serviceId}/env`)
                }
              >
                <KeyRound />
                Environment variables
              </Button>
            )}
          </div>
        )}
        {resource && (!editable || tab === "overview") && (
          <div className="space-y-5">
            <div className="rounded-xl border border-border/50 bg-muted/20 p-3">
              {resource.kind === "application" &&
              resource.version &&
              resource.state !== "disabled" ? (
                <p className="text-xs">Deployed {resource.version}</p>
              ) : (
                <TopologyStatus state={resource.pending ? "pending" : resource.state} />
              )}
              {resource.pending && (
                <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
                  Review and apply to save this configuration and deploy it.
                </p>
              )}
              {resource.container?.duplicates?.length ? (
                <p className="mt-2 text-[11px] leading-relaxed text-warning">
                  {resource.container.duplicates.length} additional container(s) need attention.
                  They are not managed replicas.
                </p>
              ) : null}
            </div>
            <dl className="grid gap-4">
              <Detail label="Running image" value={resource.container?.imageRef} />
              {!resource.container?.imageRef && (
                <Detail label="Configured image" value={service?.image} />
              )}
              <Detail label="Container" value={resource.container?.containerId} />
              <Detail label="Private address" value={resource.container?.ip} />
              <Detail
                label="Server"
                value={
                  resource.kind === "linked"
                    ? undefined
                    : project.serverName ||
                      (project.deployTarget === "cloud"
                        ? "OpenShip Cloud"
                        : project.deployTarget === "local"
                          ? "Local machine"
                          : project.serverId
                            ? "Connected server"
                            : "Not selected")
                }
              />
              <Detail label="Ports" value={service?.ports?.join(", ")} />
              <Detail label="Managed by" value={resource.ownerName} />
            </dl>
            {sourceHref && (
              <Button variant="outline" className="w-full" onClick={() => onNavigate(sourceHref)}>
                <ArrowUpRight />
                Open owning project
              </Button>
            )}
            {resource.kind === "edge" && (
              <Button
                className="w-full"
                variant="outline"
                onClick={() => onNavigate(`/projects/${project.id}/domains`)}
              >
                Manage domains & routes
                <ArrowUpRight />
              </Button>
            )}
            {resource.kind === "environment" && (
              <p className="text-xs leading-relaxed text-muted-foreground">
                These linked services provide variables to this environment. Open a connection to
                review its network and remove it.
              </p>
            )}
            {service && !resource.pending && (
              <div className="grid grid-cols-2 gap-2">
                {resource.container?.containerId &&
                !["stopped", "failed"].includes(resource.state) ? (
                  <>
                    <Button
                      variant="outline"
                      disabled={lifecycleDisabled}
                      onClick={() => onLifecycle(service, "restart")}
                    >
                      <RotateCw />
                      Restart
                    </Button>
                    <Button
                      variant="outline"
                      disabled={lifecycleDisabled}
                      onClick={() => onLifecycle(service, "stop")}
                    >
                      <Square />
                      Stop
                    </Button>
                  </>
                ) : (
                  <Button
                    className="col-span-2"
                    variant="outline"
                    disabled={
                      lifecycleDisabled ||
                      !project.activeDeploymentId ||
                      !serviceCanStartWithoutBuild(service)
                    }
                    onClick={() => onLifecycle(service, "start")}
                  >
                    <Play />
                    Start service
                  </Button>
                )}
                <Button
                  variant="outline"
                  disabled={disabled}
                  onClick={() => onNavigate(`${serviceHref}/logs`)}
                >
                  <FileText />
                  Logs
                </Button>
                <Button
                  variant="outline"
                  disabled={disabled}
                  onClick={() => onNavigate(`${serviceHref}/env`)}
                >
                  <KeyRound />
                  Variables
                </Button>
              </div>
            )}
            {editable && !resource.pending && service?.enabled !== false && (
              <div className="space-y-2 border-t border-border/50 pt-4">
                {canRefresh && (
                  <Button
                    className="w-full"
                    variant="outline"
                    disabled={disabled || busy}
                    onClick={() => onDeploy("refresh", service?.id)}
                  >
                    <RotateCw />
                    Redeploy current release
                  </Button>
                )}
                <Button
                  className="w-full"
                  variant="outline"
                  disabled={disabled || busy}
                  onClick={() => onDeploy("update", service?.id)}
                >
                  <ArrowUpRight />
                  Deploy latest source
                </Button>
              </div>
            )}
            {relations.length > 0 && (
              <section className="space-y-2 border-t border-border/50 pt-4">
                <h3 className="text-xs font-medium">Connections</h3>
                {relations.map((edge) => (
                  <button
                    key={edge.id}
                    className="flex w-full items-center justify-between rounded-lg bg-muted/30 p-2.5 text-start text-xs hover:bg-muted/50"
                    onClick={() => onSelectRelation(edge.id)}
                  >
                    <span className="truncate">{edge.label}</span>
                    <ArrowUpRight className="size-3.5 shrink-0 text-muted-foreground" />
                  </button>
                ))}
              </section>
            )}
          </div>
        )}
        {resource && editable && tab === "configuration" && (
          <div className="space-y-4">
            {service ? (
              <>
                <p className="text-xs leading-relaxed text-muted-foreground">
                  Changes stay pending until you review and apply them.
                </p>
                <fieldset
                  disabled={disabled}
                  className="topology-service-form min-w-0 disabled:opacity-60"
                >
                  <ServiceConfiguration
                    key={service.id}
                    service={service}
                    siblings={graph.nodes.flatMap((node) =>
                      node.service && node.service.id !== service.id ? [node.service.name] : [],
                    )}
                    onSave={async (baseline, patch) => {
                      await onSave(baseline, patch);
                      setSavedNotice(true);
                    }}
                  />
                </fieldset>
                {savedNotice && (
                  <p role="status" className="text-xs text-success">
                    Configuration added to pending changes.
                  </p>
                )}
              </>
            ) : (
              <>
                <p className="text-xs leading-relaxed text-muted-foreground">
                  Build settings, variables, domains, and logs use this project’s existing
                  configuration.
                </p>
                {[
                  { label: "Build & runtime", path: "runtime" },
                  { label: "Domains & routes", path: "domains" },
                  { label: "Runtime logs", path: "logs" },
                ].map((item) => (
                  <Button
                    key={item.path}
                    className="w-full justify-between"
                    variant="outline"
                    onClick={() => onNavigate(`/projects/${project.id}/${item.path}`)}
                  >
                    {item.label}
                    <ArrowUpRight />
                  </Button>
                ))}
              </>
            )}
          </div>
        )}
        {resource && editable && tab === "scaling" && (
          <TopologyScaling
            project={project}
            service={service}
            disabled={disabled}
            placementDisabled={hasPendingChanges}
            onStage={onResources}
            onPlacement={onPlacement}
          />
        )}
      </div>
    </aside>
  );
}
