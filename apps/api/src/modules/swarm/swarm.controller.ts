/** Thin HTTP boundary for the read-only Swarm discovery service. */

import type { Context } from "hono";
import { audit, auditContextFrom } from "../../lib/audit";
import { getRequestContext } from "../../lib/request-context";
import { swarmDiscovery } from "./swarm.service";
import { swarmEdge } from "./swarm-edge.service";
import { buildSwarmDiscoveryView } from "./swarm-discovery-view";

function target(c: Context) {
  const ctx = getRequestContext(c);
  return { serverId: c.req.param("serverId")!, organizationId: ctx.organizationId, ctx };
}

export async function probe(c: Context) {
  const { serverId, organizationId, ctx } = target(c);
  const manager = await swarmDiscovery.probe(serverId, organizationId);
  // Manager access is an operationally meaningful boundary, even though it is
  // read-only. Do not record every polling view below, which would drown the
  // audit log; a deliberate probe remains attributable to the caller.
  audit.recordAsync(auditContextFrom(c, organizationId, ctx.userId), {
    eventType: "swarm.manager.probed",
    resourceType: "server",
    resourceId: serverId,
    after: { clusterId: manager.clusterId, nodeId: manager.nodeId },
  });
  return c.json({ manager });
}

export async function summary(c: Context) {
  const { serverId, organizationId } = target(c);
  return c.json(await swarmDiscovery.summary(serverId, organizationId));
}

export async function nodes(c: Context) {
  const { serverId, organizationId } = target(c);
  const snapshot = await swarmDiscovery.discover(serverId, organizationId);
  return c.json({ nodes: snapshot.nodes, observedAt: snapshot.observedAt, diagnostics: snapshot.diagnostics });
}

export async function stacks(c: Context) {
  const { serverId, organizationId } = target(c);
  const snapshot = await swarmDiscovery.discover(serverId, organizationId);
  return c.json(buildSwarmDiscoveryView(snapshot));
}

export async function stack(c: Context) {
  const { serverId, organizationId } = target(c);
  return c.json(await swarmDiscovery.stack(serverId, organizationId, c.req.param("stackName")!));
}

export async function stackServices(c: Context) {
  const { serverId, organizationId } = target(c);
  const found = await swarmDiscovery.stack(serverId, organizationId, c.req.param("stackName")!);
  return c.json({ services: found.services, observedAt: found.observedAt, diagnostics: found.diagnostics });
}

export async function stackTasks(c: Context) {
  const { serverId, organizationId } = target(c);
  const found = await swarmDiscovery.stack(serverId, organizationId, c.req.param("stackName")!);
  return c.json({ tasks: found.tasks, observedAt: found.observedAt, diagnostics: found.diagnostics });
}

export async function networks(c: Context) {
  const { serverId, organizationId } = target(c);
  const snapshot = await swarmDiscovery.discover(serverId, organizationId);
  return c.json({ networks: snapshot.networks, observedAt: snapshot.observedAt, diagnostics: snapshot.diagnostics });
}

export async function volumes(c: Context) {
  const { serverId, organizationId } = target(c);
  const snapshot = await swarmDiscovery.discover(serverId, organizationId);
  return c.json({ volumes: snapshot.volumes, observedAt: snapshot.observedAt, diagnostics: snapshot.diagnostics });
}

export async function configs(c: Context) {
  const { serverId, organizationId } = target(c);
  const snapshot = await swarmDiscovery.discover(serverId, organizationId);
  return c.json({ configs: snapshot.configs, observedAt: snapshot.observedAt, diagnostics: snapshot.diagnostics });
}

export async function secrets(c: Context) {
  const { serverId, organizationId } = target(c);
  const snapshot = await swarmDiscovery.discover(serverId, organizationId);
  // The adapter only lists id/name/labels/createdAt. It never inspects secret
  // objects, so contents cannot reach this controller or its DTO.
  return c.json({ secrets: snapshot.secrets, observedAt: snapshot.observedAt, diagnostics: snapshot.diagnostics });
}

/** Cluster singleton status; no project stack operation implicitly creates it. */
export async function edgeStatus(c: Context) {
  const { serverId, organizationId } = target(c);
  return c.json({ edge: await swarmEdge.status(serverId, organizationId) });
}

/** Explicit operator action only. Normal stack claim/deploy never calls this. */
export async function ensureEdge(c: Context) {
  const { serverId, organizationId, ctx } = target(c);
  const edge = await swarmEdge.ensure(serverId, organizationId);
  audit.recordAsync(auditContextFrom(c, organizationId, ctx.userId), {
    eventType: "swarm.edge.enabled",
    resourceType: "server",
    resourceId: serverId,
    after: { serviceId: edge.serviceId, networkName: edge.networkName, nodeIds: edge.nodeIds },
  });
  return c.json({ edge }, 201);
}
