/**
 * DNS provider registry.
 *
 * One map is the single source of truth. Descriptors are read OFF the providers
 * rather than kept in a parallel literal — a hand-maintained second list is how
 * a registered provider ends up invisible in the dashboard picker.
 */

import type { DnsProvider, DnsProviderDescriptor, DnsProviderName } from "./types";
import { UnknownDnsProviderError } from "./types";
import { cloudflareDnsProvider } from "./providers/cloudflare.provider";

const PROVIDERS: Record<DnsProviderName, DnsProvider> = {
  cloudflare: cloudflareDnsProvider,
};

export function resolveDnsProvider(name: string): DnsProvider {
  const hit = PROVIDERS[name as DnsProviderName];
  if (!hit) throw new UnknownDnsProviderError(name);
  return hit;
}

export function listDnsProviders(): DnsProviderName[] {
  return Object.keys(PROVIDERS) as DnsProviderName[];
}

export function describeDnsProviders(): DnsProviderDescriptor[] {
  return listDnsProviders().map((name) => PROVIDERS[name].descriptor);
}
