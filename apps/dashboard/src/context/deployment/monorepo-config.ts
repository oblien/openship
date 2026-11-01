import { ENV_MASK, isMaskedValue, type StackId } from "@repo/core";
import type { PrepareMonorepoApp } from "@/lib/api/deploy";
import type { MonorepoAppConfig } from "./types";
import { createPublicEndpoint } from "./types";
import { normalizeSubdomain } from "@/utils/subdomain";

export function normalizeAppRoot(path: string): string {
  return (
    path
      .split("/")
      .filter((part) => part && part !== ".")
      .join("/") || "."
  );
}

/** Detection supplies candidates. Only a saved selection or the picker enables one. */
export function monorepoAppFromScan(
  app: PrepareMonorepoApp,
  projectName: string,
  domainType: "free" | "custom",
): MonorepoAppConfig {
  const hasServer = app.stack === "docker" || !!app.startCommand;
  const port = String(app.port || (hasServer ? 3000 : 80));
  return {
    id: app.id || app.rootDirectory,
    name: app.name,
    suggested: app.suggested !== false,
    enabled: app.enabled ?? false,
    exposed: app.exposed ?? app.suggested !== false,
    framework: (app.stack || "unknown") as StackId,
    detectedFramework: app.stack || null,
    packageManager: app.packageManager || "npm",
    buildImage: app.buildImage || "node:22",
    rootDirectory: app.rootDirectory || ".",
    installCommand: app.installCommand || "",
    buildCommand: app.buildCommand || "",
    startCommand: app.startCommand || "",
    outputDirectory: app.outputDirectory || "",
    productionPaths: app.productionPaths || [],
    port,
    hasServer,
    hasBuild: !!(app.buildCommand || app.installCommand),
    envVars: Object.entries(app.environment ?? {}).map(([key, value]) => ({
      key,
      value: isMaskedValue(value) ? "" : value,
      visible: false,
      ...(isMaskedValue(value) ? { preserveValue: true, originalKey: key } : {}),
    })),
    publicEndpoints:
      app.publicEndpoints !== undefined
        ? app.publicEndpoints.map((endpoint) =>
            createPublicEndpoint({
              ...endpoint,
              port: String(endpoint.port || port),
              domainType: endpoint.domainType === "custom" ? "custom" : "free",
              targetPath: hasServer ? "" : "/",
            }),
          )
        : [
            createPublicEndpoint({
              port,
              targetPath: hasServer ? "" : "/",
              domainType,
              domain: normalizeSubdomain(`${app.name}-${projectName}`)
                .slice(0, 63)
                .replace(/-+$/, ""),
            }),
          ],
  };
}

/** Keep user edits, even for a manually added folder the detector doesn't suggest. */
export function reconcileMonorepoApps(
  previous: MonorepoAppConfig[],
  discovered: MonorepoAppConfig[],
) {
  const roots = new Set(previous.map((app) => normalizeAppRoot(app.rootDirectory)));
  return [
    ...previous,
    ...discovered.filter((app) => !roots.has(normalizeAppRoot(app.rootDirectory))),
  ];
}

export function serializeMonorepoApp(app: MonorepoAppConfig) {
  for (const row of app.envVars) {
    if (row.preserveValue && row.originalKey && row.key.trim() !== row.originalKey) {
      throw new Error(
        `Enter a value for ${row.key} before renaming a hidden environment variable.`,
      );
    }
  }
  const publicEndpoints = app.publicEndpoints.map((endpoint) => ({
    port: Number(endpoint.port || app.port || 80),
    domain: endpoint.domainType === "free" ? endpoint.domain.trim() || undefined : undefined,
    customDomain:
      endpoint.domainType === "custom" ? endpoint.customDomain.trim() || undefined : undefined,
    domainType: endpoint.domainType,
  }));
  return {
    name: app.name,
    rootDirectory: app.rootDirectory,
    framework: app.framework,
    packageManager: app.packageManager,
    buildImage: app.buildImage,
    // Empty commands are explicit: null would inherit the project's command.
    installCommand: app.hasBuild ? app.installCommand : "",
    buildCommand: app.hasBuild ? app.buildCommand : "",
    startCommand: app.hasServer ? app.startCommand : "",
    outputDirectory: app.outputDirectory,
    port: app.port ? Number(app.port) : undefined,
    enabled: app.enabled,
    exposed: app.exposed !== false,
    publicEndpoints,
    domain: publicEndpoints[0]?.domain,
    customDomain: publicEndpoints[0]?.customDomain,
    domainType: publicEndpoints[0]?.domainType,
    environment: Object.fromEntries(
      app.envVars
        .filter((row) => row.key.trim())
        .map((row) => [row.key.trim(), row.preserveValue ? ENV_MASK : row.value]),
    ),
  };
}
