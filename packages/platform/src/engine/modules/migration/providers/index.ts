import { railwayMigrationProvider } from "./railway";
import { vercelMigrationProvider } from "./vercel";
import type { MigrationSourceProvider } from "./types";
import type { MigrationProvider } from "../../credentials/provider-api";

export const migrationProviders: Record<MigrationProvider, MigrationSourceProvider> = {
  railway: railwayMigrationProvider,
  vercel: vercelMigrationProvider,
};
