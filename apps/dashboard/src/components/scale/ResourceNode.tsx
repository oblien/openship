"use client";

import { memo } from "react";
import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import { ArrowUpRight, GitBranch, Layers3, MapPin, ShieldCheck } from "lucide-react";
import { ResourceIcon } from "./ResourceIcon";
import { getClusterTopology } from "./clusterTopology";
import {
  ALGORITHMS,
  APPLICATION_TYPES,
  DATABASE_ENGINES,
  REGIONS,
  RESOURCE_META,
  isDatabaseKind,
  isDatabaseResource,
  isClusterResource,
  type ScaleResource,
  type ScaleService,
} from "./topology";

export type ScaleFlowNode = Node<
  {
    resource: ScaleResource;
    service?: ScaleService;
    onOpenCluster?: (id: string) => void;
  },
  "resource"
>;

export const ResourceNode = memo(function ResourceNode({
  data,
  selected,
  isConnectable,
}: NodeProps<ScaleFlowNode>) {
  const { resource, service, onOpenCluster } = data;
  const cluster = isClusterResource(resource);
  const topology = cluster ? getClusterTopology(resource) : null;
  const primaries = topology?.nodes.filter((member) => member.role === "primary").length ?? 0;
  const replicas = topology?.nodes.filter((member) => member.role === "replica").length ?? 0;
  const unconnected = replicas - new Set(topology?.edges.map((edge) => edge.target)).size;
  const regions = new Set(
    topology ? topology.nodes.map((member) => member.region) : [resource.region],
  );
  const regionLabel =
    regions.size > 1 ? "Multi-region" : REGIONS.find((region) => regions.has(region.id))?.short;
  return (
    <div
      className="scale-resource-tone scale-resource-node relative w-[260px] rounded-2xl border p-4 text-start"
      data-kind={resource.kind}
      data-selected={selected}
      data-cluster={cluster || undefined}
    >
      <Handle type="target" position={Position.Left} id="in" isConnectable={isConnectable} />
      <div className="flex items-start gap-3">
        <div className="scale-resource-icon flex size-9 shrink-0 items-center justify-center rounded-xl">
          <ResourceIcon kind={resource.kind} className="size-4" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-foreground" title={resource.name}>
            {resource.name}
          </p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {resource.kind === "service" && service
              ? `${APPLICATION_TYPES[service.applicationType]} · Instance ${resource.ordinal}`
              : isDatabaseKind(resource.kind)
                ? `${DATABASE_ENGINES[resource.kind]}${cluster ? " cluster" : ""}`
                : RESOURCE_META[resource.kind].title}
          </p>
        </div>
      </div>
      {resource.kind === "edge" && (
        <div className="mt-3 flex items-center justify-between text-xs">
          <span className="text-muted-foreground">Load balancing</span>
          <span className="text-foreground/80">{ALGORITHMS[resource.algorithm]}</span>
        </div>
      )}
      {resource.kind === "service" && service && (
        <div className="mt-3 flex items-center justify-between text-xs text-muted-foreground">
          <span>
            {service.cpu} vCPU · {service.memory / 1024} GB
          </span>
          <span className="font-mono">:{service.port}</span>
        </div>
      )}
      {isDatabaseResource(resource) && resource.mode === "standalone" && (
        <div className="mt-3 space-y-2 text-xs">
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">Standalone</span>
            <span className="text-foreground/80">
              {resource.cpu} vCPU · {resource.memory / 1024} GB
            </span>
          </div>
          {resource.kind === "postgres" && (
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Storage</span>
              <span className="text-foreground/80">{resource.storage} GB</span>
            </div>
          )}
        </div>
      )}
      {topology && (
        <div className="scale-cluster-composition mt-3 overflow-hidden rounded-xl border">
          <dl className="grid grid-cols-2 gap-2 p-2">
            {[
              { label: resource.kind === "redis" ? "Primary shards" : "Primary", count: primaries },
              { label: resource.kind === "redis" ? "Replicas" : "Read replicas", count: replicas },
            ].map(({ label, count }) => (
              <div key={label} className="flex flex-col rounded-lg bg-background/70 px-2.5 py-2">
                <dt className="mt-0.5 text-[11px] text-muted-foreground">{label}</dt>
                <dd className="order-first text-lg font-medium tabular-nums leading-6 text-foreground">
                  {count}
                </dd>
              </div>
            ))}
          </dl>
          <div className="flex items-center gap-1.5 border-t border-border/50 px-3 py-2 text-[11px] text-muted-foreground">
            <GitBranch className="size-3 shrink-0" />
            <span>
              {topology.edges.length} replication {topology.edges.length === 1 ? "link" : "links"}
            </span>
            {unconnected > 0 && (
              <span className="ms-auto text-warning">{unconnected} unconnected</span>
            )}
          </div>
        </div>
      )}
      <div className="mt-3 flex items-center gap-1.5 border-t border-border/50 pt-3 text-xs text-muted-foreground/70">
        <MapPin className="size-3" />
        <span>{regionLabel}</span>
        {resource.kind === "edge" && (
          <span className="ms-auto inline-flex items-center gap-1">
            <ShieldCheck className="size-3" />
            {resource.tls ? "HTTPS" : "External TLS"}
          </span>
        )}
        {resource.kind === "service" && <span className="ms-auto">Stateless</span>}
        {topology && (
          <span className="ms-auto inline-flex items-center gap-1 tabular-nums">
            <Layers3 className="size-3" />
            {topology.nodes.length} members
          </span>
        )}
      </div>
      {cluster && onOpenCluster && (
        <button
          type="button"
          className="scale-open-cluster nodrag nopan mt-3 flex w-full items-center justify-between rounded-lg px-2.5 py-2 text-xs font-medium transition-colors"
          aria-label={`Open ${resource.name} cluster`}
          onClick={(event) => {
            event.stopPropagation();
            onOpenCluster(resource.id);
          }}
          onDoubleClick={(event) => event.stopPropagation()}
        >
          Open cluster
          <ArrowUpRight className="size-3.5" />
        </button>
      )}
      {resource.kind !== "postgres" && resource.kind !== "redis" && (
        <Handle type="source" position={Position.Right} id="out" isConnectable={isConnectable} />
      )}
    </div>
  );
});
