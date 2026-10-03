"use client";

import { useCallback, useId, useMemo, useState } from "react";
import { Icon } from "@repo/ui/icons";
import { useI18n, interpolate } from "@/components/i18n-provider";
import {
  TopologyCanvas,
  type TopologyNodeAction,
  type TopologySelection,
} from "@/components/topology/TopologyCanvas";
import { ServiceIcon } from "@/components/services/ServiceIcon";
import { ServiceStatusIndicator } from "@/components/services/ServiceStatusBadge";
import { optionCardSurface } from "@/components/shared/OptionCard";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/Checkbox";
import { Tabs } from "@/components/ui/Tabs";
import type {
  DiscoveredGroup,
  DiscoveredService,
  OpenshipProjectGroup,
} from "@/lib/api/server-migration";
import {
  discoveryGraph,
  groupKey,
  isBlocked,
  isProxy,
  selectableServices,
  svcUid,
} from "./discovery-model";
import "@/components/scale/scale.css";
import "@/components/topology/topology.css";

export type DiscoveryView = "topology" | "cards";
interface SelectionProject {
  id: string;
  name: string;
  services: ReadonlySet<string>;
}
interface DiscoveredProjectsProps {
  groups: DiscoveredGroup[];
  recovered: OpenshipProjectGroup[];
  recoveryId: string | null;
  onSelectRecovery: (id: string) => void;
  activeProject: SelectionProject;
  projects: SelectionProject[];
  claimedBy: ReadonlyMap<string, string>;
  view: DiscoveryView;
  onViewChange: (view: DiscoveryView) => void;
  onToggle: (service: DiscoveredService, group: DiscoveredGroup) => void;
  onToggleGroup: (group: DiscoveredGroup) => void;
}

/** Two presentations of the same selection. Neither writes to the source server. */
export function DiscoveredProjects(props: DiscoveredProjectsProps) {
  const { t } = useI18n();
  const d = t.migration.discover;
  const id = useId();
  return (
    <section className="min-w-0 space-y-4" aria-label={d.chooseProject}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-base font-semibold text-foreground">{d.chooseProject}</h3>
          <p className="mt-1 text-xs text-muted-foreground">{d.chooseHint}</p>
        </div>
        <Tabs
          tabs={[
            { key: "cards", label: d.cards, icon: "grid" },
            { key: "topology", label: d.topology, icon: "topology" },
          ]}
          value={props.view}
          onChange={props.onViewChange}
          columns={2}
          idPrefix={id}
          ariaLabel={d.viewLabel}
          className="shrink-0 rounded-xl bg-card p-1"
        />
      </div>
      <div
        role="tabpanel"
        id={`${id}-panel-${props.view}`}
        aria-labelledby={`${id}-tab-${props.view}`}
        className="space-y-4"
      >
        {props.recovered.map((project, index) => (
          <DiscoveredProject
            key={`recovered:${project.projectId}`}
            {...props}
            group={{ project: project.suggestedName, services: project.services }}
            recoveredProject={project}
            initiallyExpanded={index === 0}
          />
        ))}
        {props.groups.map((group, index) => (
          <DiscoveredProject
            key={`compose:${groupKey(group)}`}
            {...props}
            group={group}
            initiallyExpanded={props.recovered.length === 0 && index === 0}
          />
        ))}
      </div>
      {props.view === "topology" && (
        <p className="text-xs text-muted-foreground">{d.topologyHint}</p>
      )}
    </section>
  );
}

function DiscoveredProject({
  group,
  activeProject,
  projects,
  claimedBy,
  view,
  onToggle,
  onToggleGroup,
  initiallyExpanded,
  recoveredProject,
  recoveryId,
  onSelectRecovery,
}: DiscoveredProjectsProps & {
  group: DiscoveredGroup;
  initiallyExpanded: boolean;
  recoveredProject?: OpenshipProjectGroup;
}) {
  const { t } = useI18n();
  const d = t.migration.discover;
  const graph = useMemo(() => discoveryGraph(group, d.dependsOn), [group, d.dependsOn]);
  const [selection, setSelection] = useState<TopologySelection>(null);
  const [expanded, setExpanded] = useState(
    () =>
      initiallyExpanded ||
      group.services.some((service) => activeProject.services.has(svcUid(service))),
  );
  const graphId = useId();
  const title = group.project ?? d.standaloneGroup;
  const available = selectableServices(group, activeProject.id, claimedBy);
  const pickedCount = available.filter((service) =>
    activeProject.services.has(svcUid(service)),
  ).length;
  const allSelected = available.length > 0 && pickedCount === available.length;
  const actions = useMemo(
    () =>
      Object.fromEntries(
        group.services.map((service) => {
          const uid = svcUid(service);
          const owner = claimedBy.get(uid);
          const claimedElsewhere = owner && owner !== activeProject.id;
          const hint = recoveredProject
            ? undefined
            : isBlocked(service)
              ? d.buildBlocked
              : isProxy(service)
                ? interpolate(d.proxyExcluded, {
                    ports: (service.edgePorts ?? []).map((port) => `:${port}`).join("/"),
                  })
                : claimedElsewhere
                  ? interpolate(d.claimedIn, {
                      project: projects.find((project) => project.id === owner)?.name ?? "",
                    })
                  : undefined;
          const selected = !recoveredProject && activeProject.services.has(uid);
          return [
            uid,
            {
              selected,
              disabled: Boolean(hint),
              hint,
              label: recoveredProject
                ? t.migration.reimport.review
                : hint
                  ? d.unavailable
                  : selected
                    ? d.selected
                    : d.selectService,
              ariaLabel: recoveredProject
                ? interpolate(t.migration.reimport.reviewNamed, { name: title })
                : interpolate(d.selectNamedService, { name: service.name }),
              statusLabel: service.running ? d.running : d.stopped,
              readOnly: Boolean(recoveredProject),
            } satisfies TopologyNodeAction,
          ];
        }),
      ),
    [group, activeProject, projects, claimedBy, d, recoveredProject, t.migration.reimport, title],
  );
  const toggle = useCallback(
    (id: string) => {
      if (recoveredProject) {
        setExpanded(true);
        onSelectRecovery(recoveredProject.projectId);
        return;
      }
      const service = group.services.find((service) => svcUid(service) === id);
      if (service && !actions[id]?.disabled) {
        setExpanded(true);
        onToggle(service, group);
      }
    },
    [group, actions, onToggle, recoveredProject, onSelectRecovery],
  );
  const select = useCallback(
    (next: TopologySelection) => {
      if (next?.kind === "node") toggle(next.id);
      else setSelection(next);
    },
    [toggle],
  );
  return (
    <section className="@container overflow-hidden rounded-2xl bg-card" aria-label={title}>
      <div className="flex items-center gap-3 p-4 text-start">
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-3 rounded-lg text-start focus-visible:outline-2 focus-visible:outline-ring"
          onClick={() => setExpanded((value) => !value)}
          aria-expanded={expanded}
          aria-controls={graphId}
          aria-label={interpolate(d.expandProject, { name: title })}
        >
          <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-muted/70">
            <Icon name="project" className="size-4 text-muted-foreground" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-semibold text-foreground" title={title}>
              {title}
            </span>
            <span className="mt-0.5 block truncate text-xs text-muted-foreground">
              {recoveredProject
                ? t.migration.reimport.groupLabel
                : group.project
                  ? d.composeGroup
                  : d.standalone}
              {" · "}
              {interpolate(t.migration.tab.servicesCount, { n: String(group.services.length) })}
            </span>
          </span>
          <Icon
            name="chevron-down"
            className={`size-3.5 shrink-0 text-muted-foreground transition-transform ${expanded ? "rotate-180" : ""}`}
          />
        </button>
        <Button
          variant="ghost"
          size="sm"
          className="shrink-0"
          role={recoveredProject ? undefined : "checkbox"}
          aria-checked={
            recoveredProject ? undefined : allSelected ? true : pickedCount ? "mixed" : false
          }
          aria-pressed={recoveredProject ? recoveryId === recoveredProject.projectId : undefined}
          aria-label={interpolate(
            recoveredProject ? t.migration.reimport.reviewNamed : d.selectProject,
            { name: title },
          )}
          disabled={!recoveredProject && available.length === 0}
          onClick={() => {
            setExpanded(true);
            if (recoveredProject) onSelectRecovery(recoveredProject.projectId);
            else onToggleGroup(group);
          }}
        >
          {!recoveredProject && (
            <Checkbox
              asButton={false}
              checked={allSelected ? true : pickedCount ? "indeterminate" : false}
            />
          )}
          {recoveredProject
            ? t.migration.reimport.review
            : allSelected
              ? d.clearSelection
              : d.selectAll}
        </Button>
      </div>
      {expanded &&
        (view === "topology" ? (
          <div
            id={graphId}
            className="topology-workspace"
            style={{ height: group.services.length > 2 ? 420 : 260, minHeight: 0 }}
          >
            <TopologyCanvas
              graph={graph}
              layoutKey={null}
              selection={selection}
              fullscreen={false}
              inert={false}
              onSelect={select}
              onOpen={toggle}
              nodeActions={actions}
              ariaLabel={`${title} — ${d.topology}`}
              nodeDescription={d.selectionKeyboard}
            />
          </div>
        ) : (
          <div id={graphId} className="grid grid-cols-1 gap-3 p-4 pt-0 @2xl:grid-cols-2">
            {group.services.map((service) => {
              const action = actions[svcUid(service)]!;
              const imageRef = service.image ?? service.build;
              return (
                <button
                  key={svcUid(service)}
                  type="button"
                  role={recoveredProject ? undefined : "checkbox"}
                  aria-checked={recoveredProject ? undefined : action.selected}
                  disabled={action.disabled}
                  aria-label={action.ariaLabel}
                  onClick={() => toggle(svcUid(service))}
                  className={`flex min-w-0 items-start gap-3 rounded-xl border p-4 text-start transition-colors focus-visible:outline-2 focus-visible:outline-ring disabled:cursor-not-allowed ${optionCardSurface(action.selected)}`}
                >
                  <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted/50">
                    <ServiceIcon service={service} />
                  </span>
                  <span className="min-w-0 flex-1 space-y-1">
                    <span className="flex min-w-0 items-center justify-between gap-3">
                      <span
                        className="truncate text-sm font-medium text-foreground"
                        title={service.name}
                      >
                        {service.name}
                      </span>
                      <span className="flex shrink-0 items-center gap-3">
                        <ServiceStatusIndicator
                          status={service.running ? "running" : "stopped"}
                          label={action.statusLabel}
                        />
                        {!recoveredProject && (
                          <Checkbox asButton={false} checked={action.selected} />
                        )}
                      </span>
                    </span>
                    {(imageRef || service.volumes.length > 0) && (
                      <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
                        {imageRef && (
                          <span className="truncate" title={imageRef}>
                            {imageRef}
                          </span>
                        )}
                        {service.volumes.length > 0 && (
                          <>
                            {imageRef && <span aria-hidden="true">·</span>}
                            <span className="shrink-0">
                              {interpolate(d.nVolumes, { n: String(service.volumes.length) })}
                            </span>
                          </>
                        )}
                      </span>
                    )}
                    {action.hint && (
                      <span className="block text-xs text-muted-foreground">{action.hint}</span>
                    )}
                  </span>
                </button>
              );
            })}
          </div>
        ))}
      {view === "topology" && group.services.some((service) => actions[svcUid(service)]?.hint) && (
        <div className="space-y-1 px-4 pb-4 text-xs text-muted-foreground">
          {group.services
            .filter((service) => actions[svcUid(service)]?.hint)
            .map((service) => (
              <p key={svcUid(service)}>
                <span className="font-medium text-foreground">{service.name}</span> ·{" "}
                {actions[svcUid(service)]!.hint}
              </p>
            ))}
        </div>
      )}
    </section>
  );
}
