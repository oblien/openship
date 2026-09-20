import { Resolver } from "node:dns/promises";

/** Public recursive resolvers used for internet-view DNS checks. */
export const PUBLIC_DNS_SERVERS = ["1.1.1.1", "8.8.8.8"] as const;

export function createPublicDnsResolver(): Resolver {
  const resolver = new Resolver();
  resolver.setServers([...PUBLIC_DNS_SERVERS]);
  return resolver;
}
