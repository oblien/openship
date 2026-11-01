import type { AppEndpoint, EndpointMode } from "@repo/core";
import { createPublicEndpoint, type PublicEndpoint } from "@/context/deployment/types";
import { defaultDomainType } from "./default-domain-type";

export type AppEndpointExposure =
  | { kind: "http"; mode: "port" | "domain"; ep: PublicEndpoint }
  | { kind: "tcp"; mode: "publish" | "internal" };

/** Only offer modes that fit both the protocol and the template's restrictions. */
export function getAppEndpointModes(endpoint: AppEndpoint): EndpointMode[] {
  const modes: EndpointMode[] =
    endpoint.kind === "http" ? ["domain", "port"] : ["publish", "internal"];
  return modes.filter((mode) => !endpoint.allowedModes || endpoint.allowedModes.includes(mode));
}

/** Routing follows the template's intent on every target. Cloud availability
 *  only determines which domain provider a new HTTP endpoint starts with. */
export function defaultAppEndpointExposure(
  endpoint: AppEndpoint,
  cloudConnected: boolean,
): AppEndpointExposure {
  const publicEndpoint =
    endpoint.scope === "public" || (endpoint.scope === undefined && endpoint.kind === "http");
  const preferred =
    endpoint.kind === "http"
      ? publicEndpoint
        ? "domain"
        : "port"
      : publicEndpoint
        ? "publish"
        : "internal";
  const modes = getAppEndpointModes(endpoint);
  const mode =
    modes.find((mode) => mode === endpoint.defaultMode) ??
    modes.find((mode) => mode === preferred) ??
    modes[0];

  if (endpoint.kind === "http") {
    return {
      kind: "http",
      mode: mode === "domain" ? "domain" : "port",
      ep: createPublicEndpoint({
        port: String(endpoint.port),
        domainType: defaultDomainType(cloudConnected),
      }),
    };
  }
  return { kind: "tcp", mode: mode === "publish" ? "publish" : "internal" };
}
