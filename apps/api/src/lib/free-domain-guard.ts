import { ValidationError } from "@repo/core";
import {
  storedPublicEndpointsNeedCloud,
  type StoredPublicEndpoint,
} from "./public-endpoints";

/**
 * Operator write gate for public endpoints. Custom domains and HOST_DOMAIN
 * subdomains are allowed. `*.opsh.io` (Openship Cloud managed hostnames)
 * are rejected — there is no Cloud edge in Operator.
 */
export async function assertFreeEndpointsAllowed(
  _organizationId: string,
  endpoints:
    | Array<Pick<StoredPublicEndpoint, "domainType" | "domain" | "customDomain">>
    | null
    | undefined,
): Promise<void> {
  if (!storedPublicEndpointsNeedCloud(endpoints)) return;
  throw new ValidationError(
    "*.opsh.io subdomains are not available. Use a custom domain or this instance's host domain.",
  );
}
