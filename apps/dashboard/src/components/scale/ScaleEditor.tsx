"use client";

import { Icon as UiIcon } from "@repo/ui/icons";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import type { Viewport } from "@xyflow/react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/toast";
import { randomUUID } from "@/lib/random-uuid";
import ScaleCanvas from "./ScaleCanvas";
import { ScaleLoading } from "./ScaleLoading";
import { ScaleDetailsPanel } from "./ScaleDetailsPanel";
import { ResourceIcon } from "./ResourceIcon";
import { ScaleToolbar } from "./ScaleToolbar";
import { useTopologyStorage } from "./useTopologyStorage";
import {
  addClusterMember,
  availableClusterAdditions,
  configureCluster,
  connectClusterMembers,
  getClusterTopology,
  layoutCluster,
  removeClusterMembers,
} from "./clusterTopology";
import {
  MAX_RESOURCES,
  CONNECTION_PROTOCOLS,
  addService,
  configureConnection,
  configureService,
  connectResources,
  createExampleDraft,
  createResource,
  createService,
  draftReducer,
  getConnectionSettings,
  instanceCount,
  isClusterResource,
  layoutDraft,
  removeConnections,
  removeResources,
  serviceInstances,
  type ClusterResource,
  type ClusterAddition,
  type ConnectionOptions,
  type DatabaseMode,
  type ResourceKind,
  type ScaleDraft,
  type ScaleResource,
  type ScaleSelection,
  type ScaleService,
} from "./topology";
import "./scale.css";

function InspectorLoading() {
  return (
    <aside
      className="flex h-full items-center justify-center text-sm text-muted-foreground"
      role="status"
    >
      Loading configuration…
    </aside>
  );
}

const ScaleInspector = dynamic(() => import("./ScaleInspector"), {
  loading: InspectorLoading,
});
const ClusterInspector = dynamic(() => import("./ClusterInspector"), {
  loading: InspectorLoading,
});
const ConnectionInspector = dynamic(() => import("./ConnectionInspector"), {
  loading: InspectorLoading,
});

function ConnectionPreview({
  source,
  target,
}: {
  source: Pick<ScaleResource, "name" | "kind">;
  target: Pick<ScaleResource, "name" | "kind">;
}) {
  return (
    <div className="mx-4 grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-3 rounded-xl border border-border/50 bg-muted/30 px-3 py-2.5">
      {[
        { label: "From", node: source },
        { label: "To", node: target },
      ].map(({ label, node }, index) => (
        <div key={label} className="contents">
          {index > 0 && (
            <UiIcon name="arrow-right"
              className="size-3.5 text-muted-foreground rtl:rotate-180"
              aria-label="connects to"
            />
          )}
          <div className="scale-resource-tone min-w-0" data-kind={node.kind}>
            <div className="flex items-center gap-1.5">
              <span className="scale-resource-icon flex size-5 shrink-0 items-center justify-center rounded-md">
                <ResourceIcon kind={node.kind} className="size-3" />
              </span>
              <span className="text-[11px] text-muted-foreground">{label}</span>
            </div>
            <p className="mt-1 truncate text-xs font-medium text-foreground" title={node.name}>
              {node.name}
            </p>
          </div>
        </div>
      ))}
    </div>
  );
}

export default function ScaleEditor({ storageKey }: { storageKey: string }) {
  const [history, dispatch] = useReducer(draftReducer, undefined, () => ({
    present: createExampleDraft(),
    past: [],
    future: [],
  }));
  const draft = history.present;
  const [selection, setSelection] = useState<ScaleSelection>(null);
  const [activeClusterId, setActiveClusterId] = useState<string | null>(null);
  const [clusterSettings, setClusterSettings] = useState(false);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const activeCluster = draft.nodes.find(
    (node): node is ClusterResource => node.id === activeClusterId && isClusterResource(node),
  );
  const clusterTopology = useMemo(
    () => (activeCluster ? getClusterTopology(activeCluster) : null),
    [activeCluster],
  );
  const scopeKey = activeCluster ? `cluster:${activeCluster.id}` : "overview";
  const viewports = useRef(new Map<string, Viewport>());
  const workspaceRef = useRef<HTMLElement>(null);
  const previousScope = useRef(scopeKey);
  const [fitRequest, setFitRequest] = useState<{ revision: number; nodeId?: string }>({
    revision: 0,
  });
  const { toast } = useToast();
  const storage = useTopologyStorage(storageKey, draft, dispatch);
  const selectedNode =
    selection?.type === "node" ? draft.nodes.find((node) => node.id === selection.id) : undefined;
  const selectedConnection =
    !activeCluster && selection?.type === "edge"
      ? draft.edges.find((edge) => edge.id === selection.id)
      : undefined;
  const selectedClusterConnection =
    !clusterSettings && selection?.type === "edge"
      ? clusterTopology?.edges.find((edge) => edge.id === selection.id)
      : undefined;
  const connection = selectedConnection ?? selectedClusterConnection;
  const connectionNodes = activeCluster ? clusterTopology?.nodes : draft.nodes;
  const connectionSource = connectionNodes?.find((node) => node.id === connection?.source);
  const connectionTarget = connectionNodes?.find((node) => node.id === connection?.target);
  const connectionSettings =
    selectedConnection && connectionTarget && "kind" in connectionTarget
      ? getConnectionSettings(draft, connectionTarget, selectedConnection)
      : null;
  const selectedClusterElement =
    selection &&
    clusterTopology &&
    (selection.type === "node" ? clusterTopology.nodes : clusterTopology.edges).find(
      (element) => element.id === selection.id,
    );
  const inspectorTitle = activeCluster
    ? clusterSettings
      ? activeCluster.name
      : selectedClusterElement && "name" in selectedClusterElement
        ? selectedClusterElement.name
        : "Replication connection"
    : selectedConnection
      ? selectedConnection.label || "Connection"
      : (selectedNode?.name ?? "Resource");
  const hasInspectorTarget = !!(activeCluster
    ? clusterSettings || selectedClusterElement
    : selectedNode || (selectedConnection && connectionSource && connectionTarget));
  const inspectorExpanded = hasInspectorTarget && inspectorOpen;

  const change = useCallback(
    (update: (current: ScaleDraft) => ScaleDraft) => dispatch({ type: "change", draft: update }),
    [],
  );
  const select = useCallback((next: ScaleSelection) => {
    setClusterSettings(false);
    if (!next) setInspectorOpen(false);
    setSelection((current) =>
      current?.type === next?.type && current?.id === next?.id ? current : next,
    );
  }, []);
  const closeInspector = useCallback(() => select(null), [select]);
  const openInspector = useCallback(() => setInspectorOpen(true), []);
  const minimizeInspector = useCallback(() => setInspectorOpen(false), []);
  const openCluster = useCallback(
    (id: string) => {
      setActiveClusterId(id);
      select(null);
    },
    [select],
  );
  const backToOverview = useCallback(() => {
    setActiveClusterId(null);
    select(null);
  }, [select]);
  const selectOverviewResource = useCallback(
    (next: ScaleSelection) => {
      setActiveClusterId(null);
      select(next);
    },
    [select],
  );
  const configureActiveCluster = useCallback(() => {
    setSelection(null);
    setClusterSettings(true);
    setInspectorOpen(true);
  }, []);
  const rememberViewport = useCallback(
    (viewport: Viewport) => {
      viewports.current.set(scopeKey, viewport);
    },
    [scopeKey],
  );
  const editCluster = useCallback(
    (update: (cluster: ClusterResource) => ClusterResource) => {
      if (!activeCluster) return;
      try {
        const next = update(activeCluster);
        const nextTopology = getClusterTopology(next);
        change((current) => ({
          ...current,
          nodes: current.nodes.map((node) =>
            node.id === next.id ? { ...next, position: node.position } : node,
          ),
        }));
        setSelection((current) => {
          if (!current) return current;
          if (current.type === "node")
            return nextTopology.nodes.some((node) => node.id === current.id) ? current : null;
          if (nextTopology.edges.some((edge) => edge.id === current.id)) return current;
          const target = getClusterTopology(activeCluster).edges.find(
            (edge) => edge.id === current.id,
          )?.target;
          const replacement = nextTopology.edges.find((edge) => edge.target === target);
          return replacement ? { type: "edge", id: replacement.id } : null;
        });
        if (instanceCount(next) !== instanceCount(activeCluster))
          setFitRequest((current) => ({ revision: current.revision + 1 }));
        return next;
      } catch (error) {
        toast("error", error instanceof Error ? error.message : "Could not update this cluster.");
      }
    },
    [activeCluster, change, toast],
  );
  const updateResource = useCallback(
    (resource: ScaleResource) => {
      const previous = draft.nodes.find((node) => node.id === resource.id);
      if (!previous) return;
      try {
        const next =
          isClusterResource(resource) && isClusterResource(previous)
            ? configureCluster(resource, previous)
            : resource;
        change((current) => ({
          ...current,
          nodes: current.nodes.map((node) =>
            node.id === resource.id ? { ...next, position: node.position } : node,
          ),
        }));
        if (activeClusterId === resource.id && instanceCount(next) !== instanceCount(previous))
          setFitRequest((current) => ({ revision: current.revision + 1 }));
      } catch (error) {
        toast("error", error instanceof Error ? error.message : "Could not update this resource.");
      }
    },
    [change, draft.nodes, activeClusterId, toast],
  );
  const updateService = useCallback(
    (service: ScaleService, count?: number) => {
      try {
        const next = configureService(draft, service, count);
        dispatch({ type: "change", draft: next });
        if (selection?.type === "node" && !next.nodes.some((node) => node.id === selection.id))
          select({ type: "node", id: serviceInstances(next, service.id)[0].id });
        if (next.nodes.length !== draft.nodes.length)
          setFitRequest((current) => ({ revision: current.revision + 1 }));
      } catch (error) {
        toast(
          "error",
          error instanceof Error ? error.message : "Could not update the application.",
        );
      }
    },
    [draft, selection, select, toast],
  );
  const moveResources = useCallback(
    (positions: { id: string; position: { x: number; y: number } }[]) => {
      const moved = new Map(positions.map((entry) => [entry.id, entry.position]));
      change((current) => ({
        ...current,
        nodes: current.nodes.map((node) => {
          const position = moved.get(node.id);
          return position && (position.x !== node.position.x || position.y !== node.position.y)
            ? { ...node, position: { ...position } }
            : node;
        }),
      }));
    },
    [change],
  );
  const removeNodes = useCallback(
    (ids: string[]) => {
      change((current) => removeResources(current, ids));
      setSelection((current) =>
        current?.type === "node" && ids.includes(current.id) ? null : current,
      );
    },
    [change],
  );
  const removeEdges = useCallback(
    (ids: string[]) => {
      change((current) => removeConnections(current, ids));
      setSelection((current) =>
        current?.type === "edge" && ids.includes(current.id) ? null : current,
      );
    },
    [change],
  );
  const connect = useCallback(
    (source: string, target: string) => {
      try {
        dispatch({ type: "change", draft: connectResources(draft, source, target) });
      } catch (error) {
        toast(
          "error",
          error instanceof Error ? error.message : "Could not connect these resources.",
        );
      }
    },
    [draft, toast],
  );
  const updateConnection = useCallback(
    (id: string, options: ConnectionOptions) => {
      try {
        dispatch({ type: "change", draft: configureConnection(draft, id, options) });
      } catch (error) {
        toast(
          "error",
          error instanceof Error ? error.message : "Could not update this connection.",
        );
      }
    },
    [draft, toast],
  );
  const moveMembers = useCallback(
    (positions: { id: string; position: { x: number; y: number } }[]) => {
      const moved = new Map(positions.map((entry) => [entry.id, entry.position]));
      editCluster((current) => {
        const topology = getClusterTopology(current);
        return {
          ...current,
          topology: {
            ...topology,
            nodes: topology.nodes.map((node) => {
              const position = moved.get(node.id);
              return position && (position.x !== node.position.x || position.y !== node.position.y)
                ? { ...node, position: { ...position } }
                : node;
            }),
          },
        };
      });
    },
    [editCluster],
  );
  const removeMembers = useCallback(
    (ids: string[]) => {
      editCluster((current) => removeClusterMembers(current, ids));
    },
    [editCluster],
  );
  const removeMemberEdges = useCallback(
    (ids: string[]) => {
      editCluster((current) => {
        const topology = getClusterTopology(current);
        return {
          ...current,
          topology: { ...topology, edges: topology.edges.filter((edge) => !ids.includes(edge.id)) },
        };
      });
    },
    [editCluster],
  );
  const connectMembers = useCallback(
    (source: string, target: string) => {
      editCluster((current) => connectClusterMembers(current, source, target));
    },
    [editCluster],
  );
  const addMember = useCallback(
    (kind: ClusterAddition) => {
      if (!activeCluster) return;
      const next = editCluster((current) => addClusterMember(current, kind));
      if (!next) return;
      if (kind === "add-replica-per-shard") {
        configureActiveCluster();
      } else {
        const existing = new Set(getClusterTopology(activeCluster).nodes.map((node) => node.id));
        const member = getClusterTopology(next).nodes.find((node) => !existing.has(node.id));
        if (member) {
          select({ type: "node", id: member.id });
          setInspectorOpen(true);
        }
      }
    },
    [activeCluster, editCluster, select, configureActiveCluster],
  );
  const addResource = useCallback(
    (kind: ResourceKind, mode: DatabaseMode = "standalone") => {
      const id = randomUUID();
      try {
        if (kind === "service") {
          let ordinal = 1;
          while (draft.services.some((service) => service.name === `application-${ordinal}`))
            ordinal += 1;
          dispatch({
            type: "change",
            draft: addService(draft, createService(id, `application-${ordinal}`)),
          });
          select({ type: "node", id: `${id}-instance-1` });
        } else {
          if (draft.nodes.length >= MAX_RESOURCES)
            throw new Error(`The draft supports up to ${MAX_RESOURCES} nodes.`);
          let ordinal = 1;
          let resource = createResource(kind, id, ordinal, mode);
          while (draft.nodes.some((node) => node.name === resource.name))
            resource = createResource(kind, id, ++ordinal, mode);
          const siblings = draft.nodes.filter(
            (node) =>
              node.kind === kind ||
              (node.kind !== "service" && node.kind !== "edge" && kind !== "edge"),
          );
          const spacing = kind === "edge" ? 250 : 300;
          resource.position.y =
            Math.max(-spacing, ...siblings.map((node) => node.position.y)) + spacing;
          change((current) => ({ ...current, nodes: [...current.nodes, resource] }));
          select({ type: "node", id });
        }
        setInspectorOpen(true);
        setFitRequest((current) => ({ revision: current.revision + 1 }));
      } catch (error) {
        toast("error", error instanceof Error ? error.message : "Could not add this resource.");
      }
    },
    [draft, change, select, toast],
  );
  const autoLayout = useCallback(() => {
    if (activeCluster) editCluster(layoutCluster);
    else change(layoutDraft);
    setFitRequest((current) => ({ revision: current.revision + 1 }));
  }, [change, activeCluster, editCluster]);
  const exportDraft = useCallback(() => {
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(draft, null, 2)], { type: "application/json" }),
    );
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "openship-scaling-draft.json";
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }, [draft]);
  const resetExample = useCallback(() => {
    if (
      !window.confirm(
        "Reset the local topology to the example? You can undo this change. No infrastructure is changed.",
      )
    )
      return;
    dispatch({ type: "change", draft: createExampleDraft() });
    viewports.current.clear();
    backToOverview();
    setFitRequest((current) => ({ revision: current.revision + 1 }));
  }, [backToOverview]);

  useEffect(() => {
    if (activeClusterId && !activeCluster) backToOverview();
  }, [activeClusterId, activeCluster, backToOverview]);

  useEffect(() => {
    if (!hasInspectorTarget) setInspectorOpen(false);
  }, [hasInspectorTarget]);

  useEffect(() => {
    if (previousScope.current === scopeKey) return;
    previousScope.current = scopeKey;
    const frame = requestAnimationFrame(() => {
      const label = scopeKey === "overview" ? "Canvas options" : "Back to overview";
      workspaceRef.current
        ?.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)
        ?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [scopeKey]);

  useEffect(() => {
    if (!storage.ready) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        !(event.ctrlKey || event.metaKey) ||
        (event.target as HTMLElement | null)?.closest(
          "input, textarea, select, [contenteditable='true']",
        )
      )
        return;
      if (event.key.toLowerCase() === "z") {
        event.preventDefault();
        dispatch({ type: event.shiftKey ? "redo" : "undo" });
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [storage.ready]);

  if (!storage.ready) return <ScaleLoading />;
  return (
    <div className="scale-page h-full min-h-0 w-full p-3">
      <section
        ref={workspaceRef}
        className="scale-workspace relative isolate h-full min-h-0 min-w-0 overflow-hidden rounded-2xl border border-border/50 bg-background"
        aria-label="Scaling workspace"
        data-scope={activeCluster ? "cluster" : "overview"}
        data-inspector={hasInspectorTarget ? (inspectorOpen ? "expanded" : "minimized") : undefined}
        data-inspector-target={connection ? "connection" : "node"}
      >
        <div className="absolute inset-0" aria-label="Scaling topology">
          <ScaleCanvas
            key={scopeKey}
            inert={inspectorExpanded}
            draft={draft}
            cluster={activeCluster}
            selection={selection}
            onSelect={select}
            onConnect={activeCluster ? connectMembers : connect}
            onMove={activeCluster ? moveMembers : moveResources}
            onRemoveNodes={activeCluster ? removeMembers : removeNodes}
            onRemoveEdges={activeCluster ? removeMemberEdges : removeEdges}
            fitRequest={fitRequest}
            onOpenCluster={openCluster}
            defaultViewport={viewports.current.get(scopeKey)}
            onViewportChange={rememberViewport}
          />
        </div>
        <ScaleToolbar
          key={scopeKey}
          inert={inspectorExpanded}
          cluster={activeCluster}
          onBack={backToOverview}
          onConfigureCluster={configureActiveCluster}
          onAddMember={addMember}
          canUndo={!!history.past.length}
          canRedo={!!history.future.length}
          canAdd={
            activeCluster
              ? availableClusterAdditions(activeCluster).some((action) => !action.disabled)
              : draft.nodes.length < MAX_RESOURCES
          }
          hasNodes={!!draft.nodes.length}
          onAdd={addResource}
          onUndo={() => dispatch({ type: "undo" })}
          onRedo={() => dispatch({ type: "redo" })}
          onLayout={autoLayout}
          onExport={exportDraft}
          onReset={resetExample}
        />
        {storage.notice && (
          <div
            role="status"
            inert={inspectorExpanded}
            className="scale-storage-notice absolute start-4 z-40 max-w-lg rounded-xl border border-warning-border bg-popover p-3 text-sm"
          >
            <div className="flex items-start gap-2 text-muted-foreground">
              <UiIcon name="info" className="mt-0.5 size-4 shrink-0 text-warning" />
              <p>{storage.notice}</p>
            </div>
            <div className="mt-2 flex gap-2">
              <Button variant="outline" size="sm" onClick={storage.retry}>
                {storage.blocked ? "Replace saved layout" : "Retry"}
              </Button>
              <Button variant="ghost" size="sm" onClick={exportDraft}>
                Export topology
              </Button>
            </div>
          </div>
        )}
        <button
          type="button"
          className="scale-inspector-backdrop"
          data-open={inspectorExpanded}
          disabled={!inspectorExpanded}
          aria-hidden={!inspectorExpanded}
          aria-label="Minimize settings"
          tabIndex={-1}
          onClick={minimizeInspector}
        />
        {hasInspectorTarget && (
          <ScaleDetailsPanel
            key={`${scopeKey}:${clusterSettings ? "cluster" : selection?.type}:${clusterSettings ? activeCluster?.id : selection?.id}`}
            title={inspectorTitle}
            kind={activeCluster?.kind ?? selectedNode?.kind ?? "service"}
            icon={connection ? <UiIcon name="git-branch" className="size-5" /> : undefined}
            connectionPreview={
              connection && connectionSource && connectionTarget
                ? {
                    content: (
                      <ConnectionPreview
                        source={{
                          name: connectionSource.name,
                          kind:
                            "kind" in connectionSource
                              ? connectionSource.kind
                              : activeCluster!.kind,
                        }}
                        target={{
                          name: connectionTarget.name,
                          kind:
                            "kind" in connectionTarget
                              ? connectionTarget.kind
                              : activeCluster!.kind,
                        }}
                      />
                    ),
                    description: selectedClusterConnection
                      ? `${selectedClusterConnection.mode === "sync" ? "Sync" : "Async"} replication`
                      : connectionSettings
                        ? `${connectionSettings.enabled ? "" : "Disabled · "}${CONNECTION_PROTOCOLS[connectionSettings.protocol]} · ${connectionSettings.port}`
                        : "",
                    onRemove: () =>
                      activeCluster
                        ? removeMemberEdges([connection.id])
                        : removeEdges([connection.id]),
                  }
                : undefined
            }
            open={inspectorOpen}
            onOpen={openInspector}
            onMinimize={minimizeInspector}
            onClose={closeInspector}
            onBack={activeCluster ? backToOverview : undefined}
          >
            {activeCluster && !clusterSettings ? (
              <ClusterInspector
                key={`${activeCluster.id}:${selection?.type}:${selection?.id}`}
                cluster={activeCluster}
                selection={selection}
                onChange={editCluster}
                onSelect={select}
                onRemoveNodes={removeMembers}
                onConfigure={configureActiveCluster}
                onClose={closeInspector}
                onMinimize={minimizeInspector}
              />
            ) : selectedConnection ? (
              <ConnectionInspector
                draft={draft}
                connection={selectedConnection}
                onUpdate={updateConnection}
                onRemove={removeEdges}
                onClose={closeInspector}
                onMinimize={minimizeInspector}
              />
            ) : (
              <ScaleInspector
                draft={draft}
                selection={activeCluster ? { type: "node", id: activeCluster.id } : selection}
                onUpdate={updateResource}
                onUpdateService={updateService}
                onSelect={selectOverviewResource}
                onConnect={connect}
                onRemoveNodes={removeNodes}
                onRemoveEdges={removeEdges}
                onClose={closeInspector}
                onMinimize={minimizeInspector}
                onOpenCluster={activeCluster ? undefined : openCluster}
              />
            )}
          </ScaleDetailsPanel>
        )}
      </section>
    </div>
  );
}
