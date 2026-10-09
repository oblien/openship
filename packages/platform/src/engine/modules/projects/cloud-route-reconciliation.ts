import type { OrphanedResource } from "@repo/db";
import { getOblienClient } from "../../lib/oblien-client";

/** Legacy route-only checkpoints have no authority to delete provider resources. */
export function isUnboundRoute(orphan: OrphanedResource): boolean {
  return (
    orphan.resourceType === "route" &&
    !!orphan.projectId &&
    !orphan.serverId &&
    !orphan.targetKey &&
    orphan.payload == null &&
    (orphan.runtimeMode == null || orphan.runtimeMode === "docker")
  );
}

function hostname(value: string): string {
  return value.toLowerCase().replace(/\.$/, "");
}

/**
 * Read once per sweep, including disabled objects absent from the route registry.
 * This is a SaaS-only, read-only account inventory: filtering by today's mutable
 * organization namespace could falsely declare an older namespace's route gone.
 * No resource is deleted from a legacy hostname-only checkpoint.
 */
export function createCloudRouteReconciliation() {
  let inventory: Promise<Set<string>> | undefined;
  async function readInventory(): Promise<Set<string>> {
    const client = getOblienClient();
    const [routes, pages, proxies, tunnels] = await Promise.all([
      client.domain.routes(),
      client.pages.list(),
      client.edgeProxy.list(),
      client.edgeTunnel.list(),
    ]);
    if (
      !routes.success ||
      !pages.success ||
      !proxies.success ||
      !tunnels.success ||
      !Array.isArray(routes.data) ||
      !Array.isArray(pages.pages) ||
      !Array.isArray(proxies.proxies) ||
      !Array.isArray(tunnels.tunnels)
    ) {
      throw new Error("Cloud route inventory is incomplete; retaining cleanup reservations");
    }
    const names = new Set<string>();
    const add = (value: string) => {
      if (typeof value !== "string" || !value.trim())
        throw new Error("Cloud route inventory has an invalid hostname");
      names.add(hostname(value));
    };
    const addSlug = (slug: string, domain: string) => {
      if (typeof slug !== "string" || !slug || typeof domain !== "string" || !domain)
        throw new Error("Cloud route inventory has an invalid resource identity");
      add(`${slug}.${domain}`);
    };
    for (const route of routes.data) add(route.hostname);
    for (const page of pages.pages) {
      addSlug(page.slug, page.domain);
      if (page.custom_domain) add(page.custom_domain);
    }
    for (const proxy of proxies.proxies) addSlug(proxy.slug, proxy.domain);
    for (const tunnel of tunnels.tunnels) {
      if (tunnel.hostname) add(tunnel.hostname);
      else if (tunnel.is_custom) add(tunnel.domain);
      else addSlug(tunnel.slug, tunnel.domain);
    }
    return names;
  }
  return async (orphan: OrphanedResource): Promise<void> => {
    inventory ??= readInventory();
    if ((await inventory).has(hostname(orphan.ref))) {
      throw new Error(
        "Cloud hostname still has a provider owner; legacy cleanup lacks resource identity and will not delete it",
      );
    }
  };
}
