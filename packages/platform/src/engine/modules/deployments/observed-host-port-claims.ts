import type { HostPortTargetIdentity } from "../../lib/host-port-target";
import { isLoopbackHost } from "@repo/core";
import type { RuntimeAdapter } from "@repo/adapters";
import { reserveVerifiedTargetPinnedHostPort } from "./pinned-host-ports";

export interface ObservedLoopbackPublish {
  serviceId: string | null;
  /** Runtime identity to re-inspect before a quarantine can be reclaimed. */
  containerId?: string;
  containerPort: number;
  hostPort: number;
}

export type ObservedHostPortRuntime = Pick<RuntimeAdapter, "supports" | "getContainerInfo">;

function validPort(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0 && value <= 65_535;
}

/**
 * Describe a loopback upstream's owner. Parsing a URL does not prove ownership;
 * its runtime identity allows the reservation gate to verify a binding before
 * reclaiming quarantine. Bridge/container-IP routes consume no host port.
 */
export function observedLoopbackPublishFromUrl(input: {
  targetUrl: string | null | undefined;
  serviceId: string | null;
  containerId?: string | null;
  containerPort: number;
}): ObservedLoopbackPublish | null {
  if (!input.targetUrl || !validPort(input.containerPort)) return null;
  const hostPort = loopbackHostPortFromUrl(input.targetUrl);
  if (!hostPort) return null;
  return {
    serviceId: input.serviceId,
    ...(input.containerId ? { containerId: input.containerId } : {}),
    containerPort: input.containerPort,
    hostPort,
  };
}

/** The concrete physical host port a loopback HTTP(S) upstream dials. */
export function loopbackHostPortFromUrl(targetUrl: string | null | undefined): number | null {
  if (!targetUrl) return null;
  try {
    const url = new URL(targetUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    const hostname = url.hostname.replace(/^\[|\]$/g, "");
    if (!isLoopbackHost(hostname)) return null;
    const hostPort = url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
    if (!validPort(hostPort)) return null;
    return hostPort;
  } catch {
    return null;
  }
}

/**
 * Persist loopback publishes before registering edge routes, while holding the
 * physical-target lock. Quarantine recovery requires a fresh, exact binding from
 * the running container; cached values and a loopback URL alone are insufficient.
 * An exact repeat is idempotent. Another workload's claim still raises before
 * any route is written.
 */
export async function reserveObservedLoopbackPublishes(input: {
  target: HostPortTargetIdentity;
  projectId: string;
  runtime?: ObservedHostPortRuntime;
  publishes: Iterable<ObservedLoopbackPublish | null | undefined>;
  /**
   * The control plane's own dashboard port, passed only for the authorized
   * self-app route. The dashboard is a host process with no container to
   * inspect, and every other route is refused this reserved loopback port, so
   * its publish is the proof that recovers a quarantine there (#1019).
   */
  controlPlanePort?: number;
}): Promise<void> {
  const seen = new Set<string>();
  for (const publish of input.publishes) {
    if (!publish || !validPort(publish.containerPort) || !validPort(publish.hostPort)) continue;
    const key = `${publish.serviceId ?? ""}\0${publish.containerPort}\0${publish.hostPort}`;
    if (seen.has(key)) continue;
    seen.add(key);
    await reserveVerifiedTargetPinnedHostPort(
      input.target,
      {
        projectId: input.projectId,
        serviceId: publish.serviceId,
        containerPort: publish.containerPort,
        port: publish.hostPort,
      },
      async () => {
        // A loopback URL (including bare/host-network routing) is not proof of
        // ownership. Re-inspect under the target lock only when recovery is
        // needed; never reclaim from a cached row or an ambiguous scalar port.
        if (publish.serviceId === null && publish.hostPort === input.controlPlanePort) return true;
        if (!publish.containerId || !input.runtime?.supports("containerInfo")) return false;
        const live = await input.runtime.getContainerInfo(publish.containerId);
        return (
          live.status === "running" &&
          live.hostPortByContainerPort?.[publish.containerPort] === publish.hostPort
        );
      },
    );
  }
}

/**
 * Validate the concrete upstream URLs a route is about to publish and reserve
 * every loopback bind under its exact workload owner. Non-loopback URLs consume
 * no host TCP port and are ignored. A loopback URL without a stable physical
 * target is rejected: accepting it would recreate a host-global ownership guess.
 *
 * Keep this immediately before route registration. Allocation protects the
 * normal path; this is the final fail-closed gate if a resolver ever returns a
 * stale or mismatched publish.
 */
export async function reserveResolvedLoopbackRoutes(input: {
  target: HostPortTargetIdentity | null | undefined;
  projectId: string;
  runtime?: ObservedHostPortRuntime;
  routes: Iterable<{
    targetUrl: string | null | undefined;
    serviceId: string | null;
    containerId?: string | null;
    containerPort: number;
  }>;
}): Promise<void> {
  const publishes: ObservedLoopbackPublish[] = [];
  for (const route of input.routes) {
    const hostPort = loopbackHostPortFromUrl(route.targetUrl);
    if (!hostPort) continue;
    const publish = observedLoopbackPublishFromUrl(route);
    if (!publish) {
      throw new Error(
        `Refusing loopback route without a valid container-port owner for host port ${hostPort}`,
      );
    }
    publishes.push(publish);
  }
  if (publishes.length === 0) return;
  if (!input.target) {
    throw new Error("Refusing loopback route without a resolved physical host-port target");
  }
  await reserveObservedLoopbackPublishes({
    target: input.target,
    projectId: input.projectId,
    runtime: input.runtime,
    publishes,
  });
}
