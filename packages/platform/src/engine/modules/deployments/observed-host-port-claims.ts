import type { HostPortTargetIdentity } from "../../lib/host-port-target";
import { isLoopbackHost } from "@repo/core";
import { reserveTargetPinnedHostPort } from "./pinned-host-ports";

export interface ObservedLoopbackPublish {
  serviceId: string | null;
  containerPort: number;
  hostPort: number;
}

function validPort(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0 && value <= 65_535;
}

/**
 * Turn one route upstream into the exact durable ownership tuple it proves.
 * Bridge/container-IP routes are deliberately ignored: only a loopback URL
 * observes a bind in the physical host's TCP namespace.
 */
export function observedLoopbackPublishFromUrl(input: {
  targetUrl: string | null | undefined;
  serviceId: string | null;
  containerPort: number;
}): ObservedLoopbackPublish | null {
  if (!input.targetUrl || !validPort(input.containerPort)) return null;
  const hostPort = loopbackHostPortFromUrl(input.targetUrl);
  if (!hostPort) return null;
  return {
    serviceId: input.serviceId,
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
 * Persist every loopback publish observed from live Docker/route state before a
 * caller registers an edge route to it. The repository's unique indexes are the
 * final arbiter: an exact repeat is idempotent; another owner raises and the
 * caller must fail closed. Nothing here catches or overwrites that conflict.
 */
export async function reserveObservedLoopbackPublishes(input: {
  target: HostPortTargetIdentity;
  projectId: string;
  publishes: Iterable<ObservedLoopbackPublish | null | undefined>;
}): Promise<void> {
  const seen = new Set<string>();
  for (const publish of input.publishes) {
    if (!publish || !validPort(publish.containerPort) || !validPort(publish.hostPort)) continue;
    const key = `${publish.serviceId ?? ""}\0${publish.containerPort}\0${publish.hostPort}`;
    if (seen.has(key)) continue;
    seen.add(key);
    await reserveTargetPinnedHostPort(input.target, {
      projectId: input.projectId,
      serviceId: publish.serviceId,
      containerPort: publish.containerPort,
      port: publish.hostPort,
    });
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
  routes: Iterable<{
    targetUrl: string | null | undefined;
    serviceId: string | null;
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
    publishes,
  });
}
