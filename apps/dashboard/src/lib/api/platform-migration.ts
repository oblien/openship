import type {
  PlatformDiscovery,
  PlatformProject,
  PlatformMigrationPlan,
  PlatformMigrationReview,
  PlatformMigrationSource,
} from "@repo/contracts";
import { api } from "./client";

export const platformMigrationApi = {
  projects: (connectionId: string) =>
    api.get<{ projects: PlatformProject[] }>(
      `migration/platforms/projects?connectionId=${encodeURIComponent(connectionId)}`,
      { timeout: 120_000 },
    ),
  discover: (input: PlatformMigrationSource) =>
    api.post<PlatformDiscovery>("migration/platforms/discover", input, { timeout: 120_000 }),
  review: (input: PlatformMigrationReview) =>
    api.post<PlatformMigrationPlan>("migration/platforms/review", input, { timeout: 120_000 }),
  start: (input: { planId: string; writesPaused: boolean; workersPaused: boolean }) =>
    api.post<{ success: true; migrationId: string; confirmationToken: string }>(
      "migration/platforms/import",
      input,
      { timeout: 120_000 },
    ),
};
