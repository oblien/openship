"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import type { Connection } from "@xyflow/react";
import {
  ArrowLeft,
  ArrowRightLeft,
  Boxes,
  Check,
  ChevronRight,
  List,
  Loader2,
  Plus,
  RefreshCw,
  Rocket,
  Unplug,
} from "lucide-react";
import { resolveWorkload, type ProjectResources } from "@repo/core";
import { useProjectSettings } from "@/context/ProjectSettingsContext";
import { useToast } from "@/context/ToastContext";
import { useModal } from "@/context/ModalContext";
import { useCloudDeployPricing } from "@/hooks/useCloudDeployPricing";
import { Button, buttonVariants } from "@/components/ui/button";
import DropdownMenu, { type MenuAction } from "@/components/ui/DropdownMenu";
import { useI18n, interpolate } from "@/components/i18n-provider";
import { ScaleDetailsPanel } from "@/components/scale/ScaleDetailsPanel";
import { AddServiceModal } from "@/app/(dashboard)/projects/[id]/components/services/AddServiceModal";
import { environmentWizardHref } from "@/app/(dashboard)/projects/[id]/components/environment-next";
import {
  deployApi,
  getApiErrorCode,
  getApiErrorMessage,
  projectsApi,
  servicesApi,
  type Service,
  type ServiceInput,
} from "@/lib/api";
import { CONNECTIONS_CHANGED, connectionsApi } from "@/lib/api/connections";
import { invalidateProjectCaches } from "@/hooks/useProjectEndpoints";
import { openTriggeredBuild } from "@/lib/deploy-nav";
import { randomUUID } from "@/lib/random-uuid";
import {
  buildProjectTopology,
  dependencyProblem,
  hasSeparateApplication,
  serviceNodeId,
  type ProjectTopologyGraph,
  type TopologyProject,
  type TopologyRelation,
} from "./model";
import {
  applyTopologyChanges,
  canRefreshChanges,
  canRefreshServicePatch,
  changesAffectEnvironment,
  serviceFromInput,
  stageServiceChange,
  type DeploymentIntent,
  type TopologyChange,
} from "./changes";
import { TopologyCanvas, TopologyResourceIcon, type TopologySelection } from "./TopologyCanvas";
import { RelationPreview, TopologyInspector } from "./TopologyInspector";
import { TopologyReview } from "./TopologyReview";
import { TopologyPlacement } from "./TopologyPlacement";
import { useTopologyData } from "./useTopologyData";
import "@/components/scale/scale.css";
import "./topology.css";

function mergeAdvanced(service: Service, patch: Partial<ServiceInput>): Service {
  const advanced = { ...service.advanced, ...patch.advanced } as Record<string, unknown>;
  for (const key of Object.keys(advanced)) if (advanced[key] === null) delete advanced[key];
  return { ...service, ...patch, advanced } as Service;
}

/** Environment identity is also the React key, so drafts never cross projects. */
export default function ProjectTopology({
  environmentControl,
  onPendingChange,
}: {
  environmentControl: ReactNode;
  onPendingChange: (pending: boolean) => void;
}) {
  const { id, projectData, servicesData, refreshServices } = useProjectSettings();
  const { t } = useI18n();
  const project: TopologyProject = projectData;
  const router = useRouter();
  const { showToast } = useToast();
  const { showModal, hideModal } = useModal();
  const showCloudPricing = useCloudDeployPricing();
  const runtime = useTopologyData(id, refreshServices, !!project.activeDeploymentId);
  const [changes, setChanges] = useState<TopologyChange[]>([]);
  const [selection, setSelection] = useState<TopologySelection>(null);
  const [expanded, setExpanded] = useState(false);
  const [initialTab, setInitialTab] = useState<"overview" | "configuration" | "scaling">(
    "overview",
  );
  const [instanceServiceId, setInstanceServiceId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const [reviewServiceId, setReviewServiceId] = useState<string | undefined>();
  const [intent, setIntent] = useState<DeploymentIntent>("refresh");
  const [applying, setApplying] = useState(false);
  const [applyError, setApplyError] = useState<string | null>(null);
  const [lifecycleBusy, setLifecycleBusy] = useState(false);
  const [placement, setPlacement] = useState<{
    intent: "copy" | "move";
    service?: Service;
    runId?: string;
  } | null>(null);
  const applyingRef = useRef(false);
  const changesRef = useRef(changes);
  changesRef.current = changes;
  const activeMigration = projectData.activeMigration;
  const deploymentBusy = ["queued", "building", "deploying", "reconciling"].includes(
    project.latestDeploymentStatus ?? "",
  );
  const busy = applying || lifecycleBusy || deploymentBusy || !!activeMigration;
  const hasSavedChanges = changes.some((change) => change.saved);

  useEffect(() => {
    onPendingChange(changes.length > 0 || applying);
    return () => onPendingChange(false);
  }, [changes.length, applying, onPendingChange]);
  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (changesRef.current.length || applyingRef.current) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    const connectionChanged = () => {
      if (applyingRef.current) return;
      setChanges((current) => [
        ...current.filter((change) => change.id !== "connections"),
        {
          id: "connections",
          kind: "connections-saved",
          title: "Apply shared connections",
          saved: true,
        },
      ]);
    };
    window.addEventListener("beforeunload", beforeUnload);
    window.addEventListener(CONNECTIONS_CHANGED, connectionChanged);
    return () => {
      window.removeEventListener("beforeunload", beforeUnload);
      window.removeEventListener(CONNECTIONS_CHANGED, connectionChanged);
    };
  }, []);

  const previewServices = useMemo(() => {
    const services = servicesData.services.map((service) => {
      const update = changes.find(
        (change): change is Extract<TopologyChange, { kind: "update-service" }> =>
          change.kind === "update-service" && change.serviceId === service.id && !change.saved,
      );
      return update ? mergeAdvanced(service, update.patch) : service;
    });
    for (const change of changes) {
      if (change.kind === "create-service" && !change.saved)
        services.push(serviceFromInput(change.id, change.input));
    }
    return services;
  }, [servicesData.services, changes]);

  const fullGraph = useMemo(() => {
    const graph = buildProjectTopology({
      project,
      services: previewServices,
      containers: runtime.containers,
      connections: runtime.connections,
    });
    for (const node of graph.nodes) {
      node.isNew = changes.some(
        (change) =>
          change.kind === "create-service" && !change.saved && change.id === node.serviceId,
      );
      node.pending = changes.some(
        (change) =>
          !change.saved &&
          ((change.kind === "create-service" && change.id === node.serviceId) ||
            (change.kind === "update-service" && change.serviceId === node.serviceId) ||
            (change.kind === "resources" && node.kind === "application")),
      );
    }
    for (const edge of graph.edges) {
      edge.pending = changes.some(
        (change) =>
          !change.saved &&
          change.kind === "remove-binding" &&
          change.connectionId === edge.connection?.id,
      );
    }
    return graph;
  }, [project, previewServices, runtime.containers, runtime.connections, changes]);

  const instanceService = fullGraph.nodes.find(
    (node) => node.serviceId === instanceServiceId && node.kind === "service",
  );
  const graph = useMemo<ProjectTopologyGraph>(() => {
    if (!instanceServiceId) return fullGraph;
    if (!instanceService?.container?.containerId) return { nodes: [], edges: [] };
    return {
      nodes: [
        {
          ...instanceService,
          id: `instance:${instanceService.serviceId}`,
          kind: "instance",
          description: "Runtime instance",
        },
      ],
      edges: [],
    };
  }, [fullGraph, instanceService, instanceServiceId]);
  const resource =
    selection?.kind === "node" ? graph.nodes.find((node) => node.id === selection.id) : undefined;
  const relation =
    selection?.kind === "edge" ? graph.edges.find((edge) => edge.id === selection.id) : undefined;
  const hasSelection = !!resource || !!relation;
  const inspectorExpanded = hasSelection && expanded;
  const currentService = reviewServiceId
    ? servicesData.services.find((service) => service.id === reviewServiceId)
    : undefined;
  const serviceChangesOnly =
    changes.length > 0 && changes.every((change) => change.kind === "update-service");
  const environmentCanRefresh =
    !hasSeparateApplication(project, servicesData.services) ||
    (project.deployTarget !== "cloud" &&
      resolveWorkload(project.options?.workloadType, project.options?.hasServer) !== "static");
  const targetCanRefresh =
    !!project.activeDeploymentId &&
    (!!currentService || serviceChangesOnly || environmentCanRefresh);
  const reviewBlocked = activeMigration
    ? "Finish the active migration before deploying."
    : deploymentBusy
      ? "A deployment is already in progress."
      : lifecycleBusy
        ? "Wait for the current service operation to finish."
        : undefined;

  const select = useCallback((next: TopologySelection) => {
    setSelection(next);
    setExpanded(false);
    setInitialTab("overview");
  }, []);
  const back = useCallback(() => {
    setInstanceServiceId(null);
    setSelection(null);
    setExpanded(false);
  }, []);
  const openNode = useCallback(
    (nodeId: string) => {
      const node = graph.nodes.find((item) => item.id === nodeId);
      if (node?.kind === "service" && node.container?.containerId && !node.pending) {
        setInstanceServiceId(node.serviceId!);
        setSelection(null);
        setExpanded(false);
      } else {
        setSelection({ kind: "node", id: nodeId });
        setInitialTab("configuration");
        setExpanded(true);
      }
    },
    [graph.nodes],
  );

  const navigate = useCallback(
    (href: string) => {
      if (applyingRef.current) return;
      if (!changesRef.current.length) {
        router.push(href);
        return;
      }
      const saved = changesRef.current.some((change) => change.saved);
      const modalId = showModal({
        title: "Leave topology?",
        maxWidth: "440px",
        message: saved
          ? "Some configuration is saved but still needs deployment. Unsaved edits will be discarded."
          : "Your pending topology changes have not been applied.",
        buttons: [
          { label: "Keep editing", variant: "secondary", onClick: () => hideModal(modalId) },
          {
            label: "Leave",
            variant: "primary",
            onClick: () => {
              hideModal(modalId);
              setChanges([]);
              router.push(href);
            },
          },
        ],
      });
    },
    [router, showModal, hideModal],
  );

  // Next links elsewhere in the dashboard need the same pending-edit guard.
  useEffect(() => {
    const onLink = (event: MouseEvent) => {
      if (
        !changesRef.current.length ||
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey
      )
        return;
      const link = (event.target as Element | null)?.closest<HTMLAnchorElement>("a[href]");
      if (!link || link.target === "_blank" || link.hasAttribute("download")) return;
      const url = new URL(link.href, window.location.href);
      if (
        url.origin !== window.location.origin ||
        url.href === window.location.href ||
        (url.pathname === window.location.pathname && url.hash)
      )
        return;
      event.preventDefault();
      event.stopPropagation();
      navigate(`${url.pathname}${url.search}${url.hash}`);
    };
    document.addEventListener("click", onLink, true);
    return () => document.removeEventListener("click", onLink, true);
  }, [navigate]);

  const stagePatch = useCallback(
    async (service: Service, patch: Partial<ServiceInput>) => {
      if (busy || hasSavedChanges)
        throw new Error("Finish the current operation before editing configuration.");
      const pending = changes.find(
        (change) => change.kind === "create-service" && change.id === service.id,
      );
      if (!pending && !servicesData.services.some((item) => item.id === service.id))
        throw new Error("This service no longer exists. Refresh the topology.");
      setChanges((current) =>
        stageServiceChange(current, service, patch, canRefreshServicePatch(service, patch)),
      );
    },
    [busy, hasSavedChanges, changes, servicesData.services],
  );

  const connect = useCallback(
    (connection: Connection) => {
      if (busy || hasSavedChanges || !connection.source || !connection.target) return;
      const source = graph.nodes.find((node) => node.id === connection.source)?.service;
      const target = graph.nodes.find((node) => node.id === connection.target)?.service;
      const problem = dependencyProblem(previewServices, source?.id ?? "", target?.id ?? "");
      if (problem || !source || !target) {
        showToast(problem || "Choose two services.", "error");
        return;
      }
      setChanges((current) =>
        stageServiceChange(
          current,
          source,
          { dependsOn: [...(source.dependsOn ?? []), target.name] },
          true,
        ),
      );
      setSelection({ kind: "edge", id: `dependency:${source.id}:${target.id}` });
      setExpanded(false);
      showToast(`Startup dependency staged for ${source.name}.`, "success");
    },
    [busy, hasSavedChanges, graph.nodes, previewServices, showToast],
  );

  const removeRelation = useCallback(
    (edge: TopologyRelation) => {
      if (busy || hasSavedChanges) return;
      if (edge.kind === "binding" && edge.connection) {
        setChanges((current) => [
          ...current.filter((change) => change.id !== `remove:${edge.connection!.id}`),
          {
            id: `remove:${edge.connection!.id}`,
            kind: "remove-binding",
            connectionId: edge.connection!.id,
            title: `Disconnect ${edge.connection!.envKey}`,
          },
        ]);
      } else if (edge.kind === "dependency") {
        const source = previewServices.find((service) => service.id === edge.serviceId);
        if (!source) return;
        setChanges((current) =>
          stageServiceChange(
            current,
            source,
            { dependsOn: (source.dependsOn ?? []).filter((name) => name !== edge.dependencyName) },
            true,
          ),
        );
        setSelection(null);
        setExpanded(false);
      }
    },
    [busy, hasSavedChanges, previewServices],
  );

  const review = (requested?: DeploymentIntent, serviceId?: string) => {
    setApplyError(null);
    const target = changes.length ? undefined : serviceId;
    setReviewServiceId(target);
    const canReuse =
      !!project.activeDeploymentId &&
      canRefreshChanges(changes) &&
      (!!target || serviceChangesOnly || environmentCanRefresh);
    setIntent(requested === "update" || !canReuse ? "update" : "refresh");
    setReviewing(true);
  };
  const apply = async () => {
    if (applyingRef.current || busy) return;
    applyingRef.current = true;
    setApplying(true);
    setApplyError(null);
    try {
      const result = await applyTopologyChanges({
        changes: changesRef.current,
        intent,
        deployed: !!project.activeDeploymentId,
        serviceIds: reviewServiceId ? [reviewServiceId] : undefined,
        onSaved: (saved) =>
          setChanges((current) =>
            current.map((change) => (change.id === saved.id ? saved : change)),
          ),
        ports: {
          listServices: async () => {
            const response = await servicesApi.list(id);
            if (!response.success) throw new Error("Services could not be loaded.");
            return response.services;
          },
          createService: async (input) => {
            const response = await servicesApi.create(id, input);
            if (!response.success || !response.service?.id)
              throw new Error("The service could not be created.");
            return response.service;
          },
          startService: async (serviceId) => {
            const response = await servicesApi.start(id, serviceId);
            if (!response.success) throw new Error("The service could not be started.");
          },
          updateService: async (serviceId, patch) => {
            const response = await servicesApi.update(id, serviceId, patch);
            if (!response.success) throw new Error("Service configuration could not be saved.");
          },
          readResources: async () => (await projectsApi.getResources(id)).data,
          updateResources: async (values) => {
            await projectsApi.updateResources(id, { production: { tier: "custom", ...values } });
          },
          removeBinding: async (connectionId) => {
            await connectionsApi.remove(id, connectionId);
          },
          deploy: async (input) => {
            const response = await deployApi.trigger({ projectId: id, ...input });
            if (response?.success === false)
              throw new Error(response?.error || "Deployment could not be started.");
            return response;
          },
        },
      });
      invalidateProjectCaches(id);
      void refreshServices();
      if (result.needsSetup) router.push(environmentWizardHref({ id }));
      else if (result.startedServices?.length) {
        await runtime.refresh();
        setSelection({ kind: "node", id: serviceNodeId(result.startedServices[0]) });
        setInitialTab("overview");
        setExpanded(true);
        showToast("Services started.", "success");
      } else openTriggeredBuild(router, result.deployment, id);
      setChanges([]);
      setReviewing(false);
    } catch (error) {
      if (!showCloudPricing(error)) setApplyError(getApiErrorMessage(error, "Changes could not be applied."));
      invalidateProjectCaches(id);
      void runtime.refresh();
    } finally {
      applyingRef.current = false;
      setApplying(false);
    }
  };

  const lifecycle = async (service: Service, action: "start" | "stop" | "restart") => {
    if (busy || changes.length) return;
    setLifecycleBusy(true);
    try {
      const response = await servicesApi[action](id, service.id);
      if (!response.success) throw new Error("The service action failed.");
      await runtime.refresh();
      invalidateProjectCaches(id);
      showToast(
        `${service.name}: ${action === "stop" ? "stopped" : action === "restart" ? "restarted" : "started"}.`,
        "success",
      );
    } catch (error) {
      if (action === "restart" && getApiErrorCode(error) === "SERVICE_CONFIG_STALE") {
        showToast(interpolate(t.projectDetail.services.detail.environmentApply.restartBlocked, { name: service.name }), "info", service.name);
        router.push(`/projects/${id}/services/${service.id}/env`);
        return;
      }
      if (action === "stop" || !showCloudPricing(error)) showToast(getApiErrorMessage(error, "The service action failed."), "error");
    } finally {
      setLifecycleBusy(false);
    }
  };

  const stageResources = (
    values: { cpuCores: number; memoryMb: number },
    before: ProjectResources,
    service?: Service,
  ) => {
    if (busy || hasSavedChanges) return;
    if (service) {
      setChanges((current) =>
        stageServiceChange(current, service, { advanced: { resources: values } }, true),
      );
    } else
      setChanges((current) => {
        const previous = current.find((change) => change.kind === "resources");
        return [
          ...current.filter((change) => change.kind !== "resources"),
          {
            id: "resources",
            kind: "resources",
            title: "Resize environment defaults",
            before: previous?.kind === "resources" ? previous.before : before.production,
            values,
          },
        ];
      });
  };

  const openPlacement = (placementIntent: "copy" | "move", service?: Service) => {
    if (
      busy ||
      changes.length ||
      project.deployTarget !== "server" ||
      !project.serverId ||
      project.appTemplateId === "openship"
    )
      return;
    setPlacement({
      intent: placementIntent,
      service: placementIntent === "copy" ? service : undefined,
    });
  };
  const issues = [...(servicesData.error ? [servicesData.error] : []), ...runtime.errors];
  const serviceCount = fullGraph.nodes.filter(
    (node) => ["service", "application"].includes(node.kind) && !node.isNew,
  ).length;
  const panelSummary = resource?.pending
    ? "Pending changes · Configure"
    : resource?.kind === "application" && resource.version
      ? `${resource.version} · Configuration & scaling`
      : `${resource?.description ?? ""} · Settings`;
  const reviewScopeName =
    currentService?.name ||
    (!changesAffectEnvironment(changes) &&
    changes.length &&
    changes.every((change) => change.kind === "update-service")
      ? changes.length === 1
        ? changes[0].kind === "update-service"
          ? changes[0].before.name
          : undefined
        : `${changes.length} services`
      : undefined);
  const topologyActions: MenuAction[] = [
    {
      id: "services",
      label: t.projects.sidebar.tabs.services,
      icon: <List className="size-4" />,
      onClick: () => navigate(`/projects/${id}/services`),
    },
    {
      id: "deployments",
      label: t.projects.sidebar.tabs.deployments,
      icon: <Rocket className="size-4" />,
      onClick: () => navigate(`/projects/${id}/deployments`),
    },
  ];
  if (
    !instanceServiceId &&
    project.deployTarget === "server" &&
    project.serverId &&
    project.activeDeploymentId &&
    project.appTemplateId !== "openship"
  ) {
    topologyActions.push({
      id: "placement",
      label: "Clone or move environment",
      icon: <ArrowRightLeft className="size-4" />,
      disabled: busy || changes.length > 0,
      onClick: () => openPlacement("copy"),
    });
  }

  return (
    <div className="topology-page flex h-full min-h-[540px] w-full flex-col p-3 text-foreground sm:p-4">
      <section
        className="flex min-h-0 flex-1 flex-col rounded-2xl border border-border/50 bg-background"
        aria-label="Project topology workspace"
      >
        <header className="topology-page-header relative z-30 flex shrink-0 flex-wrap items-center justify-between gap-x-4 gap-y-3 rounded-t-2xl border-b border-border/50 px-3 py-3 sm:px-4">
          <div className="flex min-w-0 flex-1 basis-60 items-center gap-2">
            <Button
              variant="ghost"
              size="icon"
              className="shrink-0"
              title={instanceServiceId ? "Back to overview" : "Back to project"}
              aria-label={instanceServiceId ? "Back to overview" : "Back to project"}
              onClick={instanceServiceId ? back : () => navigate(`/projects/${id}/overview`)}
              disabled={!!instanceServiceId && inspectorExpanded}
            >
              <ArrowLeft className="rtl:rotate-180" />
            </Button>
            <div className="min-w-0 flex-1">
              <div className="flex min-w-0 items-center gap-1.5">
                <span className="min-w-0 truncate text-sm text-muted-foreground">
                  {instanceServiceId
                    ? t.projects.sidebar.tabs.topology
                    : projectData.name || t.projects.detail.projectFallback}
                </span>
                <ChevronRight className="size-3.5 shrink-0 text-muted-foreground/60 rtl:rotate-180" />
                <h1 className="max-w-[60%] shrink-0 truncate text-base font-semibold text-foreground">
                  {instanceService?.name || t.projects.sidebar.tabs.topology}
                </h1>
              </div>
              <p className="topology-summary truncate text-[13px] leading-5 text-muted-foreground">
                {instanceServiceId
                  ? "Runtime instances"
                  : `${serviceCount} service${serviceCount === 1 ? "" : "s"} · ${runtime.connections.length} shared connection${runtime.connections.length === 1 ? "" : "s"}`}
              </p>
            </div>
          </div>
          <div
            className={`topology-toolbar flex min-w-0 flex-wrap items-center gap-2 transition-opacity ${inspectorExpanded ? "opacity-50" : ""}`}
            inert={inspectorExpanded}
          >
            <div className="topology-environment min-w-0">{environmentControl}</div>
            <div className="topology-actions flex shrink-0 items-center gap-1.5">
              <Button
                variant="ghost"
                size="icon"
                className="shrink-0"
                title="Refresh topology"
                aria-label="Refresh topology"
                disabled={runtime.loading}
                onClick={() => {
                  invalidateProjectCaches(id);
                  void runtime.refresh();
                }}
              >
                <RefreshCw className={runtime.loading ? "animate-spin" : ""} />
              </Button>
              {!instanceServiceId && (
                <Button
                  className="topology-add-service h-9 px-3"
                  disabled={busy || hasSavedChanges || !!servicesData.error}
                  onClick={() => setAdding(true)}
                >
                  <Plus />
                  Add service
                </Button>
              )}
              <DropdownMenu
                actions={topologyActions}
                triggerLabel="Topology actions"
                triggerClassName={buttonVariants({ variant: "ghost", size: "icon" })}
              />
            </div>
          </div>
        </header>
        <div
          className="scale-workspace topology-workspace relative isolate flex-1 overflow-hidden rounded-b-2xl"
          data-inspector={hasSelection ? (expanded ? "expanded" : "minimized") : undefined}
        >
          <div className="absolute inset-0">
            {runtime.ready ? (
              <TopologyCanvas
                key={instanceServiceId ?? "overview"}
                layoutKey={`openship:topology-layout:v1:${id}:${instanceServiceId ?? "overview"}`}
                graph={graph}
                selection={selection}
                inert={inspectorExpanded}
                onSelect={select}
                onOpen={openNode}
                onConnect={connect}
              />
            ) : (
              <div
                role="status"
                className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground"
              >
                <Loader2 className="size-4 animate-spin" />
                Loading services & connections…
              </div>
            )}
          </div>
          {issues.length > 0 && (
            <div
              className="topology-notice absolute start-4 z-20 max-w-[min(500px,calc(100%-32px))] rounded-xl border border-warning/25 bg-card px-3 py-2 text-xs text-warning"
              role="alert"
              inert={inspectorExpanded}
            >
              {issues.join(" ")}
              <button className="ms-2 underline" onClick={() => void runtime.refresh()}>
                Retry
              </button>
            </div>
          )}
          {activeMigration && (
            <div
              className="absolute bottom-20 start-4 z-20 rounded-xl border border-border/60 bg-card p-3 text-xs"
              inert={inspectorExpanded}
            >
              A migration is active.
              <Button
                variant="link"
                size="sm"
                onClick={() => setPlacement({ intent: "move", runId: activeMigration.id })}
              >
                Open migration
              </Button>
            </div>
          )}
          {runtime.ready &&
            !graph.nodes.length &&
            !servicesData.isLoading &&
            !servicesData.error && (
              <div className="pointer-events-none absolute inset-0 flex items-center justify-center p-6">
                <div className="pointer-events-auto max-w-sm rounded-2xl border border-border/50 bg-card p-6 text-center">
                  <Boxes className="mx-auto mb-3 size-8 text-muted-foreground" />
                  <h2 className="text-sm font-semibold">
                    {instanceServiceId ? "No runtime instance found" : "Build this environment"}
                  </h2>
                  <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                    {instanceServiceId
                      ? "Refresh to check the host, or return to the overview to manage this service."
                      : "Add a service or link an existing database. Review the configuration before deploying."}
                  </p>
                  {!instanceServiceId && (
                    <Button
                      className="mt-4"
                      size="sm"
                      disabled={busy}
                      onClick={() => setAdding(true)}
                    >
                      <Plus />
                      Add service
                    </Button>
                  )}
                </div>
              </div>
            )}
          {changes.length > 0 ? (
            <div
              className="topology-pending absolute bottom-4 end-4 z-30 flex items-center gap-3 rounded-2xl border border-primary/25 bg-card p-2.5"
              inert={inspectorExpanded}
            >
              <span className="ms-1 flex items-center gap-2 text-xs">
                <span className="size-2 rounded-full bg-warning" />
                {changes.length} pending change{changes.length === 1 ? "" : "s"}
              </span>
              <Button
                variant="ghost"
                size="sm"
                disabled={applying || hasSavedChanges}
                onClick={() => {
                  setChanges([]);
                  select(null);
                }}
              >
                Discard
              </Button>
              <Button size="sm" disabled={busy || issues.length > 0} onClick={() => review()}>
                <Check />
                Review & apply
              </Button>
            </div>
          ) : (
            <div
              className="topology-hint absolute bottom-5 end-5 z-10 text-[11px] text-muted-foreground"
              inert={inspectorExpanded}
            >
              {deploymentBusy
                ? "Deployment in progress"
                : "Drag between services to set startup order"}
            </div>
          )}
          <button
            className="scale-inspector-backdrop"
            data-open={inspectorExpanded}
            tabIndex={inspectorExpanded ? 0 : -1}
            aria-label="Minimize settings to return to topology"
            aria-hidden={!inspectorExpanded}
            onClick={() => setExpanded(false)}
          />
          {hasSelection && (
            <ScaleDetailsPanel
              key={`${selection!.kind}:${selection!.id}`}
              title={resource?.name || "Connection"}
              summary={panelSummary}
              kind={resource?.tone ?? "service"}
              icon={
                resource ? (
                  <TopologyResourceIcon resource={resource} />
                ) : (
                  <Unplug className="size-4" />
                )
              }
              open={expanded}
              onOpen={() => setExpanded(true)}
              onMinimize={() => setExpanded(false)}
              onClose={() => select(null)}
              onBack={instanceServiceId ? back : undefined}
              connectionPreview={
                relation
                  ? {
                      content: <RelationPreview relation={relation} graph={graph} />,
                      description:
                        relation.kind === "binding"
                          ? "Environment binding"
                          : relation.kind === "dependency"
                            ? "Startup dependency"
                            : "Public route",
                      onRemove:
                        relation.kind !== "route" && !busy && !hasSavedChanges && !relation.pending
                          ? () => removeRelation(relation)
                          : undefined,
                    }
                  : undefined
              }
            >
              <TopologyInspector
                project={project}
                graph={fullGraph}
                resource={resource}
                relation={relation}
                initialTab={initialTab}
                disabled={busy || hasSavedChanges}
                busy={lifecycleBusy}
                hasPendingChanges={changes.length > 0}
                onMinimize={() => setExpanded(false)}
                onClose={() => select(null)}
                onNavigate={navigate}
                onSave={stagePatch}
                onResources={stageResources}
                onPlacement={openPlacement}
                onLifecycle={(service, action) => void lifecycle(service, action)}
                onDeploy={review}
                onRemoveRelation={removeRelation}
                onSelectRelation={(edgeId) => {
                  setSelection({ kind: "edge", id: edgeId });
                  setExpanded(false);
                }}
              />
            </ScaleDetailsPanel>
          )}
        </div>
      </section>
      <AddServiceModal
        open={adding}
        projectId={id}
        projectName={project.name}
        isCloudProject={project.deployTarget === "cloud"}
        onClose={() => setAdding(false)}
        onSubmit={async (input) => {
          if (busy || hasSavedChanges) throw new Error("Finish the current operation first.");
          if (previewServices.some((service) => service.name === input.name))
            throw new Error("A service with this name already exists in this environment.");
          const temporaryId = `new-${randomUUID()}`;
          setChanges((current) => [
            ...current,
            { id: temporaryId, kind: "create-service", input, title: `Add ${input.name}` },
          ]);
          setAdding(false);
          setSelection({ kind: "node", id: serviceNodeId(temporaryId) });
          setInitialTab("configuration");
          setExpanded(true);
        }}
      />
      <TopologyReview
        project={project}
        changes={changes}
        intent={intent}
        serviceName={reviewScopeName}
        canRefresh={targetCanRefresh}
        open={reviewing}
        applying={applying}
        error={applyError}
        blocked={reviewBlocked}
        onIntent={setIntent}
        onApply={() => void apply()}
        onClose={() => setReviewing(false)}
      />
      {placement && (
        <TopologyPlacement
          project={project}
          service={placement.service}
          intent={placement.intent}
          existingRunId={placement.runId}
          onClose={() => {
            setPlacement(null);
            void runtime.refresh();
          }}
        />
      )}
    </div>
  );
}
