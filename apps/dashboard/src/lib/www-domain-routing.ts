import { isApexDomain, normalizeCustomHostname } from "@repo/core";
import { createPublicEndpoint, type PublicEndpoint } from "@/context/deployment/types";

export type WwwDomainMode = "apex" | "www" | "both";
const hostname = (endpoint: PublicEndpoint) =>
  endpoint.domainType === "custom" ? normalizeCustomHostname(endpoint.customDomain) : "";

/** The endpoint fields are the saved state; there is no separate www-mode flag. */
export function getWwwDomainRouting(endpoints: readonly PublicEndpoint[]) {
  const first = endpoints.find((endpoint) => hostname(endpoint));
  if (!first) return null;
  const apex = hostname(first).replace(/^www\./, "");
  if (!isApexDomain(apex)) return null;
  const bare = endpoints.find((endpoint) => hostname(endpoint) === apex);
  const www = endpoints.find((endpoint) => hostname(endpoint) === `www.${apex}`);
  const included = Boolean(bare && www);
  const mode: WwwDomainMode | null =
    www?.redirectTo === apex && !bare?.redirectTo
      ? "apex"
      : bare?.redirectTo === `www.${apex}` && !www?.redirectTo
        ? "www"
        : included && !bare?.redirectTo && !www?.redirectTo
          ? "both"
          : null;
  return { apex, bare, www, included, mode };
}

/** Apply a whole pair in one update, clearing the old direction before switching. */
export function setWwwDomainRouting(
  endpoints: readonly PublicEndpoint[],
  mode: WwwDomainMode,
): PublicEndpoint[] {
  const pair = getWwwDomainRouting(endpoints);
  if (!pair) return [...endpoints];
  const source = pair.bare ?? pair.www!;
  const bare =
    pair.bare ?? createPublicEndpoint({ ...source, id: undefined, customDomain: pair.apex });
  const www =
    pair.www ??
    createPublicEndpoint({ ...source, id: undefined, customDomain: `www.${pair.apex}` });
  const servingHost = mode === "www" ? `www.${pair.apex}` : pair.apex;
  const servingEndpoint = [pair.bare, pair.www].find((endpoint) => endpoint && !endpoint.redirectTo);
  const next = endpoints.filter((endpoint) => endpoint.id !== bare.id && endpoint.id !== www.id);
  const normal = (endpoint: PublicEndpoint): PublicEndpoint => ({
    ...endpoint,
    // API-created redirects may have no upstream. Reuse the pair's serving target.
    port: endpoint.port || servingEndpoint?.port || "",
    targetPath: endpoint.targetPath || servingEndpoint?.targetPath || "/",
    redirectTo: "",
    redirectStatus: undefined,
  });
  const selectedBare =
    mode === "www" ? { ...bare, redirectTo: servingHost, redirectStatus: 301 } : normal(bare);
  const selectedWww =
    mode === "apex" ? { ...www, redirectTo: servingHost, redirectStatus: 301 } : normal(www);
  // Primary is a serving hostname. Other domains and their targets stay intact.
  return mode === "www"
    ? [selectedWww, selectedBare, ...next]
    : [selectedBare, selectedWww, ...next];
}

export function toggleWwwDomainRouting(
  endpoints: readonly PublicEndpoint[],
  on: boolean,
  allowRedirects = true,
): PublicEndpoint[] {
  const pair = getWwwDomainRouting(endpoints);
  if (!pair || (on && pair.included)) return [...endpoints];
  if (on)
    return setWwwDomainRouting(
      endpoints,
      !allowRedirects ? "both" : pair.www && !pair.bare ? "www" : "apex",
    );
  const primary = pair.mode === "www" ? pair.www : (pair.bare ?? pair.www);
  const removed = primary?.id === pair.www?.id ? pair.bare : pair.www;
  if (!removed) return [...endpoints];
  const removedHost = hostname(removed);
  return endpoints
    .filter((endpoint) => endpoint.id !== removed.id)
    .map((endpoint) =>
      endpoint.redirectTo === removedHost
        ? { ...endpoint, redirectTo: "", redirectStatus: undefined }
        : endpoint,
    );
}
