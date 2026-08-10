/**
 * Shared pieces of "serialize a public endpoint (a domain + what it routes to)"
 * for the dashboard's four payload builders.
 *
 * There were four near-identical copies: the project Domains tab and the deploy
 * wizard's Domains step (byte-for-byte the same), plus two in the deploy build
 * payload. Each enumerated the fields it sent, so adding a field to
 * `PublicEndpoint` meant finding all four — and missing one silently drops it on
 * that path. The canonical-redirect work hit that twice: a save and a deploy that
 * each cleared a redirect the UI was showing.
 *
 * The two save builders were identical, so they collapse into
 * `validatedPublicEndpointPayload`. The two deploy builders genuinely differ in
 * wire shape and can't be merged without lying to one of the APIs:
 *   • the project API takes `port` as a NUMBER (project.schema.ts
 *     PublicEndpointSchema); the build API takes a STRING (deployment.schema.ts
 *     PublicEndpointInput);
 *   • the build payload's `domain`/`customDomain` are required strings, the
 *     project's are optional.
 * They keep their own shapes and share `redirectPayloadFields`, which is the part
 * that's easy to forget — so a new routing field is added in ONE place.
 */

import { normalizeCustomHostname } from "@repo/core";

import type { PublicEndpoint } from "@/context/deployment/types";

/**
 * The hostname an endpoint resolves to, or "" while it's still blank.
 *
 * Accepts a pre-resolved `hostname` (what the API's ProjectRouteEndpoint carries)
 * so the project Domains tab and the routing card agree — they each had their own
 * copy of this, and a redirect target list built from a different answer than the
 * one the save matches on would offer targets that don't exist.
 */
export function resolvePublicEndpointHostname(
  endpoint: Partial<PublicEndpoint> & { hostname?: string },
  baseDomain: string,
): string {
  if (typeof endpoint.hostname === "string" && endpoint.hostname.trim()) {
    return endpoint.hostname.trim().toLowerCase();
  }
  if (endpoint.domainType === "custom") {
    return endpoint.customDomain?.trim().toLowerCase() || "";
  }
  const slug = endpoint.domain?.trim().toLowerCase();
  return slug ? `${slug}.${baseDomain}` : "";
}

/**
 * The canonical-redirect half of any endpoint payload, or `{}` when the endpoint
 * serves the app — so a serving endpoint's payload is byte-identical to what it
 * was before redirects existed.
 *
 * Every payload path must include this: the submitted endpoint list is
 * authoritative, so an OMITTED redirect CLEARS a stored one. That's how "stop
 * redirecting" is expressed, and it's why dropping this turns an unrelated save
 * or deploy into a silent "serve the app on both hostnames".
 */
export function redirectPayloadFields(
  endpoint: Pick<PublicEndpoint, "redirectTo" | "redirectStatus">,
): { redirectTo?: string; redirectStatus?: number } {
  return endpoint.redirectTo
    ? { redirectTo: endpoint.redirectTo, redirectStatus: endpoint.redirectStatus ?? 301 }
    : {};
}

export interface ValidatedPublicEndpointPayload {
  port?: number;
  targetPath?: string;
  domain?: string;
  customDomain?: string;
  domainType: "free" | "custom";
  redirectTo?: string;
  redirectStatus?: number;
}

/**
 * Serialize an endpoint for a SAVE (`projectsApi.update`): normalizes the hostname
 * and returns null for a row that isn't complete enough to persist — no hostname,
 * or a server route with no valid port. Callers treat null as "don't save this;
 * tell the user to finish the row".
 */
export function validatedPublicEndpointPayload(
  endpoint: PublicEndpoint,
  hasServer: boolean,
): ValidatedPublicEndpointPayload | null {
  const domainType: "free" | "custom" = endpoint.domainType === "custom" ? "custom" : "free";
  const freeDomain = endpoint.domain.trim().toLowerCase();
  // The SAME normalizer the API stores with, so a pasted `https://example.com/`
  // saves as `example.com` instead of being rejected as a bogus hostname.
  const customDomain = normalizeCustomHostname(endpoint.customDomain);

  if (domainType === "custom" && !customDomain) return null;
  if (domainType === "free" && !freeDomain) return null;

  const host = domainType === "custom" ? { customDomain } : { domain: freeDomain };

  if (hasServer) {
    const port = Number(endpoint.port.trim());
    if (!Number.isFinite(port) || port < 1 || port > 65535) return null;
    return { port, domainType, ...host, ...redirectPayloadFields(endpoint) };
  }

  return {
    targetPath: endpoint.targetPath.trim() || "/",
    domainType,
    ...host,
    ...redirectPayloadFields(endpoint),
  };
}
