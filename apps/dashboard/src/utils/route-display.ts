import { resolveServiceHostnameLabel } from "@repo/core";

/** A service row, as far as routing DISPLAY is concerned. */
type RoutedService = {
  exposed?: boolean | null;
  domainType?: string | null;
  customDomain?: string | null;
  domain?: string | null;
};

/**
 * The hostname a service is allowed to be SHOWN on: its custom domain, or the
 * free subdomain it actually has. Null when it has neither.
 *
 * An exposed service with no chosen subdomain is reachable on its PORT, not on a
 * hostname — but `resolveServiceHostnameLabel` will happily DERIVE
 * `<project>-<service>` when handed no explicit slug. Four surfaces called it
 * that way and printed the result (two of them as a clickable link), so a
 * service with no route at all advertised a host nobody had created while the
 * project's own Domains page correctly showed none. A route exists because a
 * human chose it and it was persisted; display never invents one.
 */
export function serviceDisplayHost(
  service: RoutedService,
  opts: { projectLabel: string; baseDomain: string; kind?: "compose" | "monorepo" },
): string | null {
  if (!service.exposed) return null;
  if (service.domainType === "custom") return service.customDomain?.trim() || null;
  const slug = service.domain?.trim();
  if (!slug || !opts.baseDomain) return null;
  // An explicit slug short-circuits the derivation inside the resolver, so the
  // label here is exactly the one the backend registers the route under.
  const label = resolveServiceHostnameLabel(opts.projectLabel, "", slug, opts.kind ?? "compose");
  return `${label}.${opts.baseDomain}`;
}

/** `https://<host>` for a service that has a route, else null. */
export function serviceDisplayUrl(
  service: RoutedService,
  opts: { projectLabel: string; baseDomain: string; kind?: "compose" | "monorepo" },
): string | null {
  const host = serviceDisplayHost(service, opts);
  return host ? `https://${host}` : null;
}
