import type { Dictionary } from "@/i18n";

export type ProjectStatus =
  | "live"
  | "paused"
  | "attention"
  | "queued"
  | "building"
  | "deploying"
  | "reconciling"
  | "migrating"
  | "deploy_failed"
  | "failed"
  | "cancelled"
  | "deleting"
  | "draft";

/**
 * The live migration run for this project, as the project payload carries it (API
 * `readActiveMigration` — an explicit, non-secret allowlist).
 *
 * Present here, in the shared status source, rather than fetched by whichever panel cares:
 * a project being moved to another server is a fact about the PROJECT, so the cards, the
 * sidebar, the page header and the project's own Advanced tab all read it from the payload
 * they already have. The panel that used to ask the migration API on mount learned about a
 * run only when it happened to be mounted, and a reload started that clock over.
 */
export type ActiveMigration = {
  id: string;
  /** A `DockerMigrationStatus`, typed wide because this crosses the API boundary. */
  status: string;
  /** `project_move` (relocating this project) | `project_copy` (building a second one). */
  mode: string;
  /** Server-derived because only the migration service may inspect failure details. */
  needsAction?: boolean;
};

/**
 * Migration statuses where the run has stopped and is WAITING for the operator.
 *
 * These read "Action Required", not "Migrating", and that distinction is the whole reason
 * this set exists: a run parked at `awaiting_cutover` has the target up and the source
 * stopped-but-intact, and it stays there until a human confirms or rolls back — forever, if
 * nobody does. A pill that said "Migrating" for three days while nothing migrated would be
 * the "demands an action it never names" bug this module already documents.
 */
const MIGRATION_AWAITING_OPERATOR = new Set(["awaiting_cutover", "partial"]);

/**
 * Has this project's run stopped and started waiting for a human?
 *
 * Exported so a panel can ask the question without re-listing the statuses. The set stays
 * private: two copies of "which phases are parked" would drift, and the visible symptom would
 * be a card calling a run "in progress" next to a pill that says it needs attention.
 */
export function migrationNeedsOperator(run: ActiveMigration | null | undefined): boolean {
  return Boolean(run && (run.needsAction ?? MIGRATION_AWAITING_OPERATOR.has(run.status)));
}

export type ProjectStatusSource = {
  /** Required only when deriving the status badge's destination. */
  id?: string | null;
  activeDeploymentId?: string | null;
  /**
   * The operator's switch (server-derived from `disabled_at`). False means a human
   * deliberately stopped this project's containers.
   *
   * Undefined is treated as enabled, so a payload that predates the field — or one
   * that legitimately has no such notion — reads exactly as before.
   */
  enabled?: boolean | null;
  /** Status of the LIVE release (the active deployment's own row). Lets a
   *  caller that can't supply `latestDeploymentId` still tell "the newest deploy
   *  IS the live one" from "there's a newer one that didn't land". */
  activeDeploymentStatus?: string | null;
  latestDeploymentId?: string | null;
  latestDeploymentStatus?: string | null;
  /** True when the live release is a partial-failure deploy still awaiting the
   *  operator's keep/reject decision — surfaced as "Action Required", never
   *  "Live". */
  awaitingDecision?: boolean | null;
  /** True when the live release deployed fine but its free .opsh.io edge route
   *  didn't sync — also surfaced as "Action Required", with a Retry routing
   *  action (distinct from the keep/reject decision above). */
  routingUnsynced?: boolean | null;
  /** True when the LATEST deploy is blocked on a named, clearable cause (status
   *  `action_required` — today a port conflict). Unlike the two flags above this
   *  is not a property of the live release: a blocked deploy never becomes the
   *  active one, so nothing derived from the active deployment can see it, which
   *  is why such a deploy used to vanish from the project entirely. */
  latestDeploymentBlocked?: boolean | null;
  deletedAt?: string | null;
  /** True while an atomic teardown is in flight (the real in-progress flag;
   *  teardown hard-deletes on success, so `deletedAt` is rarely set). */
  deletionInProgress?: boolean | null;
  /** Marks the Openship control-plane self-app. It IS the running host service and
   *  has no deployment behind it, so it must never fall through to "draft". */
  appTemplateId?: string | null;
  isApp?: boolean | null;
  hasServer?: boolean | null;
  /** The in-flight migration run for this project, or null/absent when there is none. */
  activeMigration?: ActiveMigration | null;
};

// CSS-only presentation. The human-readable label is resolved from the
// active dictionary via `projectStatusLabel(status, t)` so badges localize.
export const PROJECT_STATUS_META: Record<ProjectStatus, { badge: string }> = {
  live: { badge: "bg-success-bg text-success" },
  // Muted, not amber: a paused project is a state the operator CHOSE, so it must
  // not read as something demanding their attention.
  paused: { badge: "bg-muted text-muted-foreground" },
  attention: { badge: "bg-warning-bg text-warning" },
  queued: { badge: "bg-info-bg text-info" },
  building: { badge: "bg-info-bg text-info" },
  // primary = brand accent, intentionally not a status token.
  deploying: { badge: "bg-primary/10 text-primary" },
  // The deployment outcome is being checked against the host. This is still
  // progressing and does not ask the operator to do anything.
  reconciling: { badge: "bg-info-bg text-info" },
  // Work in progress, like queued/building — NOT amber. A migration the operator started
  // and that is proceeding needs nothing from them; the amber states are the ones that do.
  migrating: { badge: "bg-info-bg text-info" },
  // An older release may still be healthy even though the newest attempt failed.
  // Keep that distinct from both project-wide `failed` and `attention`.
  deploy_failed: { badge: "bg-danger-bg text-danger" },
  failed: { badge: "bg-danger-bg text-danger" },
  cancelled: { badge: "bg-muted text-muted-foreground" },
  deleting: { badge: "bg-danger-bg text-danger" },
  draft: { badge: "bg-warning-bg text-warning" },
};

/** Localized status label for a project/deployment status pill. */
export function projectStatusLabel(status: ProjectStatus, t: Dictionary): string {
  return t.projects.status[status];
}

/**
 * Settled latest-deploy outcomes that do not ask the operator to do anything.
 *
 * An ALLOWLIST, not a denylist: round 1 enumerated the bad statuses and caught
 * the literal "failed" only, so `partial_failure`, `rejected`, `reconciling` —
 * and any status added later — still came back green "Live" over a deploy that
 * never landed. `ready` is a landed deploy; `cancelled` is the operator's own
 * deliberate stop, which needs nothing from them and must not nag forever;
 * `no_changes` found every service already up to date and deliberately kept the
 * live release, so the project is exactly as healthy as before it ran; and a
 * `rejected` partial release was explicitly rolled back by the operator.
 */
const SETTLED_NON_ACTION_STATUSES = new Set(["ready", "cancelled", "rejected", "no_changes"]);

/** Why a project reads "attention". Null when it doesn't. */
export type ProjectAttentionReason =
  /** Live release is a partial failure awaiting the operator's keep/reject. */
  | "decision"
  /** Live release's free .opsh.io edge route didn't sync (Retry routing). */
  | "routing"
  /** Newest deploy is blocked on a named, clearable cause (port conflict). */
  | "blocked"
  /** A migration run is parked waiting for the operator to confirm the cutover or roll
   *  back (or to resolve a partial transfer). Nothing advances until they do. */
  | "migrationCutover";

/**
 * Is the newest deploy the one that is actually serving?
 *
 * `latestDeploymentId` is the direct answer, but not every payload carries it
 * (environment summaries send `activeDeploymentStatus` + `latestDeploymentStatus`
 * only), so fall back to comparing the two statuses: a live release whose own
 * status IS the latest status is the latest release.
 */
function latestDeployIsLive(project: ProjectStatusSource): boolean {
  if (!project.activeDeploymentId) return false;
  if (project.latestDeploymentId) return project.activeDeploymentId === project.latestDeploymentId;
  if (project.activeDeploymentStatus && project.latestDeploymentStatus) {
    return project.activeDeploymentStatus === project.latestDeploymentStatus;
  }
  return false;
}

/**
 * Why this project needs the operator, or null. Exported so a card can EXPLAIN
 * the amber pill instead of demanding an action it doesn't name — see
 * `projectStatusHint`.
 */
export function getProjectAttentionReason(
  project: ProjectStatusSource,
): ProjectAttentionReason | null {
  if (project.appTemplateId === "openship") return null;
  if (project.deletedAt || project.deletionInProgress) return null;
  // Before every deploy-derived reason: a parked migration is about the WORKLOAD's location,
  // and it outranks anything the deployment row has to say — the target's own deploy is
  // `ready` at this point, which is exactly why the run is waiting.
  if (migrationNeedsOperator(project.activeMigration)) return "migrationCutover";
  // In-flight work and an explicit pause both outrank stale flags on the live
  // release. Neither is waiting for input, so neither may manufacture an action.
  if (
    ["queued", "building", "deploying", "reconciling"].includes(
      project.latestDeploymentStatus ?? "",
    )
  ) {
    return null;
  }
  if (project.enabled === false) return null;
  if (project.awaitingDecision) return "decision";
  if (project.routingUnsynced) return "routing";
  if (project.latestDeploymentBlocked) return "blocked";
  if (project.latestDeploymentStatus === "action_required") return "blocked";
  return null;
}

export function getProjectStatus(project: ProjectStatusSource): ProjectStatus {
  if (project.deletedAt || project.deletionInProgress) {
    return "deleting";
  }

  // The Openship control-plane self-app IS the running host process; it has no
  // deployment record, so it must never render as "draft" with a "Deploy now"
  // CTA. If you can see the dashboard, it's live.
  if (project.appTemplateId === "openship") {
    return "live";
  }

  // A migration in flight, ABOVE every arm below it — including `paused` and the deployment
  // switch. During a run none of them describes what is happening: the source containers are
  // stopped (so a live-container reading says "down"), the target's deploy row says
  // "deploying" (true of the copy, not of the project), and a project the operator paused
  // before moving it is still, first and foremost, being moved.
  //
  // Two outcomes, one arm: a run that is PROGRESSING reports progress, and a run that has
  // parked waiting for a human reports "Action Required" — with `projectStatusHint` naming
  // the move, since an amber pill that doesn't say what to do is the bug this module's other
  // attention states already fixed.
  if (project.activeMigration) {
    return migrationNeedsOperator(project.activeMigration) ? "attention" : "migrating";
  }

  switch (project.latestDeploymentStatus) {
    case "queued":
      return "queued";
    case "building":
      return "building";
    case "deploying":
      return "deploying";
    case "reconciling":
      return "reconciling";
    default:
      break;
  }

  // Paused by a human, and nothing is in flight (the switch above already claimed
  // those). Sits above every remaining arm because they all read the deployment
  // ROW, which a pause deliberately does not touch: a project whose containers
  // were stopped on purpose still has a `ready` active deployment, so every card,
  // the sidebar and the home list reported a green "Live" over a project serving
  // nothing.
  //
  // Deliberately NOT "attention" — see PROJECT_STATUS_META.paused.
  if (project.enabled === false) {
    return "paused";
  }

  // Needs the operator: a partial-failure deploy awaiting keep/reject, one whose
  // free-domain edge route didn't sync, or a newer deploy blocked on a named
  // cause. All flag "Action Required" — never the green "Live".
  //
  // Deliberately BEFORE the `activeDeploymentId → live` check below: a project
  // whose last release is serving fine but whose newest deploy is blocked is not
  // simply "Live", or the blocker would be invisible on every card and sidebar.
  if (
    project.awaitingDecision ||
    project.routingUnsynced ||
    project.latestDeploymentBlocked ||
    project.latestDeploymentStatus === "action_required"
  ) {
    return "attention";
  }

  // A LATEST deploy that didn't land cleanly must never render the green "Live".
  // Sits BEFORE the `activeDeploymentId → live` check below, which used to
  // short-circuit every failure arm at the bottom entirely.
  //
  // Allowlist, not denylist (SETTLED_NON_ACTION_STATUSES): checking for the literal
  // "failed" left `partial_failure`, `rejected` and `reconciling` reading green.
  //
  // A plain failed attempt has no pending action, so it must NEVER borrow the
  // "Action Required" label. When an older release is still serving, report the
  // narrower "Deploy failed" state instead. A kept partial release is live; an
  // open one was caught by `awaitingDecision` above.
  const latest = project.latestDeploymentStatus;
  if (latest && !SETTLED_NON_ACTION_STATUSES.has(latest)) {
    if (latestDeployIsLive(project)) {
      // The non-ready latest IS the serving release. `failed` still can't be
      // "live" — nothing that failed is serving — but a kept partial is.
      return latest === "failed" ? "failed" : "live";
    }
    if (project.activeDeploymentId) return "deploy_failed";
    return "failed";
  }

  if (project.activeDeploymentId) {
    return "live";
  }

  switch (project.latestDeploymentStatus) {
    case "cancelled":
    case "rejected":
      return "cancelled";
    default:
      return "draft";
  }
}

/**
 * One localized line explaining an amber "Action Required" pill — the pill's
 * `title`. Every attention state has a real destination; ordinary failed deploys
 * use the separate `deploy_failed` status instead.
 */
export function projectStatusHint(project: ProjectStatusSource, t: Dictionary): string | null {
  if (getProjectStatus(project) !== "attention") return null;
  const p = t.projects;
  switch (getProjectAttentionReason(project)) {
    case "decision":
      return `${p.redeploy.actionRequiredTitle} — ${p.redeploy.reviewDeployment}`;
    case "routing":
      return `${p.routingRetry.title} — ${p.routingRetry.retry}`;
    case "blocked":
      return `${p.draft.headingFailed} — ${p.redeploy.reviewDeployment}`;
    // Its own sentence rather than a compose of two halves: unlike the deploy states above,
    // neither half of "a parked migration and what to do about it" existed anywhere to reuse.
    case "migrationCutover":
      return p.migrationAwaitingHint;
    default:
      return null;
  }
}

/**
 * Exact owner of a genuine "Action Required" badge.
 *
 * A badge without a destination is not actionable. Keep this next to the status
 * derivation so every renderer (list, grid, home and project sidebar) shares the
 * same routing contract instead of guessing from the label.
 */
export function projectActionHref(project: ProjectStatusSource): string | null {
  if (!project.id || getProjectStatus(project) !== "attention") return null;

  switch (getProjectAttentionReason(project)) {
    case "decision":
      return project.activeDeploymentId
        ? `/build/${project.activeDeploymentId}`
        : `/projects/${project.id}/deployments`;
    case "routing":
      return `/projects/${project.id}/domains`;
    case "blocked":
      return `/projects/${project.id}/deployments`;
    case "migrationCutover":
      return `/projects/${project.id}/advanced`;
    default:
      return null;
  }
}

/** Destination for a status that has useful detail even when it needs no action. */
export function projectStatusHref(project: ProjectStatusSource): string | null {
  const actionHref = projectActionHref(project);
  if (actionHref) return actionHref;
  if (!project.id) return null;

  switch (getProjectStatus(project)) {
    case "queued":
    case "building":
    case "deploying":
    case "reconciling":
    case "deploy_failed":
    case "failed":
      return project.latestDeploymentId
        ? `/build/${project.latestDeploymentId}`
        : `/projects/${project.id}/deployments`;
    case "migrating":
      return `/projects/${project.id}/advanced`;
    default:
      return null;
  }
}

/**
 * The hostname a project card / sidebar is allowed to print.
 *
 * ONLY a persisted route. This used to fall back to `<slug>.<baseDomain>`, which
 * meant every project with no route at all advertised a free subdomain that had
 * never been created: the Apps list read "convex.opsh.io" while that project's
 * own Domains page correctly read "No domain". A route exists because a human
 * chose it and it was persisted — never because a card could compose one.
 */
export function projectDisplayDomain(project: { primaryDomain?: string | null }): string | null {
  return project.primaryDomain?.trim() || null;
}
