import type { CloudCapability } from "@repo/core";
import { requireCloud } from "./cloud/require-cloud";
import { storedPublicEndpointsNeedCloud, type StoredPublicEndpoint } from "./public-endpoints";

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
  capability: CloudCapability = "managed-project-domain",
): Promise<void> {
  // Only custom domains in play → no Cloud edge needed.
  if (!storedPublicEndpointsNeedCloud(endpoints)) return;
  await requireCloud(capability, { organizationId });
}
