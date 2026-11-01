"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { randomUUID } from "@/lib/random-uuid";
import { Icon } from "@repo/ui/icons";
import { reportCaughtError } from "@repo/core/diagnostics";
import { Button } from "@/components/ui/button";
import { useCloudResourceKey } from "@/context/CloudResourceContext";
import { usePlatform } from "@/context/PlatformContext";
import { systemApi } from "@/lib/api/system";

type Inspection = Awaited<ReturnType<typeof systemApi.inspectSwarm>>;

export function ServerSwarm({
  serverId,
  connected = false,
}: {
  serverId: string;
  connected?: boolean;
}) {
  const scope = useCloudResourceKey();
  const { selfHosted, deployMode } = usePlatform();
  if (!selfHosted && deployMode !== "desktop") return null;
  return <SwarmCard key={`${scope}:${serverId}`} serverId={serverId} connected={connected} />;
}

function SwarmCard({ serverId, connected }: { serverId: string; connected: boolean }) {
  const router = useRouter();
  const [connecting, setConnecting] = useState(false);
  const connectionRequest = useRef<string | null>(null);
  const [value, setValue] = useState<Inspection | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState(false);
  const request = useRef(0);
  const load = useCallback(
    async (details: boolean) => {
      const current = ++request.current;
      setLoading(true);
      setError(null);
      try {
        const next = await systemApi.inspectSwarm(serverId, details);
        if (request.current === current) setValue(next);
      } catch (cause) {
        reportCaughtError(cause, "dashboard/components/servers/ServerSwarm");
        if (request.current === current)
          setError(cause instanceof Error ? cause.message : "Could not inspect Docker Swarm.");
      } finally {
        if (request.current === current) setLoading(false);
      }
    },
    [serverId],
  );
  useEffect(() => {
    void load(false);
    return () => {
      request.current++;
    };
  }, [load]);

  if (value?.state === "inactive" && !error) return null;
  return (
    <section
      aria-label="Docker Swarm"
      aria-busy={loading}
      className="space-y-4 rounded-2xl bg-card p-5"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <span className="flex size-10 items-center justify-center rounded-xl bg-muted">
            <Icon name="cluster" className="size-5 text-muted-foreground" />
          </span>
          <div>
            <h3 className="font-medium">Docker Swarm</h3>
            <p className="text-sm text-muted-foreground">
              {value
                ? `${value.role === "manager" ? "Manager" : value.role === "worker" ? "Worker" : "Membership"} · ${value.state}`
                : loading
                  ? "Checking cluster membership…"
                  : "Inspection unavailable"}
            </p>
          </div>
        </div>
        <Button
          variant="secondary"
          size="sm"
          disabled={loading || connecting}
          onClick={() => void load(expanded)}
        >
          {loading ? "Checking…" : "Refresh"}
        </Button>
      </div>
      {error && (
        <div role="alert" className="space-y-1 text-sm text-danger">
          <p>{error}</p>
          {value && (
            <p className="text-muted-foreground">
              Showing the last successful observation. Refresh to try again.
            </p>
          )}
        </div>
      )}
      {value?.role === "worker" && (
        <div className="space-y-3 text-sm">
          <p className="text-muted-foreground">
            This server is a Swarm worker. Connect a manager to review the cluster’s stacks and
            nodes.
          </p>
          <Button asChild variant="secondary" size="sm">
            <Link href="/servers/new">Connect a manager</Link>
          </Button>
        </div>
      )}
      {value?.state === "active" && value.role === "manager" && (
        <>
          <p className="text-sm text-muted-foreground">
            {value.nodeCount ?? "Unknown"} nodes · {value.managerCount ?? "Unknown"} managers.
            Deploy new projects through Openship. Existing stacks stay under their current
            management.
          </p>
          {!connected && (
            <Button
              disabled={loading || connecting}
              onClick={async () => {
                if (connecting) return;
                const current = request.current;
                setConnecting(true);
                setError(null);
                connectionRequest.current ??= randomUUID();
                try {
                  const cluster = await systemApi.connectSwarm(serverId, {
                    name: "Docker Swarm",
                    requestId: connectionRequest.current,
                  });
                  if (request.current === current)
                    router.push(`/servers/clusters/${encodeURIComponent(cluster.id)}`);
                } catch (cause) {
                  reportCaughtError(cause, "dashboard/components/servers/ServerSwarm");
                  if (request.current === current)
                    setError(
                      cause instanceof Error ? cause.message : "Could not connect this Swarm.",
                    );
                } finally {
                  if (request.current === current) setConnecting(false);
                }
              }}
            >
              {connecting ? "Connecting…" : "Use for deployments"}
            </Button>
          )}
          <Button
            variant="secondary"
            size="sm"
            disabled={loading || connecting}
            aria-expanded={expanded}
            onClick={() => {
              setExpanded(!expanded);
              if (!expanded) void load(true);
            }}
          >
            {expanded ? "Hide stacks" : "Review stacks"}
          </Button>
          {expanded && value.inventory && (
            <div className="space-y-4">
              <div className="flex flex-wrap gap-2" aria-label="Swarm nodes">
                {value.inventory.nodes.map((node) => (
                  <span key={node.id} className="rounded-lg bg-muted/60 px-3 py-2 text-xs">
                    {node.name} · {node.role}
                    {node.leader ? " (leader)" : ""} · {node.state || "unknown"} ·{" "}
                    {node.availability || "unknown"}
                  </span>
                ))}
              </div>
              {value.inventory.stacks.length === 0 && (
                <p className="text-sm text-muted-foreground">No Swarm services on this cluster.</p>
              )}
              {value.inventory.stacks.map((stack) => (
                <div key={stack.name ?? ""} className="rounded-xl bg-card p-4">
                  <h4 className="mb-3 text-sm font-medium">
                    {stack.name ?? "Services outside a stack"}
                  </h4>
                  <ul className="divide-y divide-border/50">
                    {stack.services.map((service) => (
                      <li key={service.id} className="space-y-2 py-3 first:pt-0 last:pb-0">
                        <div className="flex flex-wrap justify-between gap-2 text-sm">
                          <span className="break-all font-medium">{service.name}</span>
                          <span className="text-muted-foreground">
                            {service.runningTasks ?? "?"} / {service.desiredTasks ?? "?"} tasks ·{" "}
                            {service.mode}
                          </span>
                        </div>
                        <p className="break-all font-mono text-xs text-muted-foreground">
                          {service.image}
                        </p>
                        {!!service.ports.length && (
                          <p className="text-xs text-muted-foreground">
                            Published ports:{" "}
                            {service.ports
                              .map(
                                (port) =>
                                  `${port.published} → ${port.target}/${port.protocol} (${port.mode || "ingress"})`,
                              )
                              .join(", ")}
                          </p>
                        )}
                        {!!service.mounts.length && (
                          <p className="break-all text-xs text-muted-foreground">
                            Mounts:{" "}
                            {service.mounts
                              .map(
                                (mount) =>
                                  `${mount.target} (${mount.type}${mount.readOnly ? ", read only" : ""})`,
                              )
                              .join(", ")}
                          </p>
                        )}
                        {service.updateState && (
                          <p className="text-xs text-muted-foreground">
                            Update: {service.updateState}
                          </p>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          )}
        </>
      )}
      {value && value.state !== "active" && value.state !== "inactive" && (
        <p className="text-sm text-muted-foreground">
          Swarm is not ready for inspection. Check this node’s Swarm state, then refresh.
        </p>
      )}
      {value && (
        <p className="text-xs text-muted-foreground">
          Last checked {new Date(value.observedAt).toLocaleString()}
        </p>
      )}
    </section>
  );
}
