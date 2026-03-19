// ─── Database client ─────────────────────────────────────────────────────────
export { db, getDriver, type Database, type Driver } from "./client";

// ─── Schema (table definitions) ──────────────────────────────────────────────
export * as schema from "./schema";

// ─── Repositories (all DB access goes through here) ──────────────────────────
export {
  repos,
  createUserRepo,
  createSessionRepo,
  createAccountRepo,
  createGitInstallationRepo,
  createProjectRepo,
  createDeploymentRepo,
  createDomainRepo,
  createSettingsRepo,
  createServerRepo,
  type User,
  type NewUser,
  type Session,
  type Account,
  type GitInstallation,
  type NewGitInstallation,
  type Project,
  type NewProject,
  type EnvVar,
  type NewEnvVar,
  type Deployment,
  type NewDeployment,
  type BuildSession,
  type NewBuildSession,
  type Domain,
  type NewDomain,
  type UserSettings,
  type NewUserSettings,
  type Server,
  type NewServer,
} from "./repos";

// ─── Drizzle operators (re-exported for convenience) ─────────────────────────
export {
  eq,
  ne,
  and,
  or,
  not,
  gt,
  gte,
  lt,
  lte,
  like,
  ilike,
  inArray,
  notInArray,
  isNull,
  isNotNull,
  between,
  desc,
  asc,
  sql,
  count,
} from "drizzle-orm";
