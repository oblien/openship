"use client";

import { Icon as UiIcon } from "@repo/ui/icons";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { DismissiblePopover } from "@/components/ui/Popover";
import { ResourceIcon } from "./ResourceIcon";
import {
  DATABASE_CATALOG,
  DATABASE_ENGINES,
  DATABASE_KINDS,
  RESOURCE_META,
  availableClusterAdditions,
  instanceCount,
  type ClusterAddition,
  type ClusterResource,
  type DatabaseKind,
  type DatabaseMode,
  type ResourceKind,
} from "./topology";

function ClusterMenu({
  cluster,
  onAdd,
}: {
  cluster: ClusterResource;
  onAdd: (kind: ClusterAddition) => void;
}) {
  const choices = availableClusterAdditions(cluster);
  return choices.map((choice) => (
    <button
      type="button"
      key={choice.id}
      aria-label={choice.label}
      disabled={choice.disabled}
      className="flex w-full items-center gap-3 rounded-xl p-3 text-start transition-colors hover:bg-muted/60 disabled:cursor-not-allowed disabled:opacity-40"
      onClick={() => onAdd(choice.id)}
    >
      <UiIcon name="plus" className="size-4 shrink-0 text-muted-foreground" />
      <span>
        <span className="block text-sm font-medium text-foreground">{choice.label}</span>
        <span className="mt-0.5 block text-xs text-muted-foreground">
          {choice.disabledReason ?? choice.description}
        </span>
      </span>
    </button>
  ));
}

export function ResourceMenu({
  onAdd,
}: {
  onAdd: (kind: ResourceKind, mode?: DatabaseMode) => void;
}) {
  const [database, setDatabase] = useState<DatabaseKind | null>(null);
  const viewRef = useRef<HTMLDivElement>(null);
  const previousDatabase = useRef<DatabaseKind | null>(null);
  const rowClass =
    "scale-palette-item scale-resource-tone flex w-full items-center gap-3 rounded-xl border p-3 text-start transition-colors";

  useEffect(() => {
    if (database) {
      previousDatabase.current = database;
      viewRef.current
        ?.querySelector<HTMLButtonElement>("[data-choice]")
        ?.focus({ preventScroll: true });
    } else if (previousDatabase.current) {
      viewRef.current
        ?.querySelector<HTMLButtonElement>(`[data-kind="${previousDatabase.current}"]`)
        ?.focus({ preventScroll: true });
    }
  }, [database]);

  const resourceButton = (kind: "edge" | "service", title = RESOURCE_META[kind].title) => (
    <button
      type="button"
      className={rowClass}
      data-kind={kind}
      key={kind}
      onClick={() => onAdd(kind)}
    >
      <span className="scale-resource-icon flex size-9 shrink-0 items-center justify-center rounded-lg">
        <ResourceIcon kind={kind} className="size-4" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium text-foreground">{title}</span>
        <span className="mt-1 block text-xs leading-relaxed text-muted-foreground">
          {RESOURCE_META[kind].paletteDescription}
        </span>
      </span>
      <UiIcon name="plus" className="size-3.5 shrink-0 text-muted-foreground" />
    </button>
  );

  if (database)
    return (
      <div ref={viewRef}>
        <button
          type="button"
          className="mb-1 flex w-full items-center gap-2 rounded-lg px-3 py-2.5 text-sm font-medium text-foreground hover:bg-muted/50 focus-visible:outline-2 focus-visible:outline-ring"
          aria-label="Back to node types"
          onClick={() => setDatabase(null)}
        >
          <UiIcon name="chevron-left" className="size-4 text-muted-foreground rtl:rotate-180" />
          {DATABASE_ENGINES[database]}
        </button>
        <div className="space-y-2" role="group" aria-label={DATABASE_ENGINES[database]}>
          {(Object.keys(DATABASE_CATALOG[database].deployments) as DatabaseMode[]).map((mode) => {
            const deployment = DATABASE_CATALOG[database].deployments[mode];
            const Icon = mode === "standalone" ? "database" : "layers";
            return (
              <button
                key={mode}
                type="button"
                className={rowClass}
                data-kind={database}
                data-choice={mode}
                aria-label={
                  mode === "standalone"
                    ? `Add standalone ${DATABASE_ENGINES[database]} database`
                    : `Add ${DATABASE_ENGINES[database]} cluster`
                }
                onClick={() => onAdd(database, mode)}
              >
                <span className="scale-resource-icon flex size-9 shrink-0 items-center justify-center rounded-lg">
                  <UiIcon name={Icon} className="size-4" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium text-foreground">
                    {deployment.label}
                  </span>
                  <span className="mt-1 block text-xs leading-relaxed text-muted-foreground">
                    {deployment.description}
                  </span>
                </span>
                <UiIcon name="plus" className="size-3.5 shrink-0 text-muted-foreground" />
              </button>
            );
          })}
        </div>
      </div>
    );

  return (
    <div ref={viewRef} className="space-y-2">
      {resourceButton("edge")}
      {resourceButton("service")}
      <div className="space-y-2 pt-2" role="group" aria-label="Databases">
        <div className="px-1 pb-0.5 text-xs font-medium text-muted-foreground">Databases</div>
        {DATABASE_KINDS.map((kind) => (
          <button
            type="button"
            key={kind}
            className={rowClass}
            data-kind={kind}
            aria-label={`Choose ${DATABASE_ENGINES[kind]} deployment`}
            onClick={() => setDatabase(kind)}
          >
            <span className="scale-resource-icon flex size-9 shrink-0 items-center justify-center rounded-lg">
              <ResourceIcon kind={kind} className="size-4" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-medium text-foreground">
                {DATABASE_ENGINES[kind]}
              </span>
              <span className="mt-0.5 block text-xs text-muted-foreground">
                {RESOURCE_META[kind].description}
              </span>
            </span>
            <UiIcon name="chevron-right" className="size-4 shrink-0 text-muted-foreground rtl:rotate-180" />
          </button>
        ))}
      </div>
    </div>
  );
}

interface ScaleToolbarProps {
  inert?: boolean;
  canUndo: boolean;
  canRedo: boolean;
  canAdd: boolean;
  hasNodes: boolean;
  onAdd: (kind: ResourceKind, mode?: DatabaseMode) => void;
  onUndo: () => void;
  onRedo: () => void;
  onLayout: () => void;
  onExport: () => void;
  onReset: () => void;
  cluster?: ClusterResource;
  onBack?: () => void;
  onConfigureCluster?: () => void;
  onAddMember?: (kind: ClusterAddition) => void;
}

export function ScaleToolbar(props: ScaleToolbarProps) {
  const [adding, setAdding] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const additions = props.cluster ? availableClusterAdditions(props.cluster) : [];
  const directAddition = additions.length === 1 ? additions[0] : undefined;
  const addLabel = directAddition?.label ?? (props.cluster ? "Add to cluster" : "Add node");
  return (
    <header
      className="scale-toolbar absolute start-4 top-4 z-30 flex items-center gap-2"
      aria-label="Topology editor"
      inert={props.inert}
      data-scope={props.cluster ? "cluster" : "overview"}
    >
      <div className="scale-toolbar-identity scale-floating-surface relative flex h-14 items-center gap-3 rounded-2xl border border-border/60 py-2 ps-3 pe-2">
        {props.cluster ? (
          <Button
            variant="outline"
            className="h-9 shrink-0 gap-1.5 rounded-lg px-2.5 text-xs"
            onClick={props.onBack}
            aria-label="Back to overview"
            title="Back to overview"
          >
            <UiIcon name="arrow-left" className="rtl:rotate-180" />
            <span>
              <span className="scale-back-prefix">Back to </span>overview
            </span>
          </Button>
        ) : (
          <div className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-muted/60 text-foreground/70">
            <UiIcon name="network" className="size-4" />
          </div>
        )}
        <div className="min-w-0 flex-1 pe-2">
          {props.cluster ? (
            <>
              <h1
                className="truncate text-sm font-medium text-foreground"
                title={props.cluster.name}
                aria-current="page"
              >
                {props.cluster.name}
              </h1>
              <p className="mt-0.5 truncate text-xs text-muted-foreground">
                {DATABASE_ENGINES[props.cluster.kind]} · {instanceCount(props.cluster)} members
              </p>
            </>
          ) : (
            <>
              <h1 className="text-sm font-medium text-foreground">Scale</h1>
              <p className="mt-0.5 whitespace-nowrap text-xs text-muted-foreground">
                Topology editor
              </p>
            </>
          )}
        </div>
        <DismissiblePopover open={moreOpen} onOpenChange={setMoreOpen}>
          <Button
            variant="ghost"
            size="icon"
            aria-label="Canvas options"
            title="Canvas options"
            aria-expanded={moreOpen}
            aria-controls="scale-options"
            onClick={() => setMoreOpen(!moreOpen)}
          >
            <UiIcon name="more" />
          </Button>
          {moreOpen && (
            <div
              id="scale-options"
              className="absolute start-0 top-full z-30 mt-2 w-64 max-w-full rounded-2xl border border-border bg-popover p-2"
            >
              <p className="border-b border-border/50 px-3 pb-3 pt-2 text-xs leading-relaxed text-muted-foreground">
                Local topology preview. No infrastructure changes.
              </p>
              {[
                { label: "Export topology", Icon: "download" as const, action: props.onExport },
                { label: "Reset example", Icon: "rotate-left" as const, action: props.onReset },
              ].map(({ label, Icon, action }) => (
                <Button
                  variant="ghost"
                  className="w-full justify-start"
                  key={label}
                  onClick={() => {
                    action();
                    setMoreOpen(false);
                  }}
                >
                  <UiIcon name={Icon} />
                  {label}
                </Button>
              ))}
            </div>
          )}
        </DismissiblePopover>
      </div>
      <div
        className="scale-toolbar-actions scale-floating-surface flex h-14 items-center gap-1 rounded-2xl border border-border/60 p-2"
        role="group"
        aria-label="Edit topology"
      >
        <div className="flex items-center" role="group" aria-label="History">
          <Button
            variant="ghost"
            size="icon"
            aria-label="Undo"
            aria-keyshortcuts="Control+Z Meta+Z"
            title="Undo (Ctrl/⌘ Z)"
            disabled={!props.canUndo}
            onClick={props.onUndo}
          >
            <UiIcon name="undo" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            aria-label="Redo"
            aria-keyshortcuts="Control+Shift+Z Meta+Shift+Z"
            title="Redo (Ctrl/⌘ Shift Z)"
            disabled={!props.canRedo}
            onClick={props.onRedo}
          >
            <UiIcon name="forward" />
          </Button>
        </div>
        <span className="mx-1 h-5 w-px bg-border/70" aria-hidden="true" />
        <Button
          variant="ghost"
          size="icon"
          aria-label="Auto layout"
          title="Arrange nodes"
          disabled={!props.hasNodes}
          onClick={props.onLayout}
        >
          <UiIcon name="grid" />
        </Button>
        {props.cluster && (
          <Button
            variant="ghost"
            size="icon"
            aria-label="Cluster settings"
            title="Cluster settings"
            onClick={props.onConfigureCluster}
          >
            <UiIcon name="sliders" />
          </Button>
        )}
        <DismissiblePopover open={adding} onOpenChange={setAdding} className="ms-auto">
          <Button
            className="h-9 gap-1.5 px-2.5"
            aria-label={addLabel}
            aria-expanded={directAddition ? undefined : adding}
            aria-controls={directAddition ? undefined : "scale-resources"}
            title={directAddition?.disabledReason}
            disabled={!props.canAdd || directAddition?.disabled}
            onClick={() =>
              directAddition ? props.onAddMember?.(directAddition.id) : setAdding(!adding)
            }
          >
            <UiIcon name="plus" />
            {props.cluster && !directAddition ? (
              <>
                Add<span className="scale-add-context"> to cluster</span>
                <UiIcon name="chevron-down" className="size-3.5" />
              </>
            ) : (
              addLabel
            )}
          </Button>
          {adding && (
            <div
              id="scale-resources"
              className="absolute end-0 top-full z-30 mt-2 max-h-[calc(100dvh-176px)] w-80 max-w-full overflow-y-auto rounded-2xl border border-border bg-popover p-2"
            >
              <p className="px-3 py-2 text-xs font-medium text-muted-foreground">
                Add to {props.cluster ? "cluster" : "canvas"}
              </p>
              {props.cluster ? (
                <ClusterMenu
                  cluster={props.cluster}
                  onAdd={(kind) => {
                    props.onAddMember?.(kind);
                    setAdding(false);
                  }}
                />
              ) : (
                <ResourceMenu
                  onAdd={(kind, mode) => {
                    props.onAdd(kind, mode);
                    setAdding(false);
                  }}
                />
              )}
            </div>
          )}
        </DismissiblePopover>
      </div>
    </header>
  );
}
