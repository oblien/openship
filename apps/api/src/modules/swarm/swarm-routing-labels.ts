/** Safe, read-only routing metadata extracted from a Swarm service spec. */

export interface SwarmRoutingLabel {
  key: string;
  value: string | null;
  redacted: boolean;
}

const ROUTER_LABEL = /^(?:traefik\.|caddy(?:[._]|$)|haproxy\.|nginx(?:[._-]|$)|com\.github\.jrcs\.(?:letsencrypt_)?nginx_proxy_companion\.)/i;
const SECRET_LABEL = /(?:credential|password|secret|token|api[-_]?key|private[-_]?key)/i;
const MAX_ROUTING_LABELS = 50;
const MAX_ROUTING_LABEL_VALUE_LENGTH = 1_024;

function isRouterLabel(key: string): boolean {
  return ROUTER_LABEL.test(key) || /(?:^|[._-])routers?(?:[._-]|$)/i.test(key);
}

/**
 * Labels stay on the manager as the source of truth. Detail endpoints expose
 * just recognised routing metadata so normal labels cannot accidentally become
 * a second, unbounded secret/configuration API.
 */
export function readSwarmRoutingLabels(labels: Record<string, string>): SwarmRoutingLabel[] {
  return Object.entries(labels)
    .filter(([key]) => isRouterLabel(key))
    .sort(([left], [right]) => left.localeCompare(right))
    .slice(0, MAX_ROUTING_LABELS)
    .map(([key, value]) => {
      const redacted = SECRET_LABEL.test(key);
      return {
        key,
        value: redacted ? null : value.slice(0, MAX_ROUTING_LABEL_VALUE_LENGTH),
        redacted,
      };
    });
}

/** Extract only syntactically valid hostnames from common router label forms. */
export function inferSwarmRoutingUrls(routingLabels: SwarmRoutingLabel[]): string[] {
  const hosts = new Set<string>();
  const host = /^(?:(?:Host|host)\(\s*[`"']([^`"']+)[`"']\s*\)|\s*(?:https?:\/\/)?([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+)\s*)$/i;
  for (const label of routingLabels) {
    if (!label.value) continue;
    const match = host.exec(label.value);
    const candidate = match?.[1] ?? match?.[2];
    if (candidate) hosts.add(`https://${candidate.toLowerCase()}`);
  }
  return [...hosts].sort((left, right) => left.localeCompare(right));
}
