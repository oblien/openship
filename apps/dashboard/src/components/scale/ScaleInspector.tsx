"use client";

import { memo, useState } from "react";
import {
  ArrowDownLeft,
  ArrowUpRight,
  ChevronDown,
  ChevronUp,
  Plus,
  Trash2,
  Unplug,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tabs } from "@/components/ui/Tabs";
import { ResourceIcon } from "./ResourceIcon";
import { Note, NumberField, Section, SelectField, TextField, ToggleField } from "./InspectorFields";
import { clusterSlotRange, getClusterTopology } from "./clusterTopology";
import {
  ALGORITHMS,
  APPLICATION_TYPES,
  DATABASE_CATALOG,
  DATABASE_ENGINES,
  DATABASE_MODES,
  MAX_INSTANCES,
  REGIONS,
  RESOURCE_META,
  RESOURCE_CATALOG,
  connectionError,
  isClusterResource,
  isDatabaseResource,
  instanceCount,
  serviceInstances,
  type ScaleDraft,
  type ScaleResource,
  type ScaleSelection,
  type ScaleService,
} from "./topology";

interface InspectorProps {
  draft: ScaleDraft;
  selection: ScaleSelection;
  onUpdate: (resource: ScaleResource) => void;
  onUpdateService: (service: ScaleService, count?: number) => void;
  onSelect: (selection: ScaleSelection) => void;
  onConnect: (source: string, target: string) => void;
  onRemoveNodes: (ids: string[]) => void;
  onRemoveEdges: (ids: string[]) => void;
  onClose: () => void;
  onMinimize?: () => void;
  onOpenCluster?: (id: string) => void;
}

function ApplicationSettings({
  service,
  draft,
  onUpdateService,
}: { service: ScaleService } & Pick<InspectorProps, "draft" | "onUpdateService">) {
  const count = serviceInstances(draft, service.id).length;
  return (
    <>
      <Section
        title="Application"
        description="Shared configuration for every instance. No runtime-specific behavior."
      >
        <TextField
          label="Application name"
          value={service.name}
          onChange={(name) => onUpdateService({ ...service, name })}
        />
        <SelectField
          label="Application type"
          value={service.applicationType}
          options={Object.entries(APPLICATION_TYPES).map(([value, label]) => ({ value, label }))}
          onChange={(applicationType) =>
            onUpdateService({
              ...service,
              applicationType: applicationType as ScaleService["applicationType"],
            })
          }
        />
      </Section>
      <Section
        title="Horizontal scaling"
        description="Each instance is a separate node on the canvas. OpenShip Edge balances traffic directly across them."
      >
        <NumberField
          label={service.autoscale ? "Initial instances" : "Instances"}
          value={count}
          min={service.autoscale ? service.minReplicas : 1}
          max={service.autoscale ? service.maxReplicas : MAX_INSTANCES}
          onChange={(replicas) => onUpdateService(service, replicas)}
        />
        <ToggleField
          label="Autoscaling policy"
          description="Plan capacity based on CPU utilization."
          checked={service.autoscale}
          onChange={(autoscale) =>
            onUpdateService(
              { ...service, autoscale },
              autoscale
                ? Math.max(service.minReplicas, Math.min(service.maxReplicas, count))
                : count,
            )
          }
        />
        {service.autoscale && (
          <>
            <NumberField
              label="Minimum instances"
              value={service.minReplicas}
              min={1}
              max={service.maxReplicas}
              onChange={(minReplicas) =>
                onUpdateService({ ...service, minReplicas }, Math.max(count, minReplicas))
              }
            />
            <NumberField
              label="Maximum instances"
              value={service.maxReplicas}
              min={service.minReplicas}
              max={MAX_INSTANCES}
              onChange={(maxReplicas) =>
                onUpdateService({ ...service, maxReplicas }, Math.min(count, maxReplicas))
              }
            />
            <NumberField
              label="Target CPU (%)"
              value={service.targetCpu}
              min={RESOURCE_CATALOG.service.limits.targetCpu.min}
              max={RESOURCE_CATALOG.service.limits.targetCpu.max}
              step={5}
              onChange={(targetCpu) => onUpdateService({ ...service, targetCpu })}
            />
            <Note>Policy preview only. No autoscaler is running.</Note>
          </>
        )}
        <p className="text-xs leading-relaxed text-muted-foreground">
          Connect each new instance to its gateways and databases. Keep application state outside
          these instances.
        </p>
      </Section>
      <Section title="Per-instance resources">
        <div className="grid grid-cols-2 gap-3">
          <SelectField
            label="vCPU"
            value={String(service.cpu)}
            options={RESOURCE_CATALOG.service.limits.cpu.map((cpu) => ({
              value: String(cpu),
              label: `${cpu} vCPU`,
            }))}
            onChange={(cpu) => onUpdateService({ ...service, cpu: Number(cpu) })}
          />
          <SelectField
            label="Memory"
            value={String(service.memory)}
            options={RESOURCE_CATALOG.service.limits.memory.map((memory) => ({
              value: String(memory),
              label: `${memory / 1024} GB`,
            }))}
            onChange={(memory) => onUpdateService({ ...service, memory: Number(memory) })}
          />
        </div>
        <NumberField
          label="Application port"
          value={service.port}
          min={1}
          max={65535}
          onChange={(port) => onUpdateService({ ...service, port })}
        />
      </Section>
    </>
  );
}

function Configuration({
  resource,
  draft,
  onUpdate,
  onUpdateService,
}: { resource: ScaleResource } & Pick<InspectorProps, "draft" | "onUpdate" | "onUpdateService">) {
  const [showSlots, setShowSlots] = useState(false);
  const service =
    resource.kind === "service"
      ? draft.services.find((entry) => entry.id === resource.serviceId)
      : undefined;
  const cluster = isClusterResource(resource);
  const database = isDatabaseResource(resource);
  return (
    <>
      {service && (
        <ApplicationSettings service={service} draft={draft} onUpdateService={onUpdateService} />
      )}
      <Section
        title={
          resource.kind === "service"
            ? "Instance placement"
            : database
              ? cluster
                ? "Cluster"
                : "Database"
              : "General"
        }
      >
        {database && (
          <>
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">Engine</span>
              <span className="text-foreground/80">{DATABASE_ENGINES[resource.kind]}</span>
            </div>
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">Deployment</span>
              <span className="text-foreground/80">{DATABASE_MODES[resource.mode]}</span>
            </div>
          </>
        )}
        {resource.kind !== "service" && (
          <TextField
            label={cluster ? "Cluster name" : database ? "Database name" : "Resource name"}
            value={resource.name}
            onChange={(name) => onUpdate({ ...resource, name })}
          />
        )}
        <SelectField
          label={cluster ? "Default region" : "Region"}
          value={resource.region}
          options={REGIONS.map((region) => ({ value: region.id, label: region.name }))}
          onChange={(region) => onUpdate({ ...resource, region })}
        />
      </Section>
      {database && resource.mode === "standalone" && (
        <Section title="Instance resources">
          <div className="grid grid-cols-2 gap-3">
            <SelectField
              label="vCPU"
              value={String(resource.cpu)}
              options={DATABASE_CATALOG[resource.kind].deployments.standalone.limits.cpu.map(
                (cpu) => ({ value: String(cpu), label: `${cpu} vCPU` }),
              )}
              onChange={(cpu) => onUpdate({ ...resource, cpu: Number(cpu) })}
            />
            <SelectField
              label="Memory"
              value={String(resource.memory)}
              options={DATABASE_CATALOG[resource.kind].deployments.standalone.limits.memory.map(
                (memory) => ({
                  value: String(memory),
                  label: `${memory / 1024} GB`,
                }),
              )}
              onChange={(memory) => onUpdate({ ...resource, memory: Number(memory) })}
            />
          </div>
          {resource.kind === "postgres" && (
            <NumberField
              label="Storage (GB)"
              value={resource.storage}
              min={DATABASE_CATALOG.postgres.deployments.standalone.limits.storage.min}
              max={DATABASE_CATALOG.postgres.deployments.standalone.limits.storage.max}
              step={10}
              onChange={(storage) => onUpdate({ ...resource, storage })}
            />
          )}
        </Section>
      )}
      {resource.kind === "edge" && (
        <Section
          title="OpenShip Edge"
          description="Ingress, TLS, API routing, and load balancing for your applications."
        >
          <ToggleField
            label="TLS termination"
            description="Terminate HTTPS at this gateway."
            checked={resource.tls}
            onChange={(tls) => onUpdate({ ...resource, tls })}
          />
          <SelectField
            label="Balancing algorithm"
            value={resource.algorithm}
            options={Object.entries(ALGORITHMS).map(([value, label]) => ({ value, label }))}
            onChange={(algorithm) =>
              onUpdate({ ...resource, algorithm: algorithm as keyof typeof ALGORITHMS })
            }
          />
          <TextField
            label="Health check path"
            value={resource.healthPath}
            path
            onChange={(healthPath) => onUpdate({ ...resource, healthPath })}
          />
          <NumberField
            label="Health check interval (seconds)"
            value={resource.healthInterval}
            min={RESOURCE_CATALOG.edge.limits.healthInterval.min}
            max={RESOURCE_CATALOG.edge.limits.healthInterval.max}
            step={5}
            onChange={(healthInterval) => onUpdate({ ...resource, healthInterval })}
          />
          <Note>
            Connect this gateway directly to application instances or another OpenShip Edge. There
            is no separate load balancer to provision.
          </Note>
        </Section>
      )}
      {cluster && resource.kind === "postgres" && (
        <Section
          title="Replication"
          description="One writable primary with read replicas, not multi-primary or write sharding."
        >
          <div className="flex justify-between rounded-xl bg-muted/40 p-3 text-sm">
            <span className="text-muted-foreground">Primary</span>
            <span className="text-foreground/80">1 read / write</span>
          </div>
          <NumberField
            label="Read replicas"
            value={resource.replicas}
            min={DATABASE_CATALOG.postgres.deployments.cluster.limits.replicas.min}
            max={DATABASE_CATALOG.postgres.deployments.cluster.limits.replicas.max}
            onChange={(replicas) =>
              onUpdate({ ...resource, replicas, failover: replicas > 0 && resource.failover })
            }
          />
          <ToggleField
            label="Plan automatic failover"
            description={
              resource.replicas
                ? "Promote a replica if the primary fails."
                : "Add a read replica to plan failover."
            }
            checked={resource.failover}
            disabled={!resource.replicas}
            onChange={(failover) => onUpdate({ ...resource, failover })}
          />
          <Note>
            Replication, read/write endpoints, and failover coordination require backend
            orchestration.
          </Note>
        </Section>
      )}
      {cluster && resource.kind === "redis" && (
        <Section
          title="Shards & replicas"
          description="Replicas are planned for every primary shard."
        >
          <NumberField
            label="Primary shards"
            value={resource.shards}
            min={DATABASE_CATALOG.redis.deployments.cluster.limits.shards.min}
            max={DATABASE_CATALOG.redis.deployments.cluster.limits.shards.max}
            onChange={(shards) => onUpdate({ ...resource, shards })}
          />
          <SelectField
            label="Replicas per shard"
            value={String(resource.replicasPerShard)}
            options={Array.from(
              {
                length:
                  DATABASE_CATALOG.redis.deployments.cluster.limits.replicasPerShard.max -
                  DATABASE_CATALOG.redis.deployments.cluster.limits.replicasPerShard.min +
                  1,
              },
              (_, index) => {
                const count =
                  DATABASE_CATALOG.redis.deployments.cluster.limits.replicasPerShard.min + index;
                return {
                  value: String(count),
                  label: `${count} ${count === 1 ? "replica" : "replicas"}`,
                };
              },
            )}
            onChange={(replicas) => onUpdate({ ...resource, replicasPerShard: Number(replicas) })}
          />
          <div className="rounded-xl bg-muted/40 p-3">
            <p className="text-sm font-medium text-foreground/80">
              {instanceCount(resource)} Redis nodes
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              {resource.shards} primaries + {resource.shards * resource.replicasPerShard} replicas
            </p>
          </div>
          <Note>
            At least 3 primary shards. A cluster-aware Redis client is required. The plan splits all
            16,384 hash slots.
          </Note>
          <Button
            variant="ghost"
            className="w-full justify-between px-0"
            aria-expanded={showSlots}
            onClick={() => setShowSlots(!showSlots)}
          >
            Slot allocation
            <ChevronDown className={showSlots ? "rotate-180" : ""} />
          </Button>
          {showSlots && (
            <div className="divide-y divide-border/50">
              {getClusterTopology(resource)
                .nodes.filter((node) => node.role === "primary")
                .map((member) => (
                  <div key={member.id} className="flex justify-between py-2 text-xs">
                    <span className="text-muted-foreground">Shard {member.shard}</span>
                    <code className="text-foreground/70">
                      {clusterSlotRange(resource, member)?.start}–
                      {clusterSlotRange(resource, member)?.end}
                    </code>
                  </div>
                ))}
            </div>
          )}
        </Section>
      )}
    </>
  );
}

function Connections({
  resource,
  draft,
  onConnect,
  onSelect,
  onRemoveEdges,
}: { resource: ScaleResource } & Pick<
  InspectorProps,
  "draft" | "onConnect" | "onSelect" | "onRemoveEdges"
>) {
  const [targetId, setTargetId] = useState("");
  const connections = draft.edges.filter(
    (edge) => edge.source === resource.id || edge.target === resource.id,
  );
  const targets = draft.nodes.filter((target) => !connectionError(draft, resource.id, target.id));
  const validTarget = targets.some((target) => target.id === targetId);
  return (
    <>
      <Section
        title="Connections"
        description="Each connection belongs to these two nodes. Select one to edit its settings."
      >
        {connections.length ? (
          <div className="divide-y divide-border/50">
            {connections.map((edge) => {
              const incoming = edge.target === resource.id;
              const other = draft.nodes.find(
                (node) => node.id === (incoming ? edge.source : edge.target),
              );
              if (!other) return null;
              return (
                <div className="flex items-center gap-2 py-3" key={edge.id}>
                  {incoming ? (
                    <ArrowDownLeft className="size-4 shrink-0 text-muted-foreground" />
                  ) : (
                    <ArrowUpRight className="size-4 shrink-0 text-muted-foreground" />
                  )}
                  <button
                    type="button"
                    className="min-w-0 flex-1 rounded text-start focus-visible:outline-2 focus-visible:outline-ring"
                    aria-label={`Edit connection ${incoming ? "from" : "to"} ${other.name}`}
                    onClick={() => onSelect({ type: "edge", id: edge.id })}
                  >
                    <p className="truncate text-sm text-foreground/80">{other.name}</p>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {incoming ? "Incoming" : "Outgoing"}
                      {edge.enabled === false ? " · Disabled" : ""}
                    </p>
                  </button>
                  <Button
                    variant="ghost"
                    size="icon"
                    title="Remove connection"
                    aria-label={`Disconnect ${other.name}`}
                    onClick={() => onRemoveEdges([edge.id])}
                  >
                    <Unplug />
                  </Button>
                </div>
              );
            })}
          </div>
        ) : (
          <p className="py-4 text-sm text-muted-foreground">No connections yet.</p>
        )}
      </Section>
      {resource.kind !== "postgres" && resource.kind !== "redis" && (
        <Section title="Add a connection">
          <SelectField
            label="Destination"
            value={validTarget ? targetId : ""}
            options={targets.map((target) => ({
              value: target.id,
              label: target.name,
            }))}
            onChange={setTargetId}
          />
          <Button
            variant="outline"
            className="w-full"
            disabled={!validTarget}
            onClick={() => {
              onConnect(resource.id, targetId);
              setTargetId("");
            }}
          >
            <Plus />
            Connect
          </Button>
          {!targets.length && (
            <p className="text-xs leading-relaxed text-muted-foreground">
              Add a compatible destination to the canvas first.
            </p>
          )}
        </Section>
      )}
    </>
  );
}

function ResourceInspector({ resource, ...props }: InspectorProps & { resource: ScaleResource }) {
  const [tab, setTab] = useState<"configuration" | "connections">("configuration");
  const connections = props.draft.edges.filter(
    (edge) => edge.source === resource.id || edge.target === resource.id,
  ).length;
  const siblings =
    resource.kind === "service" ? serviceInstances(props.draft, resource.serviceId) : [];
  return (
    <>
      <Tabs
        tabs={[
          { key: "configuration", label: "Configuration" },
          { key: "connections", label: "Connections", count: connections },
        ]}
        value={tab}
        onChange={setTab}
        className="px-1"
      />
      <div className="min-h-0 flex-1 space-y-6 overflow-y-auto overscroll-contain p-5">
        {isClusterResource(resource) && props.onOpenCluster && (
          <Button
            variant="outline"
            className="w-full justify-between"
            onClick={() => props.onOpenCluster?.(resource.id)}
          >
            Open cluster
            <ArrowUpRight />
          </Button>
        )}
        {tab === "configuration" ? (
          <Configuration resource={resource} {...props} />
        ) : (
          <Connections resource={resource} {...props} />
        )}
        <div className="space-y-2 border-t border-border/50 pt-5">
          <Button
            variant="ghost"
            className="w-full justify-start text-muted-foreground hover:text-danger"
            onClick={() => props.onRemoveNodes([resource.id])}
          >
            <Trash2 />
            {resource.kind === "service" ? "Remove this instance" : "Remove resource"}
          </Button>
          {siblings.length > 1 && (
            <Button
              variant="ghost"
              className="w-full justify-start text-muted-foreground hover:text-danger"
              onClick={() => props.onRemoveNodes(siblings.map((node) => node.id))}
            >
              <Trash2 />
              Remove application
            </Button>
          )}
        </div>
      </div>
    </>
  );
}

export default memo(function ScaleInspector(props: InspectorProps) {
  const resource =
    props.selection?.type === "node"
      ? props.draft.nodes.find((node) => node.id === props.selection?.id)
      : undefined;
  if (!resource) return null;
  return (
    <aside
      className="scale-resource-tone flex h-full min-h-0 min-w-0 flex-col overflow-hidden"
      data-kind={resource.kind}
      aria-label="Resource configuration"
    >
      <div className="flex shrink-0 items-center gap-3 p-5">
        <div className="scale-resource-icon flex size-10 shrink-0 items-center justify-center rounded-xl">
          <ResourceIcon kind={resource.kind} className="size-5" />
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-sm font-medium text-foreground">{resource.name}</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            {resource.kind === "service"
              ? "Application instance"
              : isClusterResource(resource)
                ? `${DATABASE_ENGINES[resource.kind]} cluster`
                : RESOURCE_META[resource.kind].title}
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
              <ChevronUp />
            </Button>
          )}
          <Button
            variant="ghost"
            size="icon"
            onClick={props.onClose}
            aria-label="Close inspector"
            title="Close panel"
          >
            <X />
          </Button>
        </div>
      </div>
      <ResourceInspector key={resource.id} resource={resource} {...props} />
    </aside>
  );
});
