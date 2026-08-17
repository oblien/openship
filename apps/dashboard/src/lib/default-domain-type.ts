/**
 * Which domain type a NEW endpoint should open on.
 *
 * Operator has no Openship Cloud edge. A HOST_DOMAIN setting makes a
 * managed subdomain of the operator's own domain available (`free`);
 * otherwise new endpoints default to a custom domain.
 */
export function defaultDomainType(hasHostDomain: boolean): "free" | "custom" {
  return hasHostDomain ? "free" : "custom";
}
