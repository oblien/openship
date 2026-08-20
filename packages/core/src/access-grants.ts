/**
 * The access-grant surface — one definition of what a grant may name, shared by
 * the API, the DB layer, and the dashboard.
 *
 * This lives in @repo/core because it is the only place all three can reach:
 * the dashboard has no @repo/db dependency, and @repo/db already imports core,
 * so the dependency can only point this way. @repo/db re-exports `ResourceType`
 * and `Permission` from here, and the dashboard re-exports
 * `GrantableResourceType` as its `ResourceType`, so neither side keeps a copy.
 *
 * ── Why one file ─────────────────────────────────────────────────────────────
 * This list used to exist in seven places (permission.ts, grantable-types.ts,
 * token.controller.ts, the dashboard's api/permissions.ts, ResourcePicker,
 * mcp-access-templates, and two hardcoded arrays in settings components) with no
 * cross-check. They drifted: the PAT screen offered types the MCP consent screen
 * deliberately withheld, and the two mint allowlists could accept a type the
 * picker had no catalog for. `test/lib/grantable-surface-single-source.test.ts`
 * pins that every consumer now derives from here.
 *
 * ── The two type sets are not the same thing ─────────────────────────────────
 * `ResourceType` is every value a `resource_type` column may hold — including
 * the nested leaves (`deployment`, `service`, `backup_run`, …) that a permission
 * TAG names but a grant never keys on, because `resolveResourceOrg` rewrites
 * them to their root. `GrantableResourceType` is the subset a user may actually
 * grant. Only the latter needs a UI label or a resource catalog.
 *
 * ── Adding a grantable type ──────────────────────────────────────────────────
 * A type that is grantable but that no enforcement path can satisfy is a UI lie:
 * the owner picks it, the mint accepts it, and every call it was meant to
 * authorize 404s. That shipped twice (`github`, then `billing`/`audit`).
 * `test/lib/permission-grant-satisfiability.test.ts` now requires every entry in
 * GRANTABLE_RESOURCE_TYPES to be provably authorized through one of the two
 * doors — `checkPermission` or `canUseGitHubRepo`.
 */

/**
 * "create" is a collection-only capability: it authorizes creating NEW rows of a
 * type (only `{project,"*",[create]}` today) WITHOUT granting read/write/admin
 * on existing ones, and never satisfies a per-resource check. See permission.ts.
 */
export type Permission = "read" | "write" | "admin" | "create";

/**
 * Every value a grant row's `resource_type` may hold. Wider than the grantable
 * set: the nested leaves are here because a permission tag names them, not
 * because a grant can key on them.
 */
export type ResourceType =
  | "project"
  | "server"
  | "mail_server"
  | "backup_destination"
  | "billing"
  | "audit"
  | "analytics"
  | "github"
  | "azure"
  // GitHub access control is default-deny and owner-granted. "github"
  // (resourceId "*") = all GitHub; "github_installation" (resourceId = the
  // account LOGIN, not an installation id) = every repo under one account;
  // "github_repository" (resourceId = "owner/repo") = a single repo.
  | "github_installation"
  | "github_repository"
  | "permissions"
  | "domain"
  | "settings"
  | "job"
  | "terminal"
  | "cloud"
  | "notifications"
  | "updates"
  | "service"
  | "deployment"
  | "backup_policy"
  | "backup_run"
  | "backup_restore";

/**
 * Types whose only resourceId is "*" — they name a FEATURE, not a row, so a
 * `{type,"*",[verb]}` grant authorizes that whole feature at that verb and
 * below. Consumed by the wildcard arm of `checkPermission`, by the route layer
 * when a paramless tag resolves, and by the picker to render a single row
 * instead of a searchable catalog.
 */
export const ORG_SINGLETON_RESOURCE_TYPES: readonly ResourceType[] = [
  "billing",
  "audit",
  "analytics",
  "github",
  "azure",
  "permissions",
  "settings",
  "job",
  "cloud",
  "terminal",
  "notifications",
  "updates",
];

const ORG_SINGLETON_SET: ReadonlySet<string> = new Set(ORG_SINGLETON_RESOURCE_TYPES);

export function isOrgSingletonResourceType(type: string): boolean {
  return ORG_SINGLETON_SET.has(type);
}

/**
 * The types a user may actually grant, to a member or to a token.
 *
 * Not every enforceable type is here. `permissions` is withheld because granting
 * it lets the grantee widen its own access — the same self-escalation reason the
 * MCP tool layer hard-denies the `tokens` module. `terminal` is withheld because
 * its only routes are WebSocket upgrades, so no grant can produce a usable
 * capability.
 */
export type GrantableResourceType = Extract<
  ResourceType,
  | "project"
  | "server"
  | "mail_server"
  | "backup_destination"
  | "billing"
  | "audit"
  | "github_installation"
  | "github_repository"
  // Platform features. Enforcement for these already worked — the wildcard arm of
  // `checkPermission` authorizes a `{type,"*",[verb]}` grant — but no UI or API
  // could produce the grant, so ~59 MCP tools were reachable only by an unscoped
  // "full account access" binding. There was no middle setting.
  | "job"
  | "notifications"
  | "analytics"
  | "settings"
  | "updates"
  | "cloud"
>;

/**
 * Grantable types in canonical DISPLAY order — resources first (most-used first),
 * then the platform features. Order is load-bearing: the picker's tab strip, the
 * consent screen's offering, and the summary panel's grouping all read it, so one
 * array serves membership AND presentation rather than a second list drifting from
 * the first. Every membership check goes through the derived Set, so callers that
 * only care about "is this grantable" are unaffected by reordering.
 */
export const GRANTABLE_RESOURCE_TYPES: readonly GrantableResourceType[] = [
  "project",
  // Authorized by canUseGitHubRepo, NOT by checkPermission — see github-access.ts.
  "github_installation",
  "github_repository",
  "server",
  "mail_server",
  "backup_destination",
  // Platform features, granted at resourceId "*".
  "job",
  "notifications",
  "analytics",
  "updates",
  "settings",
  "cloud",
  "audit",
  "billing",
];

const GRANTABLE_SET: ReadonlySet<string> = new Set(GRANTABLE_RESOURCE_TYPES);

export function isGrantableResourceType(type: string): type is GrantableResourceType {
  return GRANTABLE_SET.has(type);
}

/**
 * Grantable types that name a row the user picks from a catalog. Rendered as the
 * "Resources" cluster in the picker.
 */
export const RESOURCE_GRANT_TYPES: readonly GrantableResourceType[] =
  GRANTABLE_RESOURCE_TYPES.filter((t) => !isOrgSingletonResourceType(t));

/**
 * Grantable types that name a whole feature. Rendered as the "Platform" cluster,
 * separated from the resource tabs because they have no catalog to search.
 */
export const PLATFORM_GRANT_TYPES: readonly GrantableResourceType[] =
  GRANTABLE_RESOURCE_TYPES.filter((t) => isOrgSingletonResourceType(t));

/**
 * The resource types a deploy-shaped grant needs — a project and the repo it
 * builds from. These lead the tab strip because they are the common case.
 */
export const PRIMARY_GRANT_TYPES: readonly GrantableResourceType[] = [
  "project",
  "github_installation",
  "github_repository",
];

const PRIMARY_SET: ReadonlySet<string> = new Set(PRIMARY_GRANT_TYPES);

/**
 * Resource types that name infrastructure rather than a project or a repo. Held
 * behind an "advanced" affordance: granting one is a broader decision than
 * scoping an agent to a project, and most callers never need it.
 */
export const INFRASTRUCTURE_GRANT_TYPES: readonly GrantableResourceType[] =
  RESOURCE_GRANT_TYPES.filter((t) => !PRIMARY_SET.has(t));

/**
 * Grantable types that carry more blast radius than the verb suggests, and are
 * flagged as such wherever they are offered. `billing` reaches payment state;
 * `audit` reaches every actor's history across the org.
 */
export const SENSITIVE_GRANT_TYPES: readonly GrantableResourceType[] = ["billing", "audit"];

const SENSITIVE_SET: ReadonlySet<string> = new Set(SENSITIVE_GRANT_TYPES);

export function isSensitiveGrantType(type: string): boolean {
  return SENSITIVE_SET.has(type);
}

/**
 * Grantable types whose routes are `localOnly`, so they do not exist on the
 * hosted control plane. Offering them there would be a catalog with nothing in it
 * and tools that always 404.
 */
export const SELF_HOSTED_ONLY_GRANT_TYPES: readonly GrantableResourceType[] = [
  "server",
  "mail_server",
  // The jobs router is `localOnly`, so on the hosted control plane every job route
  // 404s regardless of the grant.
  "job",
];

/** Grantable types that exist only on the hosted control plane. */
export const CLOUD_ONLY_GRANT_TYPES: readonly GrantableResourceType[] = ["billing"];

const SELF_HOSTED_ONLY_SET: ReadonlySet<string> = new Set(SELF_HOSTED_ONLY_GRANT_TYPES);
const CLOUD_ONLY_SET: ReadonlySet<string> = new Set(CLOUD_ONLY_GRANT_TYPES);

export function isSelfHostedOnlyGrantType(type: string): boolean {
  return SELF_HOSTED_ONLY_SET.has(type);
}

export function isCloudOnlyGrantType(type: string): boolean {
  return CLOUD_ONLY_SET.has(type);
}

/**
 * The grantable types that exist in a given deployment mode, in display order.
 * Filters BOTH ways — a type absent from the running mode is a dead tab whose
 * catalog can only ever be empty.
 */
export function grantableTypesForMode(selfHosted: boolean): GrantableResourceType[] {
  return GRANTABLE_RESOURCE_TYPES.filter((t) =>
    selfHosted ? !isCloudOnlyGrantType(t) : !isSelfHostedOnlyGrantType(t),
  );
}

/** Plural label for a picker tab or a summary group heading. */
export const RESOURCE_TYPE_LABELS: Record<GrantableResourceType, string> = {
  project: "Projects",
  server: "Servers",
  mail_server: "Mail servers",
  backup_destination: "Backup destinations",
  billing: "Billing",
  audit: "Audit log",
  github_installation: "GitHub orgs",
  github_repository: "GitHub repos",
  job: "Jobs",
  notifications: "Notifications",
  analytics: "Analytics",
  settings: "Instance settings",
  updates: "Updates",
  cloud: "Cloud",
};

/**
 * Singular label for a single grant chip or summary line. A feature grant has no
 * singular/plural distinction, so those repeat their plural form deliberately —
 * "one Jobs" reads wrong, and the row it labels is the whole feature.
 */
export const RESOURCE_TYPE_LABELS_SINGULAR: Record<GrantableResourceType, string> = {
  project: "Project",
  server: "Server",
  mail_server: "Mail server",
  backup_destination: "Backup destination",
  billing: "Billing",
  audit: "Audit log",
  github_installation: "GitHub org",
  github_repository: "GitHub repo",
  job: "Jobs",
  notifications: "Notifications",
  analytics: "Analytics",
  settings: "Instance settings",
  updates: "Updates",
  cloud: "Cloud",
};

/**
 * What a grant on each platform feature actually reaches, for the picker's
 * one-line description. These name the blast radius, not the route list — a
 * grantee reads this to decide, so vagueness here is a real cost.
 */
export const PLATFORM_GRANT_DESCRIPTIONS: Partial<Record<GrantableResourceType, string>> = {
  job: "Scheduled and on-demand jobs, including commands that run on your servers",
  notifications: "Alert channels and subscriptions",
  analytics: "Usage and resource metrics for projects and services",
  settings: "Instance-wide configuration: build defaults, deploy defaults, transfer",
  updates: "Platform update checks and applying updates",
  cloud: "The cloud control-plane connection",
  audit: "Every action recorded for this organization, by any member",
  billing: "Plan, payment method and invoices",
};
