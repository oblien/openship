import type {
  MigrationServiceRoutes,
  TCreateServiceBody,
  TEnsureProjectBody,
} from "@repo/contracts";
import type { PlannedImportService } from "./platform-import-plan";

function dependencyNames(service: PlannedImportService, services: PlannedImportService[]) {
  return [
    ...new Set(
      service.bindings.map(
        (binding) =>
          services.find((dependency) => dependency.source.id === binding.sourceId)!.create.name,
      ),
    ),
  ];
}

/** Provider-owned hostnames stay at the source; custom domains use native migration routes. */
export function platformImportRoutes(services: PlannedImportService[]): MigrationServiceRoutes {
  return Object.fromEntries(
    services.flatMap((service) => {
      if (service.data === "external") return [];
      const domains = service.source.domains.filter((domain) => domain.portable);
      return domains.length
        ? [
            [
              service.create.name,
              domains.map((domain) => ({
                domainType: "custom" as const,
                customDomain: domain.hostname,
              })),
            ],
          ]
        : [];
    }),
  );
}

/** Translate reviewed provider recipes into the same project and service inputs
 * used by native imports. A provider project never becomes several projects. */
export function platformImportProject(
  name: string,
  serverId: string,
  services: PlannedImportService[],
): TEnsureProjectBody {
  const imports = services.filter((service) => service.data !== "external");
  const sources = imports.filter((service) => service.create.gitRepo);
  const first = sources[0];
  const buildDefaults = sources.find((service) => !service.create.services?.length)?.create;
  for (const service of sources) {
    if (service.create.releaseCommands?.length)
      service.source.blockers.push(
        "This repository declares project-wide release commands. Review a service-compatible release recipe before importing; grouped imports cannot silently skip those commands.",
      );
    if (
      service.create.gitOwner !== first.create.gitOwner ||
      service.create.gitRepo !== first.create.gitRepo ||
      service.source.commit !== first.source.commit
    ) {
      service.source.blockers.push(
        "These services use different repositories or deployed revisions. A native OpenShip project has one Git source; align the source services before importing them together.",
      );
    }
  }
  return {
    name,
    serverId,
    projectType: "services",
    framework: "docker-compose",
    hasServer: true,
    hasBuild: sources.length > 0,
    rootDirectory: ".",
    publicEndpoints: [],
    ...(first && {
      gitProvider: first.create.gitProvider,
      gitOwner: first.create.gitOwner,
      gitRepo: first.create.gitRepo,
      gitBranch: first.create.gitBranch,
      packageManager: buildDefaults?.packageManager,
      buildImage: buildDefaults?.buildImage,
      productionPaths: buildDefaults?.productionPaths,
    }),
    services: imports.flatMap((service) => {
      const recipe = service.create.services?.[0];
      return recipe
        ? [
            {
              ...recipe,
              name: service.create.name,
              // Imported values belong to encrypted, service-scoped env rows.
              environment: {},
              dependsOn: dependencyNames(service, services),
              advanced: { ...recipe.advanced, readiness: service.create.readiness },
            },
          ]
        : [];
    }),
  };
}

/** Source-built apps use the existing native sub-app recipe and build pipeline. */
export function platformImportSourceService(
  service: PlannedImportService,
  services: PlannedImportService[],
): TCreateServiceBody {
  const recipe = service.create;
  return {
    name: recipe.name,
    kind: "monorepo",
    rootDirectory: recipe.rootDirectory || ".",
    framework: recipe.framework,
    packageManager: recipe.packageManager,
    buildImage: recipe.buildImage,
    installCommand: recipe.installCommand,
    buildCommand: recipe.buildCommand,
    startCommand: recipe.startCommand,
    outputDirectory: recipe.outputDirectory,
    ports: recipe.port ? [String(recipe.port)] : [],
    volumes: recipe.volumes,
    exposed: false,
    dependsOn: dependencyNames(service, services),
    advanced: { alias: recipe.internalAlias, readiness: recipe.readiness },
  };
}
