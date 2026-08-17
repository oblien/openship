import type { Edition } from "./edition";
import { ValidationError } from "./errors";
import type { ReleaseSource } from "./project-source";

/** Non-secret instance config snapshot for Operator backup / later recipe waves. */
export const PROJECT_CONFIG_EXPORT_VERSION = 1 as const;

/** Versioned operator recipe fixtures (no secrets, no host paths). */
export const OPERATOR_RECIPE_VERSION = 1 as const;

export type ExportedMountedRelease = {
  enabled: boolean;
  buildMode?: "prebuilt" | "server" | "upload";
  runtimeInstall?: "image" | "dockerfile" | "compose";
  preset?: string;
  serviceName?: string;
  sourcePath?: string;
  containerPath: string;
  sharedPaths?: string[];
  prepareCommand?: string;
  builderImage?: string;
  builderMemoryMb?: number;
  builderCpus?: number;
  builderCachePaths?: string[];
  reloadCommand?: string;
  healthPath?: string;
  healthPort?: number;
  retain?: number;
  uid?: number;
  gid?: number;
};

export type ExportedServer = {
  id: string;
  name: string | null;
  isLocal: boolean;
  sshHost: string;
  sshPort: number | null;
  sshUser: string | null;
  sshAuthMethod: string | null;
};

export type ExportedRoute = {
  id: string;
  hostname: string;
  domainType: string | null;
  isPrimary: boolean;
  targetPort: number | null;
  targetPath: string | null;
  serviceId: string | null;
  redirectTo: string | null;
  redirectStatus: number | null;
};

export type ExportedConnection = {
  id: string;
  sourceProjectId: string;
  targetProjectId: string;
  outputId: string;
  envKey: string;
  mode: string;
};

export type ExportedProject = {
  id: string;
  name: string;
  slug: string;
  environmentName: string;
  environmentSlug: string;
  environmentType: string;
  isApp: boolean;
  appTemplateId: string | null;
  gitProvider: string | null;
  gitOwner: string | null;
  gitRepo: string | null;
  gitBranch: string | null;
  gitUrl: string | null;
  localPath: string | null;
  framework: string | null;
  packageManager: string | null;
  installCommand: string | null;
  buildCommand: string | null;
  outputDirectory: string | null;
  productionPaths: string | null;
  rootDirectory: string | null;
  composePath: string | null;
  startCommand: string | null;
  buildImage: string | null;
  productionMode: string | null;
  port: number | null;
  serverId: string | null;
  internalAlias: string | null;
  autoDeploy: boolean;
  mountedRelease: ExportedMountedRelease | null;
  releaseSource: ReleaseSource | null;
  routes: ExportedRoute[];
  connections: ExportedConnection[];
};

export type ProjectConfigExport = {
  version: typeof PROJECT_CONFIG_EXPORT_VERSION;
  edition: Edition;
  exportedAt: string;
  organizationId: string;
  servers: ExportedServer[];
  projects: ExportedProject[];
  /** Projects matching the caller after scope filter (not the unfiltered org count). */
  total: number;
  /** True when the org has more projects than this snapshot loaded. */
  truncated: boolean;
};

/** How a recipe ships application code. `image` keeps mounted releases off. */
export type OperatorRecipeBuildMode = "prebuilt" | "upload" | "server" | "image";

export type OperatorRecipeService = {
  /** Planner key (`staff`, `public`, `mail`) — not a live service row id. */
  key: string;
  /** Compose / display name fallback used with `mountedRelease.serviceName`. */
  name: string;
};

export type OperatorRecipePlanner = {
  pathPrefixes: string[];
  lockfiles?: string[];
  composerLayerOnLockChange?: boolean;
  skipUnrelatedMonorepo?: boolean;
  backupPreset?: string;
};

export type OperatorRecipeHealth = {
  path: string;
  port?: number;
  publicHttps?: boolean;
};

export type OperatorRecipeActivation = {
  strategy: "atomic-current" | "image-replace";
  reloadCommand?: string;
  killDuringStaging: boolean;
  unhealthyRollsBack: boolean;
};

export type OperatorRecipe = {
  version: typeof OPERATOR_RECIPE_VERSION;
  name: string;
  projectHint: string;
  environment: string;
  service: OperatorRecipeService;
  buildMode: OperatorRecipeBuildMode;
  persistPaths: string[];
  health: OperatorRecipeHealth;
  activation: OperatorRecipeActivation;
  monorepoPathPrefixes: string[];
  migrationPolicy: string;
  rollbackPolicy: string;
  mountedRelease: ExportedMountedRelease;
  planner: OperatorRecipePlanner;
};

export const CONFIG_EXPORT_SECRET_KEYS = [
  "sshPassword",
  "sshPrivateKey",
  "sshKeyPassphrase",
  "sshKeyPath",
  "cloneTokenEncrypted",
  "webhookSecret",
  "env",
  "envVars",
  "value",
] as const;

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function optionalStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) return undefined;
  return value as string[];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new ValidationError(`Operator recipe missing ${field}.`);
  }
  return value.trim();
}

function requireStringArray(value: unknown, field: string): string[] {
  const items = optionalStringArray(value);
  if (!items) {
    throw new ValidationError(`Operator recipe ${field} must be a string array.`);
  }
  return items;
}

/** True if a serialized object still contains a known secret field name. */
export function exportContainsSecretKeys(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(exportContainsSecretKeys);
  for (const [key, child] of Object.entries(value)) {
    if ((CONFIG_EXPORT_SECRET_KEYS as readonly string[]).includes(key)) return true;
    if (exportContainsSecretKeys(child)) return true;
  }
  return false;
}

/** Allowlist `project.mountedRelease` — drops unknown / secret JSONB keys. */
export function serializeMountedRelease(raw: unknown): ExportedMountedRelease | null {
  const o = asRecord(raw);
  if (!o) return null;
  const out: ExportedMountedRelease = {
    enabled: o.enabled === true,
    containerPath: typeof o.containerPath === "string" ? o.containerPath : "",
  };
  if (o.buildMode === "prebuilt" || o.buildMode === "server") out.buildMode = o.buildMode;
  const serviceName = optionalString(o.serviceName);
  if (serviceName !== undefined) out.serviceName = serviceName;
  const sourcePath = optionalString(o.sourcePath);
  if (sourcePath !== undefined) out.sourcePath = sourcePath;
  const sharedPaths = optionalStringArray(o.sharedPaths);
  if (sharedPaths !== undefined) out.sharedPaths = sharedPaths;
  const prepareCommand = optionalString(o.prepareCommand);
  if (prepareCommand !== undefined) out.prepareCommand = prepareCommand;
  const builderImage = optionalString(o.builderImage);
  if (builderImage !== undefined) out.builderImage = builderImage;
  const builderMemoryMb = optionalNumber(o.builderMemoryMb);
  if (builderMemoryMb !== undefined) out.builderMemoryMb = builderMemoryMb;
  const builderCpus = optionalNumber(o.builderCpus);
  if (builderCpus !== undefined) out.builderCpus = builderCpus;
  const builderCachePaths = optionalStringArray(o.builderCachePaths);
  if (builderCachePaths !== undefined) out.builderCachePaths = builderCachePaths;
  const reloadCommand = optionalString(o.reloadCommand);
  if (reloadCommand !== undefined) out.reloadCommand = reloadCommand;
  const healthPath = optionalString(o.healthPath);
  if (healthPath !== undefined) out.healthPath = healthPath;
  const healthPort = optionalNumber(o.healthPort);
  if (healthPort !== undefined) out.healthPort = healthPort;
  const retain = optionalNumber(o.retain);
  if (retain !== undefined) out.retain = retain;
  return out;
}

function parseRecipeService(raw: unknown): OperatorRecipeService {
  const o = asRecord(raw);
  if (!o) throw new ValidationError("Operator recipe service identity is required.");
  return {
    key: requireString(o.key, "service.key"),
    name: requireString(o.name, "service.name"),
  };
}

function parseRecipeHealth(raw: unknown): OperatorRecipeHealth {
  const o = asRecord(raw);
  if (!o) throw new ValidationError("Operator recipe health is required.");
  const out: OperatorRecipeHealth = { path: requireString(o.path, "health.path") };
  const port = optionalNumber(o.port);
  if (port !== undefined) out.port = port;
  if (typeof o.publicHttps === "boolean") out.publicHttps = o.publicHttps;
  return out;
}

function parseRecipeActivation(raw: unknown): OperatorRecipeActivation {
  const o = asRecord(raw);
  if (!o) throw new ValidationError("Operator recipe activation is required.");
  if (o.strategy !== "atomic-current" && o.strategy !== "image-replace") {
    throw new ValidationError("Operator recipe activation.strategy is invalid.");
  }
  const out: OperatorRecipeActivation = {
    strategy: o.strategy,
    killDuringStaging: o.killDuringStaging === true,
    unhealthyRollsBack: o.unhealthyRollsBack === true,
  };
  const reloadCommand = optionalString(o.reloadCommand);
  if (reloadCommand !== undefined) out.reloadCommand = reloadCommand;
  return out;
}

function parseRecipePlanner(raw: unknown): OperatorRecipePlanner {
  const o = asRecord(raw);
  if (!o) throw new ValidationError("Operator recipe planner hints are required.");
  const out: OperatorRecipePlanner = {
    pathPrefixes: requireStringArray(o.pathPrefixes, "planner.pathPrefixes"),
  };
  const lockfiles = optionalStringArray(o.lockfiles);
  if (lockfiles !== undefined) out.lockfiles = lockfiles;
  if (typeof o.composerLayerOnLockChange === "boolean") {
    out.composerLayerOnLockChange = o.composerLayerOnLockChange;
  }
  if (typeof o.skipUnrelatedMonorepo === "boolean") {
    out.skipUnrelatedMonorepo = o.skipUnrelatedMonorepo;
  }
  const backupPreset = optionalString(o.backupPreset);
  if (backupPreset !== undefined) out.backupPreset = backupPreset;
  return out;
}

function parseRecipeBuildMode(value: unknown): OperatorRecipeBuildMode {
  if (value === "prebuilt" || value === "upload" || value === "server" || value === "image") {
    return value;
  }
  throw new ValidationError("Operator recipe buildMode is invalid.");
}

/**
 * Load a committed operator recipe. Allowlists `mountedRelease` and refuses
 * secret keys so fixtures can round-trip through the same export path.
 */
export function parseOperatorRecipe(raw: unknown): OperatorRecipe {
  const o = asRecord(raw);
  if (!o) throw new ValidationError("Operator recipe must be an object.");
  if (exportContainsSecretKeys(o)) {
    throw new ValidationError("Operator recipe contained a secret field and was refused.");
  }
  if (o.version !== OPERATOR_RECIPE_VERSION) {
    throw new ValidationError("Operator recipe version is unsupported.");
  }
  const mountedRelease = serializeMountedRelease(o.mountedRelease);
  if (!mountedRelease) {
    throw new ValidationError("Operator recipe mountedRelease is required.");
  }
  return {
    version: OPERATOR_RECIPE_VERSION,
    name: requireString(o.name, "name"),
    projectHint: requireString(o.projectHint, "projectHint"),
    environment: requireString(o.environment, "environment"),
    service: parseRecipeService(o.service),
    buildMode: parseRecipeBuildMode(o.buildMode),
    persistPaths: requireStringArray(o.persistPaths, "persistPaths"),
    health: parseRecipeHealth(o.health),
    activation: parseRecipeActivation(o.activation),
    monorepoPathPrefixes: requireStringArray(o.monorepoPathPrefixes, "monorepoPathPrefixes"),
    migrationPolicy: requireString(o.migrationPolicy, "migrationPolicy"),
    rollbackPolicy: requireString(o.rollbackPolicy, "rollbackPolicy"),
    mountedRelease,
    planner: parseRecipePlanner(o.planner),
  };
}
