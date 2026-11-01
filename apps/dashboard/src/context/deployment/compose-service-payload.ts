import type { ComposeServiceInfo } from "./types";

/** One service wire shape for saving configuration and starting a deployment. */
export function serializeComposeService(service: ComposeServiceInfo) {
  return {
    name: service.name,
    image: service.image,
    build: service.build,
    dockerfile: service.dockerfile,
    buildArgs: service.buildArgs,
    advanced: service.advanced,
    ports: service.ports,
    dependsOn: service.dependsOn,
    environment: service.environment,
    environmentTemplates: service.environmentTemplates,
    volumes: service.volumes,
    command: service.command,
    restart: service.restart,
    exposed: service.exposed,
    exposedPort: service.exposedPort,
    domain: service.domain,
    customDomain: service.customDomain,
    domainType: service.domainType,
    // Multi-route: one entry per public port. Drop the UI-only id/
    // targetPath; the backend mirrors entry[0] → the scalar fields.
    publicEndpoints: service.publicEndpoints?.map((endpoint) => ({
      port: endpoint.port,
      domain: endpoint.domainType === "custom" ? undefined : endpoint.domain,
      customDomain: endpoint.domainType === "custom" ? endpoint.customDomain : undefined,
      domainType: endpoint.domainType,
    })),
  };
}
