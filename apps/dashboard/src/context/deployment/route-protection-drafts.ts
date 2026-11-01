import type { DeploymentConfig, PublicEndpoint } from "./types";
import { projectsApi } from "@/lib/api";

/** Draft passwords stay in wizard memory, outside endpoint/config/build payloads.
 * Persist before requesting ANY build so a new hostname cannot publish unlocked. */
export async function persistRouteProtectionDrafts(projectId: string, config: DeploymentConfig) {
  const endpoints = [
    ...(!config.noPublicRoute ? config.publicEndpoints : []),
    ...config.services
      .filter((service) => service.exposed)
      .flatMap((service) => service.publicEndpoints ?? []),
    ...(config.serviceDeploymentMode === "single" ? [] : config.monorepoApps ?? [])
      .filter((app) => app.enabled && app.exposed !== false)
      .flatMap((app) => app.publicEndpoints),
  ];
  const changes = new Map<string, NonNullable<PublicEndpoint["protectionDraft"]>>();
  for (const endpoint of endpoints) {
    const draft = endpoint.protectionDraft;
    // Editing a hostname after staging a password must not apply it to the old
    // hostname, nor quietly publish the new hostname unprotected.
    if (!draft) continue;
    if (
      endpoint.domainType !== "custom" ||
      endpoint.customDomain.trim().toLowerCase() !== draft.hostname
    )
      throw new Error(
        "The protected hostname changed. Open its lock settings and save the password again.",
      );
    const prior = changes.get(draft.hostname);
    if (prior && prior.password !== draft.password)
      throw new Error(
        "This hostname has different staged passwords. Keep one password for the hostname.",
      );
    changes.set(draft.hostname, draft);
  }
  if (changes.size && (config.deployTarget === "cloud" || config.deployTarget === "cluster"))
    throw new Error("Password protection requires a self-hosted HTTPS edge.");
  for (const change of changes.values()) await projectsApi.changeRouteProtection(projectId, change);
  return new Set(changes.values());
}

/** Clear only the drafts we acknowledged, preserving edits made while saving. */
export function clearRouteProtectionDrafts(
  config: DeploymentConfig,
  saved: Set<NonNullable<PublicEndpoint["protectionDraft"]>>,
): DeploymentConfig {
  if (!saved.size) return config;
  const clear = (endpoints: PublicEndpoint[]) =>
    endpoints.map((endpoint) =>
      endpoint.protectionDraft && saved.has(endpoint.protectionDraft)
        ? { ...endpoint, protectionDraft: undefined }
        : endpoint,
    );
  return {
    ...config,
    publicEndpoints: clear(config.publicEndpoints),
    services: config.services.map((service) => ({
      ...service,
      publicEndpoints: service.publicEndpoints && clear(service.publicEndpoints),
    })),
    monorepoApps: config.monorepoApps?.map((app) => ({
      ...app,
      publicEndpoints: clear(app.publicEndpoints),
    })),
  };
}
