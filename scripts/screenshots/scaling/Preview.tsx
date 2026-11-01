"use client";

import { useEffect, useState } from "react";
import { Icon, type IconName } from "@repo/ui/icons";
import { Logo } from "@/components/logo";
import { Button } from "@/components/ui/button";
import { ScalePage } from "@/components/scale/ScalePage";
import {
  createService,
  parseDraft,
  type ClusterResource,
  type ScaleDraft,
} from "@/components/scale/topology";
import { getClusterTopology } from "@/components/scale/clusterTopology";

// This fixture is copied into a temporary development route by capture.mjs.
// It never reads projects or provisions resources. All state stays in this
// capture browser's localStorage; the application's editor is reused unchanged.
const storageKey = "openship:screenshot:commerce-scaling";
const servers = [
  { name: "production-eu-01", ip: "10.44.0.11" },
  { name: "production-eu-02", ip: "10.44.0.12" },
  { name: "production-eu-03", ip: "10.44.0.13" },
];
const orders: ClusterResource = {
  id: "orders", name: "Orders", kind: "postgres", mode: "cluster",
  region: "eu-west-1", position: { x: 850, y: 0 }, replicas: 2, failover: true,
};
const ordersTopology = getClusterTopology(orders);
orders.topology = {
  nodes: ordersTopology.nodes.map((member, index) => ({
    ...member,
    name: `orders-eu-0${index + 1}`,
    position: index === 0 ? { x: 0, y: 145 } : { x: 480, y: (index - 1) * 290 },
  })),
  edges: ordersTopology.edges,
};
const sessions: ClusterResource = {
  id: "sessions", name: "Sessions", kind: "redis", mode: "cluster",
  region: "eu-west-1", position: { x: 850, y: 350 }, shards: 3, replicasPerShard: 1,
};
const sessionsTopology = getClusterTopology(sessions);
sessions.topology = {
  nodes: sessionsTopology.nodes.map((member) => ({
    ...member,
    name: member.role === "primary" ? `sessions-${member.shard}` : `sessions-${member.shard}-replica`,
    position: { x: member.role === "primary" ? 0 : 480, y: (member.shard - 1) * 225 },
  })),
  edges: sessionsTopology.edges,
};
const draft: ScaleDraft = {
  version: 2,
  services: [{ ...createService("api", "commerce-api"), cpu: 2, memory: 2048, port: 3000 }],
  nodes: [
    {
      id: "edge", name: "OpenShip Edge", kind: "edge", region: "eu-west-1",
      position: { x: 0, y: 235 }, tls: true, algorithm: "round-robin",
      healthPath: "/health", healthInterval: 10,
    },
    ...servers.map((_server, index) => ({
      id: `api-${index + 1}`, name: `commerce-api-${index + 1}`, kind: "service" as const,
      serviceId: "api", ordinal: index + 1, region: "eu-west-1",
      position: { x: 390, y: 15 + index * 220 },
    })),
    orders, sessions,
  ],
  edges: servers.flatMap((_server, index) => [
    { id: `edge-api-${index + 1}`, source: "edge", target: `api-${index + 1}` },
    { id: `api-${index + 1}-orders`, source: `api-${index + 1}`, target: "orders" },
    { id: `api-${index + 1}-sessions`, source: `api-${index + 1}`, target: "sessions" },
  ]),
};

const nav: { icon: IconName; label: string }[] = [
  { icon: "home", label: "Overview" },
  { icon: "folder", label: "Projects" },
  { icon: "server", label: "Servers" },
  { icon: "globe", label: "Domains" },
  { icon: "chart-line", label: "Monitoring" },
  { icon: "database-backup", label: "Backups" },
];

export default function Preview({ zoomed = false }: { zoomed?: boolean }) {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    // Bring the same nodes a little closer together for the enlarged capture,
    // leaving room for the actual editor's toolbar and zoom controls.
    const captureDraft: ScaleDraft = zoomed ? {
      ...draft,
      nodes: draft.nodes.map((node) => {
        if (node.kind === "edge") return { ...node, position: { x: 0, y: 225 } };
        if (node.kind === "service") return {
          ...node, position: { x: 375, y: 55 + (node.ordinal - 1) * 170 },
        };
        if (node.kind === "postgres") return { ...node, position: { x: 820, y: 0 } };
        return {
          ...node,
          position: { x: 820, y: 310 },
          topology: {
            ...sessions.topology!,
            nodes: sessions.topology!.nodes.map((member) => ({
              ...member, position: { ...member.position, y: (member.shard - 1) * 180 },
            })),
          },
        };
      }),
    } : draft;
    const serialized = JSON.stringify(captureDraft);
    if (!parseDraft(serialized)) throw new Error("The screenshot topology is invalid.");
    localStorage.setItem(storageKey, serialized);
    setReady(true);
  }, [zoomed]);

  return (
    <div className="flex h-dvh overflow-hidden bg-background text-foreground" data-scaling-capture>
      <aside className="flex w-[72px] shrink-0 flex-col items-center border-r border-border/50 py-6">
        <Logo size={29} />
        <nav className="mt-9 flex flex-col gap-3" aria-label="Main navigation">
          {nav.map(({ icon, label }) => (
            <Button key={label} variant="ghost" size="icon" title={label}
              aria-label={label} className={label === "Servers" ? "bg-accent text-foreground" : ""}>
              <Icon name={icon} className="size-5" />
            </Button>
          ))}
        </nav>
        <div className="mt-auto flex flex-col items-center gap-4">
          <Button variant="ghost" size="icon" aria-label="Settings"><Icon name="settings" /></Button>
          <div className="flex size-9 items-center justify-center rounded-full bg-accent text-sm font-medium">C</div>
        </div>
      </aside>
      <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <header className="flex shrink-0 items-center justify-between px-8 pb-5 pt-6">
          <div>
            <div className="mb-3 flex items-center gap-2 text-sm text-muted-foreground">
              <Icon name="server" className="size-4" />
              <span>Server clusters</span><Icon name="chevron-right" className="size-3" />
              <span className="text-foreground/80">Production cluster</span>
            </div>
            <div className="flex items-center gap-3">
              <h1 className="text-2xl font-semibold tracking-tight">Commerce API</h1>
              <span className="rounded-lg bg-accent px-2.5 py-1 text-xs text-muted-foreground">Production</span>
            </div>
          </div>
          <div className="flex items-center gap-5 text-sm text-muted-foreground">
            <span className="flex items-center gap-2"><Icon name="server" className="size-4" />3 servers</span>
            <span className="h-5 w-px bg-border" />
            <span className="flex items-center gap-2"><Icon name="shield-check" className="size-4 text-success" />Private network</span>
          </div>
        </header>
        <div className="mx-8 flex shrink-0 items-center gap-7 border-b border-border/60 text-sm">
          {["Topology", "Deployments", "Environment", "Settings"].map((label) => (
            <span key={label} className={`border-b-2 pb-3 ${label === "Topology" ? "border-foreground font-medium text-foreground" : "border-transparent text-muted-foreground"}`}>{label}</span>
          ))}
          <span className="ms-auto pb-3 text-xs text-muted-foreground">3 app instances / 2 database clusters</span>
        </div>
        <div className="min-h-0 flex-1 px-5 pt-2">{ready && <ScalePage storageKey={storageKey} />}</div>
        <footer className="mx-8 mb-5 mt-1 grid shrink-0 grid-cols-3 divide-x divide-border/70 rounded-xl bg-card py-4">
          {servers.map((server) => (
            <div key={server.name} className="flex items-center gap-3 px-5">
              <Icon name="server" className="size-5 text-muted-foreground" />
              <div>
                <p className="text-sm font-medium">{server.name}<span className="mx-2 font-normal text-muted-foreground/40">/</span><span className="font-mono text-xs font-normal text-muted-foreground">{server.ip}</span></p>
                <p className="mt-1 text-xs text-muted-foreground">EU West<span className="mx-2">/</span>8 vCPU<span className="mx-2">/</span>32 GB memory</p>
              </div>
            </div>
          ))}
        </footer>
      </main>
    </div>
  );
}
