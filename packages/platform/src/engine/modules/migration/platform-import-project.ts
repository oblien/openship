import type {
  MigrationServiceRoutes,
  TCreateServiceBody,
  TEnsureProjectBody,
} from "@repo/contracts";
import { slugify } from "@repo/core";
import type { PlannedImportService } from "./platform-import-plan";

export interface PlannedImportProject {
  create: TEnsureProjectBody;
  sourceIds: string[];
}

/** A native project has one Git checkout. Keep compatible environments together;
 * otherwise give each service its own project and use ordinary private links. */
export function platformImportProjects(
  name: string,
  serverId: string,
  services: PlannedImportService[],
): PlannedImportProject[] {
  const imports = services.filter((service) => service.data !== "external");
  const sources = new Set(
    imports
      .filter((service) => service.create.gitRepo)
      .map((service) =>
        JSON.stringify([
          service.create.gitProvider,
          service.create.gitOwner,
          service.create.gitRepo,
          service.create.gitBranch,
          service.source.commit,
        ]),
      ),
  );
  const groups = sources.size > 1 ? imports.map((service) => [service]) : [imports];
  if (groups.length > 1) {
    for (const service of imports) {
      const keys = new Set(service.bindings.map((binding) => binding.envKey));
      for (const key of keys) {
        const bindings = service.bindings.filter((binding) => binding.envKey === key);
        if (new Set(bindings.map((binding) => binding.sourceId)).size > 1) {
          service.source.blockers.push(
            `Review ${key}: use a separate connection variable for each private service when importing into separate projects.`,
          );
        }
        for (const binding of bindings) {
          if (
            Object.hasOwn(service.environment, key) &&
            binding.valueTemplate === undefined &&
            bindings.length === 1
          )
            service.source.blockers.push(
              `Review ${key}: its private host cannot be safely converted into a project connection. Provide a destination value explicitly.`,
            );
          const dependency = imports.find((candidate) => candidate.source.id === binding.sourceId);
          if (dependency && !(dependency.source.port || dependency.create.port))
            service.source.blockers.push(
              `Review ${key}: ${dependency.create.name} needs a private listener port for its project connection.`,
            );
        }
      }
    }
  }
  return groups.map((group) => ({
    create: platformImportProject(
      groups.length === 1
        ? name
        : `${slugify(name).slice(0, 100 - group[0].create.name.length - 1)}-${group[0].create.name}`,
      serverId,
      group,
    ),
    sourceIds: group.map((service) => service.source.id),
  }));
}

function dependencyNames(service: PlannedImportService, services: PlannedImportService[]) {
  return [
    ...new Set(
      service.bindings.flatMap((binding) => {
        const dependency = services.find((candidate) => candidate.source.id === binding.sourceId);
        return dependency ? [dependency.create.name] : [];
      }),
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

/** Translate one compatible group into ordinary project and service inputs. */
function platformImportProject(
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
