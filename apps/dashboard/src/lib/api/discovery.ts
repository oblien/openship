import { api } from "./client";
import type {
  DiscoveryConfigureInput,
  DiscoveryRescan,
  DiscoveryService,
  DiscoveryStatus,
} from "@repo/contracts";

/**
 * Server container discovery (docs/docker-service-discovery-plan.md).
 *
 * Service keys are stable discovery identities (`id:my-app`, `compose:proj/serv`)
 * and travel in the URL path — they MUST be fully encoded (`/` and `:` are
 * meaningful to the router); Hono decodes the segment server-side.
 *
 * `rescan` runs a full scan → reconcile → repair pass (and can order a
 * certificate) through the serialized per-server sweep queue, so it may take
 * far longer than the default 15s request timeout; dedupe is off because two
 * intentional rescans must not collapse into one.
 */
export const discoveryApi = {
  status: (serverId: string, opts?: { signal?: AbortSignal }) =>
    api.get<DiscoveryStatus>(
      `discovery/servers/${encodeURIComponent(serverId)}/discovery`,
      opts,
    ),
  configure: (serverId: string, input: DiscoveryConfigureInput) =>
    api.put<DiscoveryStatus>(
      `discovery/servers/${encodeURIComponent(serverId)}/discovery`,
      input,
    ),
  rescan: (serverId: string) =>
    api.post<DiscoveryRescan>(
      `discovery/servers/${encodeURIComponent(serverId)}/discovery/rescan`,
      undefined,
      { timeout: 180_000, dedupe: false },
    ),
  suppress: (serverId: string, serviceKey: string) =>
    api.post<DiscoveryService>(
      `discovery/servers/${encodeURIComponent(serverId)}/discovery/services/${encodeURIComponent(serviceKey)}/suppress`,
    ),
  unsuppress: (serverId: string, serviceKey: string) =>
    api.post<DiscoveryService>(
      `discovery/servers/${encodeURIComponent(serverId)}/discovery/services/${encodeURIComponent(serviceKey)}/unsuppress`,
    ),
  forget: (serverId: string, serviceKey: string) =>
    api.delete<{ forgotten: boolean }>(
      `discovery/servers/${encodeURIComponent(serverId)}/discovery/services/${encodeURIComponent(serviceKey)}`,
    ),
};

export type { DiscoveryConfigureInput, DiscoveryRescan, DiscoveryService, DiscoveryStatus };
