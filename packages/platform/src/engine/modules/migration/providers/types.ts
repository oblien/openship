import type { PayloadKind, OpenshipReadiness } from "@repo/core";
import type {
  PlatformImportService,
  PlatformMigrationSource,
  PlatformProject,
} from "@repo/contracts";
import type { ProviderAccess, MigrationProvider } from "../../credentials/provider-api";

export interface ProviderService extends PlatformImportService {
  /** Server-only configuration. Public discovery uses an explicit allowlist. */
  env: Record<string, string>;
  rawEnv: Record<string, string>;
  instanceId?: string;
  deploymentIds?: string[];
  /** Provider private DNS, used to remap the whole project's connections. */
  privateDomain?: string;
  port?: number;
  installCommand?: string;
  buildCommand?: string;
  startCommand?: string;
  outputDirectory?: string;
  dockerfile?: string;
  readiness?: OpenshipReadiness;
  restart?: string;
  database?: Extract<PayloadKind, "pg_dump" | "mysql_dump" | "mongo_dump" | "redis_rdb">;
  externalDatabase?: string;
}
export interface ProviderInventory {
  provider: MigrationProvider;
  source: PlatformMigrationSource;
  projectName: string;
  environmentName: string;
  services: ProviderService[];
  warnings: string[];
}
export interface MigrationSourceProvider {
  projects(access: ProviderAccess): Promise<PlatformProject[]>;
  discover(access: ProviderAccess, source: PlatformMigrationSource): Promise<ProviderInventory>;
}
export function publicImportService(service: ProviderService): PlatformImportService {
  const {
    id,
    name,
    kind,
    image,
    repository,
    branch,
    commit,
    rootDirectory,
    variables,
    volumes,
    domains,
    warnings,
    blockers,
  } = service;
  return {
    id,
    name,
    kind,
    image,
    repository,
    branch,
    commit,
    rootDirectory,
    variables,
    volumes,
    domains,
    warnings,
    blockers,
    external: !!service.externalDatabase,
  };
}
