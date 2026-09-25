"use client";

import { Icon as UiIcon } from "@repo/ui/icons";

import { memo } from "react";
import { Button } from "@/components/ui/button";
import { Section, SelectField, TextField } from "./InspectorFields";
import { ResourceIcon } from "./ResourceIcon";
import {
  DATABASE_CATALOG,
  REGIONS,
  REPLICATION_MODES,
  type ClusterResource,
  type ReplicationMode,
  type ScaleSelection,
} from "./topology";
import {
  canRemoveClusterMember,
  clusterConnectionError,
  clusterReplicationModes,
  clusterSlotRange,
  getClusterTopology,
  setReplicationMode,
  setReplicationSource,
  type ClusterMember,
} from "./clusterTopology";

interface ClusterInspectorProps {
  cluster: ClusterResource;
  selection: ScaleSelection;
  onChange: (update: (cluster: ClusterResource) => ClusterResource) => void;
  onSelect: (selection: ScaleSelection) => void;
  onRemoveNodes: (ids: string[]) => void;
  onConfigure: () => void;
  onClose: () => void;
  onMinimize?: () => void;
}

function ReplicationSettings({
  cluster,
  member,
  onChange,
}: {
  cluster: ClusterResource;
  member: ClusterMember;
  onChange: ClusterInspectorProps["onChange"];
}) {
  const topology = getClusterTopology(cluster);
  const incoming = topology.edges.find((edge) => edge.target === member.id);
  const source = topology.nodes.find((node) => node.id === incoming?.source);
  const modes = source ? clusterReplicationModes(cluster, source) : [];
  const withoutIncoming = {
    ...topology,
    edges: topology.edges.filter((edge) => edge.target !== member.id),
  };
  const sources = topology.nodes.filter(
    (node) => !clusterConnectionError(cluster, withoutIncoming, node.id, member.id),
  );
  return (
    <Section
      title="Replication"
      description={
        cluster.kind === "postgres"
          ? "Choose the primary or another replica as the upstream source."
          : "Each replica follows its shard’s primary."
      }
    >
      <SelectField
        label="Replication source"
        value={incoming?.source ?? ""}
        options={[
          { value: "", label: "Not connected" },
          ...sources.map((node) => ({ value: node.id, label: node.name })),
        ]}
        onChange={(source) =>
          onChange((current) => setReplicationSource(current, member.id, source))
        }
      />
      {incoming && modes.length > 1 && (
        <SelectField
          label="Replication mode"
          value={incoming.mode}
          options={modes.map((mode) => ({ value: mode, label: REPLICATION_MODES[mode] }))}
          onChange={(mode) =>
            onChange((current) => setReplicationMode(current, member.id, mode as ReplicationMode))
          }
        />
      )}
      {incoming && (
        <>
          <p className="text-xs leading-relaxed text-muted-foreground">
            {incoming.mode === "sync"
              ? "The upstream waits for this replica to acknowledge writes."
              : "The upstream can acknowledge writes before they reach this replica."}
          </p>
          <Button
            variant="outline"
            className="w-full"
            onClick={() => onChange((current) => setReplicationSource(current, member.id, ""))}
          >
            <UiIcon name="unplug" />
            Disconnect replication
          </Button>
        </>
      )}
      {!incoming && (
        <p className="text-xs leading-relaxed text-warning">
          Choose a source or drag a connection to this replica on the canvas.
        </p>
      )}
    </Section>
  );
}

export default memo(function ClusterInspector(props: ClusterInspectorProps) {
  const { cluster, selection, onChange, onSelect } = props;
  const topology = getClusterTopology(cluster);
  const member =
    selection?.type === "node"
      ? topology.nodes.find((node) => node.id === selection.id)
      : undefined;
  const connection =
    selection?.type === "edge"
      ? topology.edges.find((edge) => edge.id === selection.id)
      : undefined;
  const replica = connection
    ? topology.nodes.find((node) => node.id === connection.target)
    : undefined;
  if (!member && !replica) return null;
  const slots = member ? clusterSlotRange(cluster, member) : null;
  const downstream = member ? topology.edges.filter((edge) => edge.source === member.id) : [];
  const updateMember = (patch: Partial<Pick<ClusterMember, "name" | "region">>) =>
    onChange((current) => {
      const topology = getClusterTopology(current);
      return {
        ...current,
        topology: {
          ...topology,
          nodes: topology.nodes.map((node) =>
            node.id === member?.id ? { ...node, ...patch } : node,
          ),
        },
      };
    });
  return (
    <aside
      className="scale-resource-tone flex h-full min-h-0 min-w-0 flex-col overflow-hidden"
      data-kind={cluster.kind}
      aria-label={member ? "Cluster member configuration" : "Replication connection configuration"}
    >
      <div className="flex shrink-0 items-center gap-3 border-b border-border/50 p-5">
        <div className="scale-resource-icon flex size-10 shrink-0 items-center justify-center rounded-xl">
          {member ? (
            <ResourceIcon kind={cluster.kind} className="size-5" />
          ) : (
            <UiIcon name="git-branch" className="size-5" />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-sm font-medium text-foreground">
            {member?.name ?? "Replication connection"}
          </h2>
          <p className="mt-1 truncate text-xs text-muted-foreground">
            {cluster.name} ·{" "}
            {member
              ? DATABASE_CATALOG[cluster.kind].deployments.cluster.roles[member.role].label
              : replica?.name}
          </p>
        </div>
        <div className="flex shrink-0 items-center">
          {props.onMinimize && (
            <Button
              variant="ghost"
              size="icon"
              onClick={props.onMinimize}
              aria-label="Minimize inspector"
              title="Minimize panel (Esc)"
            >
              <UiIcon name="chevron-up" />
            </Button>
          )}
          <Button
            variant="ghost"
            size="icon"
            onClick={props.onClose}
            aria-label="Close inspector"
            title="Close panel"
          >
            <UiIcon name="close" />
          </Button>
        </div>
      </div>
      <div className="min-h-0 flex-1 space-y-6 overflow-y-auto overscroll-contain p-5">
        {member && (
          <>
            <Section title="Member">
              <TextField
                label="Member name"
                value={member.name}
                onChange={(name) => updateMember({ name })}
              />
              <SelectField
                label="Region"
                value={member.region}
                options={REGIONS.map((region) => ({ value: region.id, label: region.name }))}
                onChange={(region) => updateMember({ region })}
              />
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">Access</span>
                <span className="text-foreground/80">
                  {DATABASE_CATALOG[cluster.kind].deployments.cluster.roles[member.role].access ===
                  "read-write"
                    ? "Read / write"
                    : "Read only"}
                </span>
              </div>
              {slots && (
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">Hash slots</span>
                  <span className="tabular-nums text-foreground/80">
                    {slots.start}–{slots.end}
                  </span>
                </div>
              )}
            </Section>
            {member.role === "replica" && (
              <ReplicationSettings cluster={cluster} member={member} onChange={onChange} />
            )}
            {(member.role === "primary" || downstream.length > 0) && (
              <Section title="Downstream replicas">
                {downstream.length ? (
                  <div className="divide-y divide-border/50">
                    {downstream.map((edge) => {
                      const target = topology.nodes.find((node) => node.id === edge.target)!;
                      return (
                        <div key={edge.id} className="flex items-center gap-2 py-2">
                          <button
                            type="button"
                            className="min-w-0 flex-1 rounded-lg text-start"
                            onClick={() => onSelect({ type: "node", id: target.id })}
                          >
                            <p className="truncate text-sm text-foreground/80">{target.name}</p>
                            <p className="mt-1 text-xs text-muted-foreground">
                              {edge.mode === "sync" ? "Synchronous" : "Asynchronous"}
                            </p>
                          </button>
                          <Button
                            variant="ghost"
                            size="icon"
                            aria-label={`Configure replication to ${target.name}`}
                            onClick={() => onSelect({ type: "edge", id: edge.id })}
                          >
                            <UiIcon name="arrow-up-right" />
                          </Button>
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <p className="text-xs leading-relaxed text-muted-foreground">
                    No downstream replicas connected.
                  </p>
                )}
              </Section>
            )}
          </>
        )}
        {replica && <ReplicationSettings cluster={cluster} member={replica} onChange={onChange} />}
        <div className="space-y-2 border-t border-border/50 pt-5">
          <Button variant="ghost" className="w-full justify-start" onClick={props.onConfigure}>
            <UiIcon name="sliders" />
            Cluster settings
          </Button>
          {member && canRemoveClusterMember(cluster, member) && (
            <Button
              variant="ghost"
              className="w-full justify-start text-muted-foreground hover:text-danger"
              onClick={() => props.onRemoveNodes([member.id])}
            >
              <UiIcon name="trash" />
              {cluster.kind === "redis" ? "Remove shard and its replicas" : "Remove replica"}
            </Button>
          )}
        </div>
      </div>
    </aside>
  );
});
