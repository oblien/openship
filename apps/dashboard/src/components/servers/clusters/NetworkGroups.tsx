"use client";

import { memo, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ArrowUpRight, Network, Server, ShieldCheck } from "lucide-react";
import {
  Background,
  BackgroundVariant,
  Controls,
  ReactFlow,
  useNodesState,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import type { ServerCluster } from "@repo/contracts";
import { nativeNetworkSource } from "@repo/core";
import { BlurIp } from "@/components/BlurIp";
import { useI18n, interpolate } from "@/components/i18n-provider";
import { InfrastructureProviderLogo } from "@/components/servers/InfrastructureProviderLogo";
import { NetworkStatus } from "./NetworkStatus";
import { FitNetworkView } from "./ClusterNetworkTopology";
import { NetworkSource } from "./NetworkSource";
import { NetworkDiagnosticText } from "./NetworkSetupProgress";
import "@xyflow/react/dist/style.css";

type NetworkGroupNode = Node<{ cluster: ServerCluster }, "networkGroup">;

function NetworkGroupCard({ cluster }: { cluster: ServerCluster }) {
  const { t } = useI18n();
  const c = t.servers.networks;
  const source = nativeNetworkSource(cluster);
  const managed = cluster.network.mode === "wireguard";
  return (
    <Link
      href={`/servers/networks/${cluster.id}?tab=network&from=networking`}
      aria-label={interpolate(c.networkGroups.expand, { name: cluster.name })}
      className="nodrag nopan group block w-full rounded-2xl bg-card p-5 text-start ring-1 ring-border/50 transition-colors hover:ring-primary/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
    >
      <div className="flex items-center justify-between gap-3">
        <span
          className={`grid size-10 shrink-0 place-items-center rounded-xl ${managed ? "bg-primary/10 text-primary" : "bg-muted/60"}`}
        >
          {managed ? (
            <ShieldCheck className="size-5" />
          ) : source.providerId === "custom" ? (
            <Network className="size-5 text-muted-foreground" />
          ) : (
            <InfrastructureProviderLogo providerId={source.providerId} />
          )}
        </span>
        <NetworkStatus cluster={cluster} />
      </div>
      <h3 className="mt-4 truncate text-base font-semibold">{cluster.name}</h3>
      <div className="mt-1.5">
        <NetworkSource cluster={cluster} showIcon={false} />
      </div>
      <p className="mt-3 truncate font-mono text-xs text-muted-foreground">
        <BlurIp>{cluster.network.cidrs.join(", ")}</BlurIp>
      </p>
      <div className="mt-4 flex items-center gap-2 rounded-lg bg-muted/35 px-3 py-2.5 text-xs">
        <Server className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="truncate text-muted-foreground">
          <NetworkDiagnosticText
            value={
              cluster.members
                .slice(0, 2)
                .map((member) => member.name)
                .join(" · ") ||
              (cluster.operation ? c.managed.status[cluster.operation.status] : c.notChecked)
            }
          />
        </span>
        {cluster.members.length > 2 && (
          <span className="ms-auto shrink-0 text-muted-foreground">
            +{cluster.members.length - 2}
          </span>
        )}
      </div>
      <div className="mt-4 flex items-center justify-between gap-3 text-xs">
        <span className="text-muted-foreground">
          {interpolate(c.memberCount, { count: String(cluster.members.length) })}
        </span>
        <span className="inline-flex items-center gap-1.5 font-medium text-primary">
          {c.networkGroups.open}
          <ArrowUpRight className="size-3.5 rtl:-rotate-90" />
        </span>
      </div>
    </Link>
  );
}
const NetworkGroup = memo(function NetworkGroup({ data }: NodeProps<NetworkGroupNode>) {
  return <NetworkGroupCard cluster={data.cluster} />;
});
const nodeTypes = { networkGroup: NetworkGroup };

/** One node per saved network ID. Sharing a provider never implies a routed connection. */
export function NetworkGroups({ clusters }: { clusters: ServerCluster[] }) {
  const { t } = useI18n();
  const c = t.servers.networks;
  const [nodes, setNodes, onNodesChange] = useNodesState<NetworkGroupNode>([]);
  const columns = Math.max(1, Math.min(3, Math.ceil(Math.sqrt(clusters.length))));
  const container = useRef<HTMLElement>(null);
  const [compact, setCompact] = useState(true);
  useEffect(() => {
    const element = container.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setCompact(entry.contentRect.width < 760);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    setNodes((previous) => {
      return clusters.map((cluster, index) => ({
        id: cluster.id,
        type: "networkGroup",
        style: { width: 320 },
        position: { x: (index % columns) * 380, y: Math.floor(index / columns) * 340 },
        measured: previous.find((node) => node.id === cluster.id)?.measured,
        data: { cluster },
      }));
    });
  }, [clusters, columns, setNodes]);
  return (
    <section
      ref={container}
      aria-label={c.networkGroups.label}
      className="@container/network-groups min-w-0 overflow-hidden rounded-2xl bg-muted/15"
    >
      <div className="px-5 pt-4 text-xs leading-relaxed text-muted-foreground">
        {c.networkGroups.hint}
      </div>
      {compact ? (
        <div className="grid gap-4 p-4 @xl/network-groups:grid-cols-2">
          {clusters.map((cluster) => (
            <NetworkGroupCard key={cluster.id} cluster={cluster} />
          ))}
        </div>
      ) : (
        <div
          style={{
            height: Math.min(760, Math.max(500, Math.ceil(clusters.length / columns) * 300 + 70)),
          }}
        >
          <ReactFlow<NetworkGroupNode>
            key={nodes.map((node) => node.id).join(":")}
            nodes={nodes}
            onNodesChange={onNodesChange}
            edges={[]}
            nodeTypes={nodeTypes}
            nodesConnectable={false}
            nodesDraggable={false}
            nodesFocusable={false}
            edgesReconnectable={false}
            deleteKeyCode={null}
            fitView
            fitViewOptions={{ padding: 0.2, maxZoom: 1 }}
            minZoom={0.1}
            maxZoom={1.5}
            panOnScroll={false}
            zoomOnScroll={false}
            preventScrolling={false}
            proOptions={{ hideAttribution: true }}
          >
            <FitNetworkView />
            <Background
              variant={BackgroundVariant.Dots}
              gap={22}
              size={1}
              color="var(--th-on-10)"
            />
            <Controls
              showInteractive={false}
              className="!overflow-hidden !rounded-xl !border-0 !shadow-none [&>button]:!border-border/30 [&>button]:!bg-popover [&>button]:!text-foreground [&_svg]:!fill-current"
            />
          </ReactFlow>
        </div>
      )}
    </section>
  );
}
