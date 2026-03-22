import { syncEdgeProxy } from "./cloud-client";
import { resolveServerHost } from "./server-target";

/**
 * Ensure an Oblien edge proxy exists for a managed deploy slug.
 *
 * Sends slug + target IP to the SaaS. The SaaS owns domain construction
 * and Oblien credentials.
 */
export async function ensureManagedEdgeProxy(
  userId: string,
  slug: string,
  opts?: { serverId?: string },
): Promise<void> {
  if (!slug.trim()) return;

  const target = await resolveServerHost(opts?.serverId);
  if (!target) {
    throw new Error("Cannot configure edge proxy: target host could not be resolved");
  }
  await syncEdgeProxy(userId, slug, target);
}