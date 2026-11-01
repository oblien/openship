import type { CloudCapability } from "@repo/core";
import { normalizeComposeRoutingFields, type Service } from "@repo/db";
import { requireCloud } from "./cloud/require-cloud";
import { assertFreeSubdomainQuota } from "./plan-guard";
import type { CloudWorkspaceScope } from "./cloud-workspace-scope";
import {
  cloudManagedHostnameOf,
  publicEndpointHostname,
  resolveServicePublicEndpoints,
  storedPublicEndpointsNeedCloud,
  type StoredPublicEndpoint,
} from "./public-endpoints";

type ComposeRouteInput = Parameters<typeof normalizeComposeRoutingFields>[0] & {
  name: string;
  kind?: string | null;
  ports?: string[] | null;
};

/** Resolve the complete Compose write using the repository's merge rule. Raw
 * input alone misses inherited exposure, primary ports and secondary routes. */
export function composeEndpointChanges(parsed: readonly ComposeRouteInput[], stored: readonly Service[] = []) {
  const current = stored.filter(service => !service.kind || service.kind === "compose");
  const byName = new Map(current.map(service => [service.name, service]));
  return {
    endpoints: parsed.filter(service => !service.kind || service.kind === "compose").flatMap(service => {
      const previous = byName.get(service.name);
      return resolveServicePublicEndpoints({
        ...normalizeComposeRoutingFields(service, previous),
        ports: service.ports ?? previous?.ports ?? [],
      });
    }),
    knownHostnames: current.flatMap(service => resolveServicePublicEndpoints({ ...service, exposed: true }))
      .map(publicEndpointHostname),
  };
}

/**
 * Atomic gate for free (*.opsh.io) routes. A free managed subdomain only
 * resolves behind the Openship Cloud edge, so persisting one on a self-hosted
 * instance that isn't connected to Cloud creates a dead "Pending" route that
 * can never register. Call this at every user-facing write that can INTRODUCE a
 * free endpoint (route add/edit), BEFORE the DB write, so the write is atomic —
 * either the route can work or nothing is persisted.
 *
 * The client mirrors this exact rule via `useCloud().requireCloud`, so UI and
 * API can't disagree. This reuses the two single sources: the
 * `storedPublicEndpointsNeedCloud` predicate (only gate when a free route is in
 * play) and the shared `requireCloud` guard (SaaS-exempt + one connection-truth
 * + one error shape).
 */
export async function assertFreeEndpointsAllowed(
  organizationId: string,
  endpoints:
    | Array<Pick<StoredPublicEndpoint, "domainType" | "domain" | "customDomain">>
    | null
    | undefined,
  // Callers derive workspace ownership from the authorized server/project, never
  // an independent client selector. Losing it makes multi-server plans ambiguous.
  options: {
    capability?: CloudCapability;
    workspaceId?: CloudWorkspaceScope;
    /** Persisted route identities, including paused service routes. Editing or
     * removing them must not require a new connection or another domain slot. */
    knownHostnames?: Iterable<string | null | undefined>;
  } = {},
): Promise<void> {
  // Only custom domains in play → no Cloud edge needed.
  if (!storedPublicEndpointsNeedCloud(endpoints)) return;
  const known = new Set(Array.from(options.knownHostnames ?? [])
    .filter((hostname): hostname is string => !!hostname)
    .map(hostname => hostname.trim().toLowerCase()));
  const candidates = (endpoints ?? []).map(cloudManagedHostnameOf)
    .filter((hostname): hostname is string => !!hostname && !known.has(hostname.toLowerCase()));
  if (!candidates.length) return;
  await requireCloud(options.capability ?? "managed-project-domain", { organizationId });

  // Then the plan allowance. Order matters: "connect Cloud" must be answered
  // before "you've used all 10", because an unconnected instance can't have a
  // free route at all and the connect prompt is the actionable one. A quota
  // refusal is deliberately NOT a CloudRequiredError — that error's copy sends
  // the user to a connect-Cloud flow which, for an already-connected org, would
  // succeed and change nothing.
  await assertFreeSubdomainQuota(
    organizationId,
    candidates,
    options.workspaceId,
  );
}
