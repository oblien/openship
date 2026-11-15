import { createHash, randomUUID, randomBytes } from "node:crypto";
import { AppError, normalizeAliasStrict, slugify, normalizeProjectRootDirectory, validateImageReference } from "@repo/core";
import type {
  PlatformDiscovery,
  PlatformMigrationSource,
  PlatformMigrationReview,
  PlatformMigrationPlan,
  TEnsureProjectBody,
} from "@repo/contracts";
import type { ExecutionContext } from "../../../context";
import { cacheStore } from "../../lib/cache-store";
import { encrypt, decrypt } from "../../lib/encryption";
import { authorization } from "../../lib/authorization";
import { requireOrganizationAdmin } from "../../lib/organization-authorization";
import { getProviderAccess } from "../credentials/connection-authorization";
import { resolveProjectInfo } from "../deployments/prepare.service";
import { createGitHubReader } from "../deployments/project-reader";
import { requireMigrationServer } from "./migration-access";
import { migrationProviders } from "./providers";
import {
  publicImportService,
  type ProviderInventory,
  type ProviderService,
} from "./providers/types";
import { discoverExternalDatabases } from "./providers/external-databases";
import { resolveRailwayBindings } from "./providers/railway-wiring";
import { platformImportProject } from "./platform-import-project";

export interface ImportBinding {
  sourceId: string;
  envKey: string;
  valueTemplate?: string;
}
export interface PlannedImportService {
  source: ProviderService;
  data: "copy" | "empty" | "external";
  create: TEnsureProjectBody;
  environment: Record<string, string>;
  bindings: ImportBinding[];
  transfer?: "cold-volume";
}
export interface PrivateImportPlan {
  id: string;
  organizationId: string;
  userId: string;
  inventory: ProviderInventory;
  fingerprint: string;
  targetServerId: string;
  project: TEnsureProjectBody;
  services: PlannedImportService[];
  requiresWritePause: boolean;
  requiresWorkerPause: boolean;
  ready: boolean;
  sourceControl?: "railway-project";
}
interface Draft {
  organizationId: string;
  userId: string;
  inventory: ProviderInventory;
  externalDatabases?: ProviderService[];
}
const CACHE_SECONDS = 30 * 60;

async function put<T>(kind: "draft" | "plan", id: string, value: T) {
  await (
    await cacheStore<string>(`platform-import-${kind}`, { maxSize: 500 })
  ).set(id, encrypt(JSON.stringify(value)), CACHE_SECONDS);
}
async function get<T extends { organizationId: string; userId: string }>(
  ctx: ExecutionContext,
  kind: "draft" | "plan",
  id: string,
): Promise<T> {
  await requireOrganizationAdmin(ctx);
  const value = await (await cacheStore<string>(`platform-import-${kind}`)).get(id);
  if (!value)
    throw new AppError(
      "This import review expired. Discover the source again.",
      409,
      "IMPORT_REVIEW_EXPIRED",
    );
  const parsed = JSON.parse(decrypt(value)) as T;
  if (parsed.organizationId !== ctx.organizationId || parsed.userId !== ctx.userId)
    throw new AppError("This import belongs to another workspace or user", 404, "IMPORT_NOT_FOUND");
  return parsed;
}
/** Stable object ordering: provider pagination/order is not a source change. */
export function inventoryFingerprint(inventory: ProviderInventory): string {
  const stable = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(stable).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
      : value && typeof value === "object"
        ? Object.fromEntries(
            Object.entries(value)
              .filter(([key]) => key !== "sizeBytes")
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([k, v]) => [k, stable(v)]),
          )
        : value;
  return createHash("sha256")
    .update(JSON.stringify(stable(inventory)))
    .digest("hex");
}
export async function listPlatformProjects(ctx: ExecutionContext, connectionId: string) {
  await requireOrganizationAdmin(ctx);
  const access = await getProviderAccess(ctx.organizationId, connectionId);
  return migrationProviders[access.provider].projects(access);
}
export async function discoverPlatform(
  ctx: ExecutionContext,
  source: PlatformMigrationSource,
): Promise<PlatformDiscovery> {
  await requireOrganizationAdmin(ctx);
  const access = await getProviderAccess(ctx.organizationId, source.connectionId);
  const inventory = await migrationProviders[access.provider].discover(access, source);
  if (!inventory.services.length)
    throw new AppError(
      "No deployable services were found in this environment",
      400,
      "IMPORT_EMPTY",
    );
  const draftId = randomUUID();
  await put<Draft>("draft", draftId, {
    organizationId: ctx.organizationId,
    userId: ctx.userId,
    inventory,
  });
  return { draftId, ...publicInventory(inventory) };
}
function publicInventory(inventory: ProviderInventory) {
  return {
    provider: inventory.provider,
    projectName: inventory.projectName,
    environmentName: inventory.environmentName,
    services: inventory.services.map(publicImportService),
    warnings: inventory.warnings,
  };
}
const ref = /^\$\{\{([^{}]+)\.([A-Za-z_][A-Za-z0-9_]*)\}\}$/;
const databaseUrlKeys = {
  pg_dump: ["DATABASE_URL", "DATABASE_PRIVATE_URL", "PRIVATE_URL"],
  mysql_dump: ["DATABASE_URL", "MYSQL_URL", "MYSQL_PRIVATE_URL", "PRIVATE_URL"],
  redis_rdb: ["REDIS_URL", "REDIS_PRIVATE_URL", "PRIVATE_URL"],
  mongo_dump: ["MONGO_URL", "MONGODB_URL", "MONGO_PRIVATE_URL", "PRIVATE_URL"],
};

/** Turn provider references into normal project connections. Anything requiring
 * an application change remains a visible blocker, never a guessed replacement. */
export function resolveImportBindings(
  source: ProviderService,
  selected: Map<string, PlannedImportService>,
  overrides: Record<string, string | null>,
): ImportBinding[] {
  const bindings: ImportBinding[] = [];
  for (const [key, template] of Object.entries(source.rawEnv)) {
    if (source.kind === "database" || key.startsWith("RAILWAY_")) continue;
    const match = ref.exec(template);
    const dependency =
      match &&
      [...selected.values()].find((s) => s.source.id === match[1] || s.source.name === match[1]);
    if (
      Object.hasOwn(overrides, key) &&
      (!dependency?.source.externalDatabase ||
        dependency.source.externalDatabase !== overrides[key])
    )
      continue;
    if (dependency?.data === "external") continue;
    if (
      dependency &&
      dependency.source.database &&
      dependency.source.id !== source.id &&
      databaseUrlKeys[dependency.source.database].includes(match![2])
    ) {
      bindings.push({ sourceId: dependency.source.id, envKey: key });
      delete source.env[key];
      continue;
    }
    const references = [...template.matchAll(/\$\{\{([^{}]+)\.([A-Za-z_][A-Za-z0-9_]*)\}\}/g)];
    if (
      references.some((reference) => !["shared", source.name, source.id].includes(reference[1]))
    ) {
      source.blockers.push(
        `Review ${key}: this provider reference cannot be replaced by a direct database connection. Supply its destination value explicitly.`,
      );
      continue;
    }
    if (/\.railway\.internal\b|\$\{\{/.test(source.env[key] ?? template))
      source.blockers.push(
        `Set ${key} to an accessible value, or include its dependency with a supported URL connection.`,
      );
  }
  for (const [key, value] of Object.entries(source.env)) {
    if (/\.railway\.internal\b|\$\{\{/.test(value) && source.kind !== "database")
      source.blockers.push(
        `Replace ${key}: Railway private addresses cannot be reached from the destination.`,
      );
  }
  return bindings;
}

export async function reviewPlatform(
  ctx: ExecutionContext,
  input: PlatformMigrationReview,
): Promise<PlatformMigrationPlan> {
  const draft = await get<Draft>(ctx, "draft", input.draftId);
  await authorization.authorize(ctx, {
    resourceType: "server",
    resourceId: input.targetServerId,
    action: "write",
  });
  await requireMigrationServer(ctx.organizationId, input.targetServerId, "target");
  const inventory = structuredClone(draft.inventory);
  inventory.services.push(...structuredClone(draft.externalDatabases ?? []));
  // Secret values supplied during review can reveal databases that the provider
  // could not export. Use the same discovery and choice cards for those too.
  if (inventory.provider === "vercel") {
    for (const choice of input.services) {
      const app = inventory.services.find((s) => s.id === choice.id && s.kind === "app");
      if (!app) continue;
      for (const [key, value] of Object.entries(choice.env ?? {})) {
        if (value === null) delete app.env[key];
        else app.env[key] = value;
      }
      discoverExternalDatabases(app, inventory.services);
    }
    draft.externalDatabases = inventory.services.filter(
      (s) =>
        s.externalDatabase && !draft.inventory.services.some((original) => original.id === s.id),
    );
    await put("draft", input.draftId, draft);
  }
  const choices = [...input.services];
  if (
    inventory.provider === "railway" &&
    inventory.services.some((s) => !choices.some((c) => c.id === s.id))
  )
    throw new AppError(
      "Import the complete Railway project so its services, dependencies and storage move together.",
      400,
      "IMPORT_PROJECT_INCOMPLETE",
    );
  for (const source of inventory.services) {
    if (
      source.externalDatabase &&
      !draft.inventory.services.some((s) => s.id === source.id) &&
      !choices.some((c) => c.id === source.id)
    )
      choices.push({ id: source.id, name: source.name, data: "external" });
  }
  const selected = new Map<string, PlannedImportService>();
  const names = new Set<string>();
  for (const choice of choices) {
    const source = inventory.services.find((s) => s.id === choice.id);
    if (!source || selected.has(choice.id))
      throw new AppError("Choose each discovered service once", 400, "IMPORT_SELECTION_INVALID");
    const name = choice.name.trim();
    const serviceName = normalizeAliasStrict(name);
    if (!serviceName || names.has(serviceName))
      throw new AppError(
        "Choose a distinct name for each imported service",
        400,
        "IMPORT_NAME_INVALID",
      );
    names.add(serviceName);
    if (choice.data === "external" && !source.externalDatabase)
      throw new AppError(
        "Only an external database can be kept as an external connection",
        400,
        "IMPORT_DATA_INVALID",
      );
    const service: PlannedImportService = {
      source,
      data: choice.data,
      bindings: [],
      environment: {},
      create: { name: serviceName, internalAlias: serviceName, serverId: input.targetServerId },
      ...(inventory.provider === "railway" ? { transfer: "cold-volume" as const } : {}),
    };
    selected.set(source.id, service);
    if (choice.data === "external") {
      source.blockers = [];
      continue;
    }
    if (source.image && validateImageReference(source.image))
      source.blockers.push(
        "The source image reference is invalid. Use a valid registry image and tag or digest.",
      );
    if (
      source.rootDirectory &&
      (/[\\\0\r\n]/.test(source.rootDirectory) || source.rootDirectory.split("/").includes(".."))
    )
      source.blockers.push("The application root must stay within the source repository.");
    for (const [key, value] of Object.entries(choice.env ?? {})) {
      if (value === null) delete source.env[key];
      else source.env[key] = value;
    }
    if (source.externalDatabase) {
      if (!choice.databaseVersion)
        source.blockers.push(
          "Enter the source PostgreSQL major version before copying this database.",
        );
      const url = new URL(source.externalDatabase);
      source.image = `postgres:${choice.databaseVersion ?? "unknown"}-alpine`;
      if (Number(choice.databaseVersion) >= 18)
        source.volumes = source.volumes.map((v) => ({ ...v, mountPath: "/var/lib/postgresql" }));
      source.env = {
        POSTGRES_USER: "postgres",
        POSTGRES_PASSWORD: randomBytes(32).toString("base64url"),
        POSTGRES_DB: decodeURIComponent(url.pathname.slice(1)) || "postgres",
      };
      source.port = 5432;
    }
    for (const variable of source.variables)
      if (variable.required && !Object.hasOwn(source.env, variable.key))
        source.blockers.push(`Provide ${variable.key}; the provider cannot export its value.`);
    if (
      service.transfer !== "cold-volume" &&
      source.database &&
      Object.keys(source.env).some((key) =>
        /^(PGBACKREST_|WALG_|WAL_G_|POSTGRES_RECOVERY_|POSTGRES_REPLICATION_|REPLICATION_)/.test(
          key,
        ),
      )
    )
      source.blockers.push(
        "Exclude source backup, recovery and replication settings before importing this database. Configure them for the destination after cutover.",
      );
    if (
      source.volumes.some(
        (v) => !/^\/(?!$)(?!.*(?:^|\/)\.\.(?:\/|$))[^\0\r\n:]+$/.test(v.mountPath),
      )
    )
      source.blockers.push(
        "A volume has an unsupported mount path. Review its storage configuration first.",
      );
    if (source.database && !source.volumes.length)
      source.blockers.push(
        "This database has no persistent volume in the provider configuration. Configure a persistent data mount at the source and discover it again before importing.",
      );
    if ((source.database || source.volumes.length) && choice.data === "empty")
      source.warnings.push(
        "This project will start with empty storage. Existing source data is not copied.",
      );
    if (service.transfer !== "cold-volume" && source.database === "pg_dump")
      source.warnings.push(
        "Copies the configured PostgreSQL database. Other databases, roles and provider-managed features require a separate export.",
      );
    if (
      choice.data === "copy" &&
      !source.externalDatabase &&
      inventory.provider === "railway" &&
      !source.instanceId
    )
      source.blockers.push(
        "The source service is not running; data export needs access to its Railway container.",
      );
  }
  for (const service of selected.values()) {
    if (inventory.provider === "railway")
      service.bindings = resolveRailwayBindings(service, selected);
  }
  for (const service of selected.values()) {
    const source = service.source;
    if (service.data === "external") continue;
    if (inventory.provider !== "railway")
      service.bindings = resolveImportBindings(
        source,
        selected,
        input.services.find((s) => s.id === source.id)?.env ?? {},
      );
    service.environment = Object.fromEntries(
      Object.entries(source.env).filter(
        ([key]) =>
          service.transfer === "cold-volume" ||
          !source.database ||
          !/^(?:PGHOST|PGPORT|DATABASE_URL|DATABASE_PUBLIC_URL|DATABASE_PRIVATE_URL|REDISHOST|REDISPORT|REDIS_URL|MONGO_URL|MONGODB_URL)$/.test(
            key,
          ),
      ),
    );
    const volumes = source.volumes.map(
      (volume, index) => `${service.create.name}-data-${index}:${volume.mountPath}`,
    );
    service.create.readiness = source.readiness;
    const composeService = {
      name: "app",
      environment: service.environment,
      volumes,
      exposed: false,
      ...(source.port ? { ports: [String(source.port)] } : {}),
      ...(source.startCommand ? { command: source.startCommand } : {}),
      ...(source.restart ? { restart: source.restart } : {}),
      ...(service.create.internalAlias
        ? { advanced: { alias: service.create.internalAlias } }
        : {}),
    };
    if (source.image) {
      service.create = {
        ...service.create,
        projectType: "services",
        framework: "docker-compose",
        services: [{ ...composeService, image: source.image }],
      };
    } else if (source.repository && source.commit) {
      const [owner, repo] = source.repository.split("/");
      try {
        if (source.dockerfile) {
          const root = normalizeProjectRootDirectory(source.rootDirectory);
          const dockerfile = source.dockerfile.replace(/^\/+/, "");
          if (
            [root, dockerfile].some(
              (path) => /[\\\0\r\n]/.test(path) || path.split("/").includes(".."),
            )
          ) {
            source.blockers.push(
              "The build root or Dockerfile path escapes its repository. Choose a repository-relative path.",
            );
            continue;
          }
          const reader = createGitHubReader(ctx, owner, repo, source.commit, {
            serverId: input.targetServerId,
          });
          if (!(await reader.readText([root, dockerfile].filter(Boolean).join("/")))) {
            source.blockers.push(
              "The selected Dockerfile was not found at the deployed Git revision. Check its path relative to the application root.",
            );
            continue;
          }
          service.create = {
            ...service.create,
            gitProvider: "github",
            gitOwner: owner,
            gitRepo: repo,
            gitBranch: source.branch ?? "main",
            rootDirectory: ".",
            projectType: "services",
            framework: "docker-compose",
            services: [{ ...composeService, build: root || ".", dockerfile }],
          };
          continue;
        }
        const info = await resolveProjectInfo({
          source: "github",
          ctx,
          owner,
          repo,
          branch: source.commit,
          serverId: input.targetServerId,
          rootDirectory: source.rootDirectory,
          env: source.env,
        });
        if (info.projectType === "services" || info.projectType === "monorepo")
          source.blockers.push(
            "This source resolves to several services. Select its application root before importing it as one provider service.",
          );
        source.blockers.push(...(info.configDiagnostics?.errors ?? []));
        // The regular repository scanner already identifies Vercel-only routes,
        // functions and schedules. Import must surface those exact diagnostics.
        source.blockers.push(
          ...(info.configDiagnostics?.warnings ?? []).filter((warning) =>
            warning.startsWith("vercel.json"),
          ),
        );
        source.warnings.push(
          ...(info.configDiagnostics?.warnings ?? []).filter(
            (warning) => !warning.startsWith("vercel.json"),
          ),
        );
        service.create = {
          ...service.create,
          gitProvider: "github",
          gitOwner: owner,
          gitRepo: repo,
          gitBranch: source.branch ?? "main",
          projectType: info.projectType,
          framework: info.stack as TEnsureProjectBody["framework"],
          packageManager: info.packageManager as TEnsureProjectBody["packageManager"],
          rootDirectory: info.rootDirectory,
          installCommand: source.installCommand ?? info.installCommand,
          buildCommand: source.buildCommand ?? info.buildCommand,
          startCommand: source.startCommand ?? info.startCommand,
          outputDirectory: source.outputDirectory ?? info.outputDirectory,
          buildImage: info.buildImage,
          port: source.port ?? info.port,
          productionPaths: info.productionPaths.join(","),
          volumes,
          routingConfig: info.routing,
          readiness: source.readiness ?? info.readiness,
          releaseCommands: info.releaseCommands,
          roles: info.roles?.flatMap((role) =>
            role.kind === "worker" || role.kind === "scheduler"
              ? [{ ...role, kind: role.kind }]
              : [],
          ),
          workloadType: source.kind === "worker" ? "worker" : info.workloadType,
          publicEndpoints: [],
        };
      } catch {
        // diagnostics-ignore: upstream repository failures can contain credentials; this becomes a visible review blocker without copying the raw exception.
        // Repository errors can include source files or private URLs. Keep this
        // review actionable without returning their contents or credentials.
        source.blockers.push(
          "Openship could not read this GitHub revision. Grant repository access and check its build configuration, then review again.",
        );
      }
    }
    source.blockers = [...new Set(source.blockers)];
  }
  // A dependency cycle cannot be deployed in the ordered, verified flow.
  const visiting = new Set<string>(),
    visited = new Set<string>();
  const visit = (id: string): void => {
    if (visited.has(id)) return;
    const service = selected.get(id)!;
    if (visiting.has(id)) {
      service.source.blockers.push(
        "This dependency cycle needs a reviewed connection before import.",
      );
      return;
    }
    visiting.add(id);
    for (const binding of service.bindings) visit(binding.sourceId);
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of selected.keys()) visit(id);
  const services = [...selected.values()];
  const projectName = (input.projectName ?? inventory.projectName).trim();
  if (!slugify(projectName))
    throw new AppError("Choose a name for the imported project", 400, "IMPORT_NAME_INVALID");
  const project = platformImportProject(projectName, input.targetServerId, services);
  const plan: PrivateImportPlan = {
    id: randomUUID(),
    organizationId: ctx.organizationId,
    userId: ctx.userId,
    inventory: draft.inventory,
    fingerprint: inventoryFingerprint(draft.inventory),
    targetServerId: input.targetServerId,
    project,
    services,
    ...(inventory.provider === "railway" ? { sourceControl: "railway-project" as const } : {}),
    requiresWritePause: services.some(
      (s) =>
        inventory.provider === "railway" ||
        (s.data === "copy" && (!!s.source.database || s.source.volumes.length > 0)),
    ),
    requiresWorkerPause: services.some(
      (s) =>
        inventory.provider !== "railway" &&
        (s.source.kind === "worker" || !!s.create.roles?.length) &&
        s.data !== "external",
    ),
    ready:
      services.some((s) => s.data !== "external") &&
      services.every((s) => !s.source.blockers.length),
  };
  await put("plan", plan.id, plan);
  return {
    planId: plan.id,
    ...publicInventory({ ...inventory, services: services.map((s) => s.source) }),
    projectName,
    targetServerId: plan.targetServerId,
    requiresWritePause: plan.requiresWritePause,
    requiresWorkerPause: plan.requiresWorkerPause,
    ready: plan.ready,
    sourceControl: plan.sourceControl,
  };
}

export async function loadReviewedImport(
  ctx: ExecutionContext,
  id: string,
): Promise<PrivateImportPlan> {
  const plan = await get<PrivateImportPlan>(ctx, "plan", id);
  if (!plan.project)
    throw new AppError("Review this import again before starting it.", 409, "IMPORT_REVIEW_EXPIRED");
  if (!plan.ready)
    throw new AppError("Resolve the import review before starting", 409, "IMPORT_NOT_READY");
  const access = await getProviderAccess(ctx.organizationId, plan.inventory.source.connectionId);
  const current = await migrationProviders[access.provider].discover(access, plan.inventory.source);
  if (inventoryFingerprint(current) !== plan.fingerprint)
    throw new AppError(
      "The source changed since discovery. Review it again before importing.",
      409,
      "IMPORT_SOURCE_CHANGED",
    );
  return plan;
}
