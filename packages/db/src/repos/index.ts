export { createUserRepo, type User, type NewUser } from "./user.repo";
export { createSessionRepo, type Session } from "./session.repo";
export { createAccountRepo, type Account } from "./account.repo";
export {
  createGitInstallationRepo,
  type GitInstallation,
  type NewGitInstallation,
} from "./git-installation.repo";
export { createProjectAppRepo, type ProjectApp, type NewProjectApp } from "./project-app.repo";
export {
  createProjectRepo,
  type Project,
  type NewProject,
  type EnvVar,
  type NewEnvVar,
} from "./project.repo";
export {
  createDeploymentRepo,
  type Deployment,
  type NewDeployment,
  type BuildSession,
  type NewBuildSession,
} from "./deployment.repo";
export { createDomainRepo, type Domain, type NewDomain } from "./domain.repo";
export {
  createServiceRepo,
  type Service,
  type NewService,
  type ServiceDeployment,
  type NewServiceDeployment,
} from "./service.repo";
export { createSettingsRepo, type UserSettings, type NewUserSettings } from "./settings.repo";
export {
  createInstanceSettingsRepo,
  type InstanceSettings,
  type NewInstanceSettings,
} from "./instance-settings.repo";
export { createServerRepo, type Server, type NewServer } from "./server.repo";
export {
  createAnalyticsRepo,
  type ServerAnalyticsRow,
  type NewServerAnalytics,
  type ServerAnalyticsGeoRow,
  type NewServerAnalyticsGeo,
} from "./analytics.repo";

// ─── Convenience: pre-bound repos using the singleton db ─────────────────────

import { db } from "../client";
import { createUserRepo } from "./user.repo";
import { createSessionRepo } from "./session.repo";
import { createAccountRepo } from "./account.repo";
import { createGitInstallationRepo } from "./git-installation.repo";
import { createProjectAppRepo } from "./project-app.repo";
import { createProjectRepo } from "./project.repo";
import { createDeploymentRepo } from "./deployment.repo";
import { createDomainRepo } from "./domain.repo";
import { createServiceRepo } from "./service.repo";
import { createSettingsRepo } from "./settings.repo";
import { createInstanceSettingsRepo } from "./instance-settings.repo";
import { createServerRepo } from "./server.repo";
import { createAnalyticsRepo } from "./analytics.repo";

/**
 * Pre-bound repository instances using the singleton `db`.
 *
 * Usage:
 *   import { repos } from "@repo/db";
 *   const user = await repos.user.findByEmail("test@example.com");
 *
 * For testing, create isolated repos with `createUserRepo(testDb)` etc.
 */
export const repos = {
  user: createUserRepo(db),
  session: createSessionRepo(db),
  account: createAccountRepo(db),
  gitInstallation: createGitInstallationRepo(db),
  projectApp: createProjectAppRepo(db),
  project: createProjectRepo(db),
  deployment: createDeploymentRepo(db),
  domain: createDomainRepo(db),
  service: createServiceRepo(db),
  settings: createSettingsRepo(db),
  instanceSettings: createInstanceSettingsRepo(db),
  server: createServerRepo(db),
  analytics: createAnalyticsRepo(db),
} as const;
